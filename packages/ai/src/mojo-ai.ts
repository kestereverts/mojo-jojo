import * as path from "node:path";
import type { Database } from "bun:sqlite";
import { EMPTY, catchError, defer, exhaustMap, filter, groupBy, map, mergeMap, tap } from "rxjs";
import {
  Validator,
  defineModule,
  replyTarget,
  resolveAccount,
  safeSay,
  type Module,
  type ModuleContext,
} from "@mojo-jojo/bot";
import type { PrivmsgEvent } from "@mojo-jojo/irc-client";
import { InMemoryContextLog, type ContextLog } from "./context/log.ts";
import { openContextDb, SqliteContextLog } from "./context/sqlite-log.ts";
import { maybeCompact, type CompactionConfig } from "./context/compaction.ts";
import { recordDurableTranscripts, recordSubagentBriefings } from "./exchange.ts";
import { toReplyLines } from "./reply.ts";
import { buildToolSet, defaultToolDefinitions } from "./tools/index.ts";
import { resolveEmbeddingModel, type ModelRoles } from "./models.ts";
import { runChatMiddleware, type ChatMessage, type ChatMiddleware } from "./identity/middleware.ts";
import { createRelayMiddleware, parseRelays, type RelayDefinition } from "./identity/relay.ts";
import { loadFriendsFile, resolveSpeaker, type Friend } from "./identity/speakers.ts";
import { assembleInstructions } from "./prompt/sections.ts";
import { buildDefaultSections, leakDetectionSections } from "./prompt/instructions.ts";
import { createLeakDetector, type LeakDetector } from "./guards/leak-detector.ts";
import { runGuardedExchange, type GuardConfig, type GuardExplain } from "./guards/pipeline.ts";

const DEFAULT_CHAT_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";

interface MojoAiConfig {
  /**
   * `"provider/model-id"` specs per occasion (see {@link ModelRoles}). Only
   * `chat` is consumed today (the main exchange); `classifier`/`summarizer`/
   * `research`/`embedding` are resolved and validated now so later milestones
   * (M6-M8) have them ready, and so `mojo-ai-debug` can show the full mapping.
   * Keys come from GEMINI_API_KEY / OPENAI_API_KEY.
   */
  readonly models: ModelRoles;
  /** Per-conversation memory window (context events). */
  readonly historyLimit: number;
  /** Tool-loop iteration bound per exchange. */
  readonly maxSteps: number;
  /** Max IRC lines per reply; the rest is dropped. */
  readonly replyLines: number;
  /** Configured relay/bridge bots this instance should unwrap (see `identity/relay.ts`). */
  readonly relays: readonly RelayDefinition[];
  /**
   * Path to `friends.toml` (real-person data — gitignored, never committed).
   * Cwd-relative (there is no `configDir` seam from `Module.parseConfig` today —
   * see AGENTS.md); resolved and logged at setup so a wrong-cwd run is loud,
   * not silently missing known-user data.
   */
  readonly friendsFile?: string;
  /** Tool names to exclude from the registry entirely — no entry, no guidance, never durable. */
  readonly toolsDisabled: readonly string[];
  /** Which M7 guards run; all default on. Every guard fails open on its own error — never blocks, just logs loudly. */
  readonly guards: GuardConfig;
  /** SQLite file for durable, cross-restart conversation memory. Absent → in-memory only (lost on restart). Cwd-relative, same caveat as `friendsFile` (no `configDir` seam — see AGENTS.md). */
  readonly dbPath?: string;
  /** M8 context compaction — folds old events into a running summary so a conversation's rendered prompt doesn't grow without bound. */
  readonly compaction: CompactionConfig;
}

/** `[modules.mojo-ai.guards]` — every guard defaults to enabled. */
function parseGuardConfig(v: Validator, raw: Record<string, unknown>): GuardConfig {
  const guardsRaw = v.optRecord(raw.guards, "modules.mojo-ai.guards") ?? {};
  return {
    promptGuard: v.optBoolean(guardsRaw.promptGuard, "modules.mojo-ai.guards.promptGuard") ?? true,
    leakDetector: v.optBoolean(guardsRaw.leakDetector, "modules.mojo-ai.guards.leakDetector") ?? true,
    grounding: v.optBoolean(guardsRaw.grounding, "modules.mojo-ai.guards.grounding") ?? true,
  };
}

