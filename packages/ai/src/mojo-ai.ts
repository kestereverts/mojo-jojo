import { EMPTY, catchError, defer, exhaustMap, filter, groupBy, map, mergeMap, tap } from "rxjs";
import {
  Validator,
  defineModule,
  replyTarget,
  safeSay,
  type Module,
  type ModuleContext,
} from "@mojo-jojo/bot";
import type { PrivmsgEvent } from "@mojo-jojo/irc-client";
import { InMemoryContextLog, type ContextLog } from "./context/log.ts";
import { runExchange } from "./exchange.ts";
import { toReplyLines } from "./reply.ts";
import { defaultTools } from "./tools.ts";
import { DEFAULT_INSTRUCTIONS } from "./persona.ts";
import type { ModelRoles } from "./models.ts";

const DEFAULT_CHAT_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";

interface MojoAiConfig {
  /**
   * `"provider/model-id"` specs per occasion (see {@link ModelRoles}). Only
   * `chat` is consumed today (the main exchange); `classifier`/`summarizer`/
   * `research`/`embedding` are resolved and validated now so later milestones
   * (M5-M7) have them ready, and so `mojo-ai-debug` can show the full mapping.
   * Keys come from GEMINI_API_KEY / OPENAI_API_KEY.
   */
  readonly models: ModelRoles;
  /** Per-conversation memory window (context events). */
  readonly historyLimit: number;
  /** Tool-loop iteration bound per exchange. */
  readonly maxSteps: number;
  /** Max IRC lines per reply; the rest is dropped. */
  readonly replyLines: number;
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
      v.throwIfAny();
      return { models, historyLimit, maxSteps, replyLines };
    },
    setup(ctx) {
      const logs = new Map<string, ContextLog>();
      const aborter = new AbortController();
      ctx.onCleanup(() => aborter.abort());

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

      // Addressed = a channel line starting with "<nick>:" / "<nick>,".
      const isAddressed = (event: PrivmsgEvent): boolean => {
        const nick = ctx.client.nick;
        const mapper = ctx.client.server?.caseMapper;
        const lead = event.text.slice(0, nick.length);
        const punct = event.text[nick.length];
        const nickMatches = mapper ? mapper.equals(lead, nick) : lead.toLowerCase() === nick.toLowerCase();
        return nickMatches && (punct === ":" || punct === ",");
      };

      ctx.track(
        ctx.events$
          .pipe(
            filter((e): e is PrivmsgEvent => e.type === "privmsg"),
            // No PMs, no ambient chatter: only channel lines that address the
            // bot are seen at all — everything else never reaches log or model.
            filter((e) => !e.isPrivate && !ctx.isIgnored(e) && isAddressed(e)),
            tap((event) =>
              logFor(convoKey(event)).append({
                kind: "chat-message",
                at: new Date().toISOString(),
                speaker: { nick: event.user.nick, ...(event.account ? { account: event.account } : {}) },
                text: event.text,
                addressed: true,
              }),
            ),
            groupBy((event) => convoKey(event)),
            mergeMap((group) =>
              group.pipe(
                // One exchange at a time per conversation; an addressed line
                // arriving mid-exchange is recorded (above) but not replied to.
                // TODO: queue or interrupt (switchMap + abort) instead of dropping.
                exhaustMap((event) =>
                  defer(() =>
                    runExchange(
                      logFor(convoKey(event)),
                      {
                        nowUtc: new Date().toISOString(),
                        conversation: convoKey(event),
                        guidance: [`Reply in at most ${ctx.config.replyLines} short lines.`],
                      },
                      {
                        model: ctx.config.models.chat,
                        instructions: DEFAULT_INSTRUCTIONS,
                        tools: defaultTools(),
                        maxSteps: ctx.config.maxSteps,
                        signal: aborter.signal,
                      },
                    ),
                  ).pipe(
                    map((result) => ({ event, reply: result.text })),
                    catchError((error) => {
                      ctx.log.warn(`exchange failed in ${convoKey(event)}`, error);
                      return EMPTY;
                    }),
                  ),
                ),
              ),
            ),
          )
          .subscribe(({ event, reply }) => deliver(ctx, logFor(convoKey(event)), event, reply)),
      );
    },
  });
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
