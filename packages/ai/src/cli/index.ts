#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { stderr, stdout } from "node:process";
import { resolve as pathResolve } from "node:path";
import { ConfigError } from "@mojo-jojo/bot";
import { mojoAiModule } from "../mojo-ai.ts";
import { loadFriendsFile, type Friend } from "../identity/speakers.ts";
import { DebugHarness, parseContextEvents } from "./harness.ts";
import { describeModelRoles, formatHuman, formatJson } from "./inspect.ts";
import { runRepl } from "./repl.ts";

const USAGE = `mojo-ai-debug — headless driver for the mojo-ai exchange core.

Usage:
  mojo-ai-debug chat "<message>" [options]
  mojo-ai-debug repl [options]

Options:
  --as <name>            speaker identity: a nick, or (with --via) the
                          relay-unwrapped author name (default "you")
  --account <name>       speaker services account (ignored when --via is set)
  --via <relay>          simulate a message relayed through this bridge bot's
                          nick (e.g. "Telegram") — --as becomes the author
  --friends <file>       friends.toml for identity resolution (defaults to
                          --config's friendsFile, if either is set)
  --conversation <id>    conversation label (default "debug")
  --model <spec>         provider/model-id — overrides the "chat" role (see --config)
  --max-steps <n>        tool-loop iteration cap
  --inject <file>        JSON file of event(s) to stage before the message
  --config <file>        read [modules.mojo-ai] through the SAME parseConfig the
                          live module uses, so CLI and live never disagree
  --json                 emit machine-readable inspection
  --verbose              include rendered prompt, ephemera, and history
  -h, --help             show this help

Deferred (recognized, wired in later milestones):
  --db <path>            SQLite persistence — lands in M8`;

