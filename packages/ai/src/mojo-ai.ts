import * as path from "node:path";
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
import { recordDurableTranscripts, recordSubagentBriefings, runExchange } from "./exchange.ts";
import { toReplyLines } from "./reply.ts";
import { buildToolSet, defaultToolDefinitions } from "./tools/index.ts";
import type { ModelRoles } from "./models.ts";
import { runChatMiddleware, type ChatMessage, type ChatMiddleware } from "./identity/middleware.ts";
import { createRelayMiddleware, parseRelays, type RelayDefinition } from "./identity/relay.ts";
import { loadFriendsFile, resolveSpeaker, type Friend } from "./identity/speakers.ts";
import { buildDefaultInstructions } from "./prompt/instructions.ts";

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
      const historyLimit =
        v.optIntegerInRange(raw.historyLimit, "modules.mojo-ai.historyLimit", 1, 5000) ?? 200;
      const maxSteps = v.optIntegerInRange(raw.maxSteps, "modules.mojo-ai.maxSteps", 1, 32) ?? 8;
      const replyLines = v.optIntegerInRange(raw.replyLines, "modules.mojo-ai.replyLines", 1, 10) ?? 3;
      const relays = parseRelays(v, raw.relays, "modules.mojo-ai.relays");
      const friendsFile = v.optNonEmptyString(raw.friendsFile, "modules.mojo-ai.friendsFile");
      const toolsRaw = v.optRecord(raw.tools, "modules.mojo-ai.tools") ?? {};
      const toolsDisabled = v.optStringArray(toolsRaw.disabled, "modules.mojo-ai.tools.disabled") ?? [];
      v.throwIfAny();
      return { models, historyLimit, maxSteps, replyLines, relays, friendsFile, toolsDisabled };
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
      const instructions = buildDefaultInstructions(friends, guidance);

      const middlewareChain: ChatMiddleware[] = [
        createRelayMiddleware(ctx.config.relays, () => ctx.client.server?.caseMapper ?? null),
      ];

      const logFor = (key: string): ContextLog => {
        let log = logs.get(key);
        if (!log) {
          if (logs.size >= MAX_CONVERSATIONS) {
            // Evict the oldest-created conversation (Map preserves insertion order).
            const oldest = logs.keys().next().value;
            if (oldest !== undefined) logs.delete(oldest);
          }
          log = new InMemoryContextLog(ctx.config.historyLimit);
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
            tap((msg) =>
              logFor(convoKey(msg.raw)).append({
                kind: "chat-message",
                at: msg.at,
                speaker: resolveSpeaker(msg.speaker, friends),
                text: msg.text,
                addressed: true,
              }),
            ),
            groupBy((msg) => convoKey(msg.raw)),
            mergeMap((group) =>
              group.pipe(
                // One exchange at a time per conversation; an addressed line
                // arriving mid-exchange is recorded (above) but not replied to.
                // TODO: queue or interrupt (switchMap + abort) instead of dropping.
                exhaustMap((msg) =>
                  defer(() =>
                    runExchange(
                      logFor(convoKey(msg.raw)),
                      {
                        nowUtc: new Date().toISOString(),
                        conversation: convoKey(msg.raw),
                        guidance: [`Reply in at most ${ctx.config.replyLines} short lines.`],
                      },
                      {
                        model: ctx.config.models.chat,
                        instructions,
                        tools,
                        maxSteps: ctx.config.maxSteps,
                        signal: aborter.signal,
                      },
                    ),
                  ).pipe(
                    map((result) => {
                      const log = logFor(convoKey(msg.raw));
                      recordDurableTranscripts(log, result, durableNames);
                      recordSubagentBriefings(log, result, subagentNames);
                      return { msg, reply: result.text };
                    }),
                    catchError((error) => {
                      ctx.log.warn(`exchange failed in ${convoKey(msg.raw)}`, error);
                      return EMPTY;
                    }),
                  ),
                ),
              ),
            ),
          )
          .subscribe(({ msg, reply }) => deliver(ctx, logFor(convoKey(msg.raw)), msg.raw, reply)),
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