/** `[modules.mojo-ai.compaction]` — on by default; `keepTail` must stay below `triggerEvents` or there'd be nothing left to compact. */
function parseCompactionConfig(v: Validator, raw: Record<string, unknown>): CompactionConfig {
  const compactionRaw = v.optRecord(raw.compaction, "modules.mojo-ai.compaction") ?? {};
  const enabled = v.optBoolean(compactionRaw.enabled, "modules.mojo-ai.compaction.enabled") ?? true;
  const triggerEvents = v.optIntegerInRange(compactionRaw.triggerEvents, "modules.mojo-ai.compaction.triggerEvents", 2, 100_000) ?? 240;
  const keepTail = v.optIntegerInRange(compactionRaw.keepTail, "modules.mojo-ai.compaction.keepTail", 1, 100_000) ?? 60;
  if (keepTail >= triggerEvents) {
    v.fail("modules.mojo-ai.compaction.keepTail", `must be less than triggerEvents (${keepTail} >= ${triggerEvents})`);
  }
  return { enabled, triggerEvents, keepTail };
}

/**
 * Resolve `[modules.mojo-ai.models]` plus the legacy top-level `model` key
 * (now an alias for `models.chat`) into a full {@link ModelRoles}. Unset roles
 * default to the resolved `chat` model — one strong model unless the operator
 * opts specific occasions into something cheaper/different.
 */
function parseModelRoles(v: Validator, raw: Record<string, unknown>): ModelRoles {
  const models = v.optRecord(raw.models, "modules.mojo-ai.models") ?? {};
  const legacyModel = v.optNonEmptyString(raw.model, "modules.mojo-ai.model");
  const chat =
    v.optNonEmptyString(models.chat, "modules.mojo-ai.models.chat") ?? legacyModel ?? DEFAULT_CHAT_MODEL;
  const role = (key: string): string =>
    v.optNonEmptyString(models[key], `modules.mojo-ai.models.${key}`) ?? chat;
  return {
    chat,
    classifier: role("classifier"),
    summarizer: role("summarizer"),
    research: role("research"),
    embedding:
      v.optNonEmptyString(models.embedding, "modules.mojo-ai.models.embedding") ?? DEFAULT_EMBEDDING_MODEL,
  };
}

/** Bound on tracked conversations, so a channel-flood can't grow memory forever. */
const MAX_CONVERSATIONS = 100;

/**
 * The AI brain: each channel gets an event-sourced context log, and a message
 * addressing the bot ("mojo: …") runs one agentic exchange over that log.
 *
 * Privacy stance: the bot only "sees" lines that address it — unaddressed
 * channel chatter is never recorded or sent to the model, and PMs are ignored
 * outright.
 *
 * Identity: Mojo lives in a relay channel (IRC + Telegram/Discord bridges), so
 * every channel PRIVMSG runs through a {@link ChatMiddleware} chain BEFORE the
 * addressing gate — relay unwrapping must see a message's real author/text
 * before "does this address the bot" is even checked, since a bridged
 * `<alice> mojo: hi` arrives as the relay bot's own PRIVMSG. Speaker identity
 * is then finalized (trust tier + friends-file match) right before a message
 * is persisted — see `identity/speakers.ts`'s `resolveSpeaker`.
 *
 * RxJS owns turn orchestration (per-conversation serialization via
 * groupBy+exhaustMap, cancellation via the disposal AbortController); the
 * exchange itself is a plain async tool loop in `runExchange`.
 */
