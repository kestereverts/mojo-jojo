import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ToolSet } from "ai";
import type { Friend } from "../identity/speakers.ts";
import type { ModelRoles } from "../models.ts";
import type { PromptSection } from "../prompt/sections.ts";
import { DebugHarness, parseContextEvents, type ChatOptions } from "./harness.ts";
import { formatHuman, modelRoleLine, type ModelRoleStatus } from "./inspect.ts";

export interface ReplOptions extends ChatOptions {
  readonly model: string;
  /** Full model-role mapping — see `HarnessConfig.models`'s doc (needed only when `tools` is omitted; harmless to pass alongside an explicit `tools` override too). */
  readonly models?: ModelRoles;
  readonly maxSteps?: number;
  readonly replyLines?: number;
  readonly historyLimit?: number;
  readonly verbose?: boolean;
  /** Resolved once at startup by the CLI entry; shown in the banner and via `/models`. */
  readonly modelRoles?: ModelRoleStatus[];
  /** Known people for identity resolution, loaded once at startup (see `identity/speakers.ts`). */
  readonly friends?: readonly Friend[];
  /** The (config-`disabled`-filtered) tool registry — paired with `toolGuidance`/`durableToolNames`/`subagentToolNames`; see `DebugHarness`'s `tools` doc. */
  readonly tools?: ToolSet;
  readonly toolGuidance?: readonly PromptSection[];
  readonly durableToolNames?: ReadonlySet<string>;
  readonly subagentToolNames?: ReadonlySet<string>;
}

const HELP = `Commands:
  <text>            send a message through the exchange
  /inject <json>    append an event (JSON object or array) to the log
  /dump             print the durable history as JSON
  /tokens           print cumulative token usage this session
  /models           print the resolved role→model mapping
  /reset            clear the conversation log
  /help             show this help
  /exit             quit`;

/**
 * Interactive REPL over a single {@link DebugHarness}. State (the ContextLog and
 * cumulative token totals) persists across turns for the life of the process —
 * no DB needed. Every message runs the same pipeline `chat` uses.
 */
export async function runRepl(options: ReplOptions): Promise<void> {
  let harness = newHarness(options);
  const totals = { input: 0, output: 0, total: 0 };
  // Async iteration (not `question`) so the loop drains piped input in order and
  // ends cleanly on EOF instead of throwing "readline was closed".
  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "» " });
  // Only decorate interactively; piped stdout stays clean for parsing.
  const interactive = stdout.isTTY === true;
  const prompt = () => {
    if (interactive) rl.prompt();
  };

  if (interactive) {
    stdout.write(`mojo-ai debug repl — model ${options.model}. /help for commands.\n`);
    if (options.modelRoles) stdout.write(`${options.modelRoles.map(modelRoleLine).join("\n")}\n`);
  }
  prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (line.length === 0) {
      prompt();
      continue;
    }

    if (line.startsWith("/")) {
      const cmd = line.slice(1).split(/\s+/, 1)[0] ?? "";
      const arg = line.slice(1 + cmd.length).trim();
      if (cmd === "exit" || cmd === "quit") break;
      else if (cmd === "help") stdout.write(`${HELP}\n`);
      else if (cmd === "reset") {
        harness = newHarness(options);
        stdout.write("(log cleared)\n");
      } else if (cmd === "dump") {
        stdout.write(`${JSON.stringify(harness.log.events(), null, 2)}\n`);
      } else if (cmd === "tokens") {
        stdout.write(`input=${totals.input} output=${totals.output} total=${totals.total}\n`);
      } else if (cmd === "models") {
        stdout.write(
          options.modelRoles ? `${options.modelRoles.map(modelRoleLine).join("\n")}\n` : "(no roles resolved)\n",
        );
      } else if (cmd === "inject") {
        injectFrom(harness, arg);
      } else {
        stdout.write(`unknown command: /${cmd} (/help)\n`);
      }
      prompt();
      continue;
    }

    const outcome = await harness.chat(line, options);
    if (outcome.result) {
      totals.input += outcome.result.usage.inputTokens ?? 0;
      totals.output += outcome.result.usage.outputTokens ?? 0;
      totals.total += outcome.result.usage.totalTokens ?? 0;
    }
    stdout.write(`${formatHuman(outcome, { verbose: options.verbose })}\n\n`);
    prompt();
  }

  rl.close();
}

function newHarness(options: ReplOptions): DebugHarness {
  return new DebugHarness({
    model: options.model,
    models: options.models,
    maxSteps: options.maxSteps,
    replyLines: options.replyLines,
    historyLimit: options.historyLimit,
    friends: options.friends,
    tools: options.tools,
    toolGuidance: options.toolGuidance,
    durableToolNames: options.durableToolNames,
    subagentToolNames: options.subagentToolNames,
  });
}

function injectFrom(harness: DebugHarness, json: string): void {
  if (!json) {
    stdout.write("usage: /inject <json object or array>\n");
    return;
  }
  try {
    for (const event of parseContextEvents(JSON.parse(json))) harness.inject(event);
    stdout.write("(injected)\n");
  } catch (cause) {
    stdout.write(`inject failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  }
}
