#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { stderr, stdout } from "node:process";
import { DebugHarness, parseContextEvents } from "./harness.ts";
import { formatHuman, formatJson } from "./inspect.ts";
import { runRepl } from "./repl.ts";

const DEFAULT_MODEL = "openai/gpt-5.4-mini";

const USAGE = `mojo-ai-debug — headless driver for the mojo-ai exchange core.

Usage:
  mojo-ai-debug chat "<message>" [options]
  mojo-ai-debug repl [options]

Options:
  --as <nick>            speaker nick (default "you")
  --account <name>       speaker services account
  --conversation <id>    conversation label (default "debug")
  --model <spec>         provider/model-id (default from --config or ${DEFAULT_MODEL})
  --max-steps <n>        tool-loop iteration cap
  --inject <file>        JSON file of event(s) to stage before the message
  --config <file>        read model/settings from a config.toml [modules.mojo-ai] slice
  --json                 emit machine-readable inspection
  --verbose              include rendered prompt, ephemera, and history
  -h, --help             show this help

Deferred (recognized, wired in later milestones):
  --via <relay>          relay unwrapping — lands in M3
  --db <path>            SQLite persistence — lands in M8`;

interface CliConfig {
  model?: string;
  maxSteps?: number;
  replyLines?: number;
}

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
  if (values.via !== undefined) stderr.write("note: --via is recognized but not wired until M3.\n");
  if (values.db !== undefined) stderr.write("note: --db is recognized but not wired until M8.\n");

  // Config load + flag validation raise UsageError → a clean exit 2 (not the
  // bin-level fatal-stack path). Exchange/network failures are handled inside
  // the harness (captured in the outcome, exit 1).
  try {
    const cliConfig = values.config ? await loadCliConfig(values.config) : {};
    const model = values.model ?? cliConfig.model ?? DEFAULT_MODEL;
    const maxSteps =
      values["max-steps"] !== undefined
        ? parsePositiveInt(values["max-steps"], "--max-steps")
        : cliConfig.maxSteps;

    if (command === "chat") {
      const message = rest.join(" ").trim();
      if (!message) {
        stderr.write(`chat needs a message.\n\n${USAGE}\n`);
        return 2;
      }
      const harness = new DebugHarness({ model, maxSteps, replyLines: cliConfig.replyLines });
      if (values.inject) {
        for (const event of await readInjectFile(values.inject)) harness.inject(event);
      }
      const outcome = await harness.chat(message, {
        as: values.as,
        account: values.account,
        conversation: values.conversation,
      });
      stdout.write(`${values.json ? formatJson(outcome) : formatHuman(outcome, { verbose: values.verbose })}\n`);
      return outcome.error ? 1 : 0;
    }

    if (command === "repl") {
      await runRepl({
        model,
        maxSteps,
        replyLines: cliConfig.replyLines,
        as: values.as,
        account: values.account,
        conversation: values.conversation,
        verbose: values.verbose,
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

async function loadCliConfig(path: string): Promise<CliConfig> {
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
  if (typeof slice !== "object" || slice === null) return {};
  const s = slice as Record<string, unknown>;
  // Same bounds the module's Validator enforces, so CLI and live agree.
  return {
    model: typeof s.model === "string" ? s.model : undefined,
    maxSteps: intInRange(s.maxSteps, "modules.mojo-ai.maxSteps", 1, 32),
    replyLines: intInRange(s.replyLines, "modules.mojo-ai.replyLines", 1, 10),
  };
}

function intInRange(value: unknown, path: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`${path} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`);
  }
  return value;
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