export function mojoAiModule(): Module<MojoAiConfig> {
  return defineModule<MojoAiConfig>({
    name: "mojo-ai",
    description: "LLM chat brain (Vercel AI SDK).",
    parseConfig(raw) {
      const v = new Validator();
      const models = parseModelRoles(v, raw);
      // Default raised from 200 (M1, before compaction existed) to 400 —
      // review finding: the hard hi trim on every append runs BEFORE
      // maybeCompact ever sees the log, so a historyLimit at or below
      // compaction.triggerEvents (240 by default) makes compaction silently
      // inert — the log is always trimmed back down before it ever crosses
      // the trigger threshold. 400 leaves comfortable room above the
      // trigger default. See the cross-field check below for a MISconfigured
      // combination (a custom historyLimit still at or below triggerEvents).
      const historyLimit =
        v.optIntegerInRange(raw.historyLimit, "modules.mojo-ai.historyLimit", 1, 5000) ?? 400;
      const maxSteps = v.optIntegerInRange(raw.maxSteps, "modules.mojo-ai.maxSteps", 1, 32) ?? 8;
      const replyLines = v.optIntegerInRange(raw.replyLines, "modules.mojo-ai.replyLines", 1, 10) ?? 3;
      const relays = parseRelays(v, raw.relays, "modules.mojo-ai.relays");
      const friendsFile = v.optNonEmptyString(raw.friendsFile, "modules.mojo-ai.friendsFile");
      const toolsRaw = v.optRecord(raw.tools, "modules.mojo-ai.tools") ?? {};
      const toolsDisabled = v.optStringArray(toolsRaw.disabled, "modules.mojo-ai.tools.disabled") ?? [];
      const guards = parseGuardConfig(v, raw);
      const dbPath = v.optNonEmptyString(raw.dbPath, "modules.mojo-ai.dbPath");
      const compaction = parseCompactionConfig(v, raw);
      if (compaction.enabled && historyLimit <= compaction.triggerEvents) {
        v.fail(
          "modules.mojo-ai.historyLimit",
          `must be greater than compaction.triggerEvents (${historyLimit} <= ${compaction.triggerEvents}) or the hard trim always runs first, making compaction dead code`,
        );
      }
      v.throwIfAny();
      return { models, historyLimit, maxSteps, replyLines, relays, friendsFile, toolsDisabled, guards, dbPath, compaction };
    },
    async setup(ctx) {
      const logs = new Map<string, ContextLog>();
      const aborter = new AbortController();
      ctx.onCleanup(() => aborter.abort());

      const friends = await loadFriends(ctx);
      const { tools, guidance, durableNames, subagentNames } = buildToolSet(
        defaultToolDefinitions({ models: ctx.config.models, signal: aborter.signal }),
        ctx.config.toolsDisabled,
      );
      // Sections built once, here — both the instructions string AND the leak
      // detector's per-section embeddings derive from this SAME list, so the
      // detector can never silently drift from what's actually sent as
      // instructions (the same single-source-of-truth reasoning as elsewhere
      // in this module).
      const sections = buildDefaultSections(friends, guidance);
      const instructions = assembleInstructions(sections);
      const leakDetector: LeakDetector | undefined = ctx.config.guards.leakDetector
        ? await createLeakDetector(leakDetectionSections(sections), resolveEmbeddingModel(ctx.config.models.embedding))
        : undefined;

      const middlewareChain: ChatMiddleware[] = [
        createRelayMiddleware(ctx.config.relays, () => ctx.client.server?.caseMapper ?? null),
      ];

      // One shared Database connection for every conversation's SqliteContextLog
      // (mirrors `logs`'s own per-conversation cache, just backed by rows
      // instead of an in-memory array). Absent `dbPath` → in-memory only,
      // same as through M7 — persistence is opt-in, not a hard requirement.
      const db: Database | undefined = ctx.config.dbPath ? openContextDb(ctx.config.dbPath) : undefined;
      if (db) ctx.onCleanup(() => db.close());

      const logFor = (key: string): ContextLog => {
        let log = logs.get(key);
        if (!log) {
          if (logs.size >= MAX_CONVERSATIONS) {
            // Evict the oldest-created conversation (Map preserves insertion order).
            const oldest = logs.keys().next().value;
            if (oldest !== undefined) logs.delete(oldest);
          }
          log = db ? new SqliteContextLog(db, key, ctx.config.historyLimit) : new InMemoryContextLog(ctx.config.historyLimit);
          logs.set(key, log);
        }
        return log;
      };

      // Casemapping-aware conversation key (channels only; PMs never get here).
      const convoKey = (event: PrivmsgEvent): string => {
        const name = event.channel?.name ?? event.target;
        return ctx.client.server?.caseMapper.normalize(name) ?? name.toLowerCase();
      };

      // Addressed = a line (post relay-unwrap) starting with "<nick>:" / "<nick>,".
      const isAddressed = (text: string): boolean => {
        const nick = ctx.client.nick;
        const mapper = ctx.client.server?.caseMapper;
        const lead = text.slice(0, nick.length);
        const punct = text[nick.length];
        const nickMatches = mapper ? mapper.equals(lead, nick) : lead.toLowerCase() === nick.toLowerCase();
        return nickMatches && (punct === ":" || punct === ",");
      };

      ctx.track(
        ctx.events$
          .pipe(
            filter((e): e is PrivmsgEvent => e.type === "privmsg"),
            filter((e) => !e.isPrivate && !ctx.isIgnored(e)),
            map((event): ChatMessage => {
              const account = resolveAccount(event);
              return {
                raw: event,
                speaker: { nick: event.user.nick, ...(account ? { account } : {}) },
                text: event.text,
                channel: event.channel?.name ?? event.target,
                at: new Date().toISOString(),
              };
            }),
            map((msg) => runChatMiddleware(msg, middlewareChain)),
            filter((msg): msg is ChatMessage => msg !== null),
            // No PMs, no ambient chatter: only channel lines that address the
            // bot are seen at all — everything else never reaches log or model.
            // Checked on the (possibly relay-unwrapped) resolved text.
            filter((msg) => isAddressed(msg.text)),
            // The conversation key is computed exactly ONCE per message here
            // and threaded through — `convoKey` reads the live casemapper,
            // which can change across a reconnect; recomputing it at each of
            // several call sites (as before) risked the exhaustMap `groupBy`
            // key and the log/compact key desyncing if a reconnect landed
            // mid-flight (M8 review finding — more consequential now that
            // `compact()` physically mutates the log).
            map((msg) => ({ msg, key: convoKey(msg.raw) })),
            tap(({ msg, key }) => {
              // A SqliteContextLog.append() can throw (SQLITE_BUSY, disk
              // full, a locked db) where InMemoryContextLog never could —
              // this `tap` sits OUTSIDE exhaustMap's per-exchange
              // `catchError`, in the same outer pipe `groupBy` depends on,
              // so an uncaught throw here would error the whole source
              // observable and permanently stop the bot from processing any
              // further message (M8 review finding). Degrade to "this one
              // message isn't recorded" instead.
              try {
                logFor(key).append({
                  kind: "chat-message",
                  at: msg.at,
                  speaker: resolveSpeaker(msg.speaker, friends),
                  text: msg.text,
                  addressed: true,
                });
              } catch (error) {
                ctx.log.warn(`failed to append chat-message for ${key}`, error);
              }
            }),
            groupBy(({ key }) => key),
            mergeMap((group) =>
              group.pipe(
                // One exchange at a time per conversation; an addressed line
                // arriving mid-exchange is recorded (above) but not replied to.
                // TODO: queue or interrupt (switchMap + abort) instead of dropping.
                exhaustMap(({ msg, key }) =>
                  defer(() =>
                    runGuardedExchange(
                      logFor(key),
                      {
                        nowUtc: new Date().toISOString(),
                        conversation: key,
                        guidance: [`Reply in at most ${ctx.config.replyLines} short lines.`],
                      },
                      {
                        model: ctx.config.models.chat,
                        instructions,
                        tools,
                        maxSteps: ctx.config.maxSteps,
                        signal: aborter.signal,
                      },
                      msg.text,
                      ctx.config.guards,
                      { classifierModel: ctx.config.models.classifier, leakDetector, signal: aborter.signal },
                    ),
                  ).pipe(
                    // Delivery AND compaction run here, inside the SAME
                    // exhaustMap-tracked inner observable — not in a
                    // detached `.subscribe()` callback. A compactor call is
                    // an LLM round-trip; if it ran outside this chain,
                    // exhaustMap would consider this conversation "free"
                    // the instant the reply was computed, and a fast
                    // follow-up message could start rendering/running a NEW
                    // exchange while compact() was still mutating the SAME
                    // log underneath it (the race the plan explicitly calls
                    // out). Awaiting it here means the next `exhaustMap`
                    // emission genuinely waits for compaction to finish too.
                    mergeMap(async (outcome) => {
                      const log = logFor(key);
                      if (outcome.result) {
                        recordDurableTranscripts(log, outcome.result, durableNames);
                        recordSubagentBriefings(log, outcome.result, subagentNames);
                      }
                      logGuardWarnings(ctx, key, outcome.explain);
                      deliver(ctx, log, msg.raw, outcome.reply);
                      const compacted = await maybeCompact(log, ctx.config.compaction, {
                        model: ctx.config.models.summarizer,
                        signal: aborter.signal,
                      });
                      if (compacted) ctx.log.info(`compacted conversation ${key}`);
                    }),
                    catchError((error) => {
                      ctx.log.warn(`exchange failed in ${key}`, error);
                      return EMPTY;
                    }),
                  ),
                ),
              ),
            ),
          )
          .subscribe(),
      );
    },
  });
}

