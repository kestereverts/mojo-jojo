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

  const cliConfig = values.config ? await loadCliConfig(values.config) : {};
  const model = values.model ?? cliConfig.model ?? DEFAULT_MODEL;
  const maxSteps = values["max-steps"] ? parsePositiveInt(values["max-steps"], "--max-steps") : cliConfig.maxSteps;

  if (command === "chat") {
    const message = rest.join(" ").trim();
    if (!message) {
      stderr.write(`chat needs a message.\n\n${USAGE}\n`);
      return 2;
    }
    const harness = new DebugHarness({ model, maxSteps, replyLines: cliConfig.replyLines });
    if (values.inject) {
      const raw: unknown = JSON.parse(await Bun.file(values.inject).text());
      for (const event of parseContextEvents(raw)) harness.inject(event);
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
}

async function loadCliConfig(path: string): Promise<CliConfig> {
  const raw: unknown = Bun.TOML.parse(await Bun.file(path).text());
  const modules = (raw as { modules?: Record<string, unknown> }).modules;
  const slice = modules?.["mojo-ai"];
  if (typeof slice !== "object" || slice === null) return {};
  const s = slice as Record<string, unknown>;
  return {
    model: typeof s.model === "string" ? s.model : undefined,
    maxSteps: typeof s.maxSteps === "number" ? s.maxSteps : undefined,
    replyLines: typeof s.replyLines === "number" ? s.replyLines : undefined,
  };
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got "${value}"`);
  return n;
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