/** The module's own config type, imported structurally (the type isn't exported). */
type MojoAiConfig = ReturnType<NonNullable<ReturnType<typeof mojoAiModule>["parseConfig"]>>;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        as: { type: "string" },
        account: { type: "string" },
        conversation: { type: "string" },
        model: { type: "string" },
        "max-steps": { type: "string" },
        inject: { type: "string" },
        config: { type: "string" },
        friends: { type: "string" },
        json: { type: "boolean" },
        verbose: { type: "boolean" },
        via: { type: "string" },
        db: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (cause) {
    stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n\n${USAGE}\n`);
    return 2;
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.help || command === undefined || command === "help") {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  // Deferred flags: honest notice rather than silent no-op.
  if (values.db !== undefined) stderr.write("note: --db is recognized but not wired until M8.\n");

  // Config load + flag validation raise UsageError → a clean exit 2 (not the
  // bin-level fatal-stack path). Exchange/network failures are handled inside
  // the harness (captured in the outcome, exit 1).
  try {
    const cliConfig = await loadCliConfig(values.config);
    const friends = await loadCliFriends(values.friends ?? cliConfig.friendsFile);
    const model = values.model ?? cliConfig.models.chat;
    const maxSteps =
      values["max-steps"] !== undefined
        ? parsePositiveInt(values["max-steps"], "--max-steps")
        : cliConfig.maxSteps;
    // Resolved once per invocation: which model each configured role maps to,
    // and whether it constructs without throwing (no network call) — M2's
    // CLI-verifiable surface. --model overrides only chat's displayed spec
    // here; classifier/summarizer/research that fell back to chat at parse
    // time still show that original value, NOT the override — a state no
    // real config can produce today (those roles always track the parsed
    // chat). Harmless since only chat is consumed by any exchange, but if a
    // later milestone starts consuming a fallback role, this display should
    // be revisited so it can't misrepresent what will actually run.
    const modelRoles = describeModelRoles({ ...cliConfig.models, chat: model });

    if (command === "chat") {
      const message = rest.join(" ").trim();
      if (!message) {
        stderr.write(`chat needs a message.\n\n${USAGE}\n`);
        return 2;
      }
      const harness = new DebugHarness({
        model,
        maxSteps,
        replyLines: cliConfig.replyLines,
        historyLimit: cliConfig.historyLimit,
        friends,
      });
      if (values.inject) {
        for (const event of await readInjectFile(values.inject)) harness.inject(event);
      }
      const outcome = await harness.chat(message, {
        as: values.as,
        account: values.account,
        via: values.via,
        conversation: values.conversation,
      });
      stdout.write(
        `${
          values.json
            ? formatJson(outcome, { modelRoles })
            : formatHuman(outcome, { verbose: values.verbose, modelRoles })
        }\n`,
      );
      return outcome.error ? 1 : 0;
    }

    if (command === "repl") {
      await runRepl({
        model,
        maxSteps,
        replyLines: cliConfig.replyLines,
        historyLimit: cliConfig.historyLimit,
        friends,
        as: values.as,
        account: values.account,
        via: values.via,
        conversation: values.conversation,
        verbose: values.verbose,
        modelRoles,
      });
      return 0;
    }

    if (command === "inject") {
      stderr.write(
        "inject as a standalone command needs --db to persist (lands in M8).\n" +
          "For now use `chat --inject <file>` or the repl `/inject` command.\n",
      );
      return 2;
    }

    stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
    return 2;
  } catch (cause) {
    if (cause instanceof UsageError) {
      stderr.write(`${cause.message}\n`);
      return 2;
    }
    throw cause;
  }
}

/** A user-input error (bad flag, unreadable/invalid config or inject file) → exit 2. */
class UsageError extends Error {}

async function readInjectFile(path: string) {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    throw new UsageError(`--inject: cannot read file "${path}"`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new UsageError(`--inject: invalid JSON in "${path}": ${errMsg(cause)}`);
  }
  try {
    return parseContextEvents(raw);
  } catch (cause) {
    throw new UsageError(`--inject: ${errMsg(cause)}`);
  }
}

/**
 * Read `[modules.mojo-ai]` from a config.toml and parse it through the SAME
 * `parseConfig` the live module uses (not a hand-rolled reimplementation) —
 * CLI and live can never silently disagree on defaults, bounds, or role
 * fallback. `path` absent → parse an empty slice (all defaults).
 */
/**
 * Load `friends.toml` for the CLI: `--friends` wins over `--config`'s
 * `friendsFile` (same precedence as `--model` over `models.chat`). Absent
 * both → no friends, no error (matches the module's own optional-file stance).
 * Warnings (missing/invalid file, malformed entries) print to stderr rather
 * than failing the run — friends data is enrichment, not required config.
 */
async function loadCliFriends(path: string | undefined): Promise<readonly Friend[]> {
  if (!path) return [];
  const resolved = pathResolve(path);
  const { friends, warnings } = await loadFriendsFile(resolved);
  for (const warning of warnings) stderr.write(`note: friends file: ${warning}\n`);
  return friends;
}

async function loadCliConfig(path: string | undefined): Promise<MojoAiConfig> {
  const parseConfig = mojoAiModule().parseConfig;
  if (!parseConfig) throw new Error("mojoAiModule() has no parseConfig — this is a bug");
  if (!path) return parseConfig({});

  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    throw new UsageError(`--config: cannot read file "${path}"`);
  }
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (cause) {
    throw new UsageError(`--config: invalid TOML in "${path}": ${errMsg(cause)}`);
  }
  const modules = (raw as { modules?: Record<string, unknown> }).modules;
  const slice = modules?.["mojo-ai"];
  // Mirror the live bot's own module-table validation (Validator.optRecord):
  // absent → not configured (defaults); present-but-not-a-table → a config
  // error, not a silent empty slice (an actual "modules.mojo-ai = 42" would
  // fail to load live, so the CLI must fail the same way).
  if (slice !== undefined && (typeof slice !== "object" || slice === null)) {
    throw new UsageError(`--config: modules.mojo-ai: expected a table, got ${JSON.stringify(slice)}`);
  }
  const sliceObj = (slice as Record<string, unknown> | undefined) ?? {};
  try {
    return parseConfig(sliceObj);
  } catch (cause) {
    if (cause instanceof ConfigError) throw new UsageError(`--config: ${cause.message}`);
    throw cause;
  }
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive integer, got "${value}"`);
  return n;
}

function errMsg(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Entry point when run directly (bun run / bin), not when imported by tests.
if (import.meta.main) {
  main(Bun.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