/**
 * Load `friends.toml`, resolving a configured relative path against `cwd`
 * (there is no `configDir` from `Module.parseConfig` — see the config field's
 * doc comment). Absent config, unreadable file, invalid TOML, and malformed
 * entries all degrade to "no known-user data" with a logged warning — never a
 * thrown error that would stop the bot from starting.
 */
async function loadFriends(ctx: ModuleContext<MojoAiConfig>): Promise<readonly Friend[]> {
  if (!ctx.config.friendsFile) {
    ctx.log.info("no friendsFile configured — running without known-user data");
    return [];
  }
  const resolved = path.resolve(process.cwd(), ctx.config.friendsFile);
  ctx.log.info(`loading friends file: ${resolved}`);
  const { friends, warnings } = await loadFriendsFile(resolved);
  for (const warning of warnings) ctx.log.warn(`friends file: ${warning}`);
  ctx.log.info(`loaded ${friends.length} known friend(s)`);
  return friends;
}

/**
 * Guards fail open and never block on their own error (the M7 decision) —
 * but both a genuine failure AND a genuine block/strip need to be LOUD, so
 * an operator actually sees an extraction attempt or a hallucinated link
 * rather than it silently passing through the pipeline unnoticed.
 */
function logGuardWarnings(ctx: ModuleContext<MojoAiConfig>, conversation: string, explain: GuardExplain): void {
  const guard = explain.promptGuard;
  if (guard?.failedOpen) ctx.log.warn(`guards.prompt-guard failed open in ${conversation}: ${guard.reason}`);
  else if (guard && !guard.allowed) ctx.log.warn(`guards.prompt-guard BLOCKED a message in ${conversation}: ${guard.reason}`);

  const grounding = explain.grounding;
  if (grounding?.retried) {
    const status = grounding.final.grounded ? "corrected by retry" : "still ungrounded after retry, stripped";
    ctx.log.warn(`guards.grounding ${status} in ${conversation}: ${grounding.final.ungroundedUrls.join(", ")}`);
  }

  const leak = explain.leakDetector;
  if (leak?.failedOpen) ctx.log.warn(`guards.leak-detector failed open in ${conversation}: ${leak.reason}`);
  else if (leak?.isLeak) ctx.log.warn(`guards.leak-detector BLOCKED a leaked reply in ${conversation} (similarity=${leak.similarity}, via=${leak.via})`);
}

/** Send a reply (bounded to `replyLines` IRC lines) and record what was actually sent. */
function deliver(
  ctx: ModuleContext<MojoAiConfig>,
  log: ContextLog,
  event: PrivmsgEvent,
  reply: string,
): void {
  const lines = toReplyLines(reply, ctx.config.replyLines);
  if (lines.length === 0) return;

  const target = replyTarget(event);
  const sent = lines.filter((line) => safeSay(ctx.client, target, line, ctx.log));
  if (sent.length > 0) {
    log.append({ kind: "bot-reply", at: new Date().toISOString(), text: sent.join("\n") });
  }
}

export default mojoAiModule;
