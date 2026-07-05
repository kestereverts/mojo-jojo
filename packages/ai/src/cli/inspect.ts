import type { ModelMessage } from "ai";
import type { ContextEvent, TurnContext } from "../context/events.ts";
import type { ExchangeStep } from "../exchange.ts";
import { resolveEmbeddingModel, resolveModel, type ModelRoles } from "../models.ts";
import type { ChatOutcome, HarnessError } from "./harness.ts";

/**
 * The machine-readable inspection of one exchange — the stable shape `--json`
 * emits and agents assert on. Every layer the milestone touches is surfaced
 * here so verification never needs ad-hoc scripts:
 * turns/steps, the rendered prompt, durable history, ephemeral turn context,
 * token usage (total + per step), timing (wall + per step), and captured errors.
 */
export interface Inspection {
  readonly reply: string;
  readonly replyLines: string[];
  readonly finishReason: string | null;
  readonly error: HarnessError | null;
  readonly usage: TokenUsage | null;
  readonly timing: Timing | null;
  readonly steps: StepInspection[];
  /** The projection (`renderPrompt` output) that was sent to the model. */
  readonly prompt: ModelMessage[];
  /** Ephemeral context rendered this turn but never appended to the log. */
  readonly ephemera: TurnContext;
  /** Durable events backing the projection. */
  readonly history: readonly ContextEvent[];
  /** Per-role model specs and whether each resolves (M2's CLI-verifiable surface). Absent unless requested. */
  readonly modelRoles: ModelRoleStatus[] | null;
}

/** One role's configured spec and whether it constructs a model without throwing (no network call). */
export interface ModelRoleStatus {
  readonly role: keyof ModelRoles;
  readonly spec: string;
  readonly ok: boolean;
  readonly error: string | null;
}

/**
 * Attempt to resolve every configured role, without making any network call
 * (`resolveModel`/`resolveEmbeddingModel` only construct a client). Lets `chat`/
 * `repl` show which occasion maps to which model, and catch a typo'd provider
 * or model id before it would fail mid-exchange.
 */
export function describeModelRoles(models: ModelRoles): ModelRoleStatus[] {
  return (Object.keys(models) as (keyof ModelRoles)[]).map((role) => {
    const spec = models[role];
    try {
      if (role === "embedding") resolveEmbeddingModel(spec);
      else resolveModel(spec);
      return { role, spec, ok: true, error: null };
    } catch (cause) {
      return { role, spec, ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });
}

interface TokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

interface Timing {
  readonly wallMs: number;
  readonly steps: { index: number; stepTimeMs: number; responseTimeMs: number }[];
}

interface StepInspection {
  readonly index: number;
  readonly finishReason: string;
  readonly text: string;
  readonly toolCalls: { toolName: string; input: unknown; output: unknown; error: string | null }[];
}

export function buildInspection(
  outcome: ChatOutcome,
  extra: { modelRoles?: ModelRoleStatus[] } = {},
): Inspection {
  const { result } = outcome;
  return {
    reply: outcome.reply,
    replyLines: outcome.replyLines,
    finishReason: result?.finishReason ?? null,
    error: outcome.error ?? null,
    usage: result ? tokenUsage(result.usage) : null,
    timing: result
      ? {
          wallMs: round(result.wallMs),
          steps: result.steps.map((s) => ({
            index: s.index,
            stepTimeMs: round(s.stepTimeMs),
            responseTimeMs: round(s.responseTimeMs),
          })),
        }
      : null,
    steps: (result?.steps ?? []).map(inspectStep),
    prompt: result?.prompt ?? [],
    ephemera: outcome.turn,
    history: outcome.history,
    modelRoles: extra.modelRoles ?? null,
  };
}

export function formatJson(outcome: ChatOutcome, extra: { modelRoles?: ModelRoleStatus[] } = {}): string {
  return JSON.stringify(buildInspection(outcome, extra), null, 2);
}

/**
 * Human-readable rendering. The compact form (default) is a reply + usage +
 * timing + tool-call summary; `verbose` additionally dumps the rendered prompt,
 * ephemeral turn context, and durable history.
 */
export function formatHuman(
  outcome: ChatOutcome,
  opts: { verbose?: boolean; modelRoles?: ModelRoleStatus[] } = {},
): string {
  const i = buildInspection(outcome, { modelRoles: opts.modelRoles });
  const out: string[] = [];

  if (i.modelRoles) {
    out.push(section("MODELS", i.modelRoles.map(modelRoleLine).join("\n")));
  }

  if (i.error) {
    out.push(section("ERROR", errorLine(i.error)));
  }

  out.push(section("REPLY", i.reply || "(no reply)"));

  if (i.usage) {
    out.push(
      section(
        "USAGE",
        `input=${fmt(i.usage.inputTokens)} output=${fmt(i.usage.outputTokens)} total=${fmt(i.usage.totalTokens)}`,
      ),
    );
  }

  if (i.timing) {
    const perStep = i.timing.steps
      .map((s) => `  step ${s.index}: ${s.stepTimeMs}ms (model ${s.responseTimeMs}ms)`)
      .join("\n");
    out.push(section("TIMING", `wall ${i.timing.wallMs}ms${perStep ? `\n${perStep}` : ""}`));
  }

  if (i.steps.length > 0) {
    const stepLines = i.steps.map((s) => {
      const calls =
        s.toolCalls.length === 0
          ? "  (no tool calls)"
          : s.toolCalls
              .map((c) => {
                const result = c.error !== null ? ` ✗ ${c.error}` : ` = ${compact(c.output)}`;
                return `  → ${c.toolName}(${compact(c.input)})${result}`;
              })
              .join("\n");
      return `step ${s.index} [${s.finishReason}]\n${calls}`;
    });
    out.push(section("STEPS", stepLines.join("\n")));
  }

  if (opts.verbose) {
    out.push(section("PROMPT", i.prompt.map((m) => `[${m.role}] ${compact(m.content)}`).join("\n")));
    out.push(section("EPHEMERA", compact(i.ephemera)));
    out.push(
      section(
        "HISTORY",
        i.history.map((e) => `[${e.kind}] ${compact(e)}`).join("\n") || "(empty)",
      ),
    );
  }

  return out.join("\n\n");
}

function inspectStep(step: ExchangeStep): StepInspection {
  return {
    index: step.index,
    finishReason: step.finishReason,
    text: step.text,
    toolCalls: step.toolCalls.map((c) => ({
      toolName: c.toolName,
      input: c.input,
      output: c.output ?? null,
      // Errors are often `Error` instances (JSON.stringify → "{}"), so render a message.
      error: c.error === undefined ? null : errorText(c.error),
    })),
  };
}

/** A one-line human-readable message for a thrown tool error. */
function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function tokenUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): TokenUsage {
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
  };
}

/** Shared with `repl.ts` (banner + `/models`) so the two surfaces render identically. */
export function modelRoleLine(m: ModelRoleStatus): string {
  return m.ok ? `${m.role}: ${m.spec}` : `${m.role}: ${m.spec} ✗ ${m.error}`;
}

function errorLine(e: HarnessError): string {
  const status = e.statusCode !== undefined ? ` [${e.statusCode}]` : "";
  const url = e.url ? ` (${e.url})` : "";
  return `${e.name}${status}: ${e.message}${url}`;
}

function section(title: string, body: string): string {
  return `━━ ${title} ━━\n${body}`;
}

function fmt(n: number | null): string {
  return n === null ? "?" : String(n);
}

function round(ms: number): number {
  return Math.round(ms);
}

/** One-line JSON for a value, truncated so debug output stays scannable. */
function compact(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}
