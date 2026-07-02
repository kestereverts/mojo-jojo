import { safeClientCall } from "../command/reply.ts";
import { Validator } from "../config/validate.ts";
import { defineModule, type Module } from "../module/types.ts";

interface AutojoinConfig {
  readonly channels: readonly string[];
  readonly keys: Readonly<Record<string, string>>;
  readonly delayMs: number;
}

/**
 * Joins configured channels on every successful registration (so it re-fires after
 * a reconnect, not just at startup). Optional per-channel keys and a stagger delay.
 */
export function autojoinModule(): Module<AutojoinConfig> {
  return defineModule<AutojoinConfig>({
    name: "autojoin",
    description: "Joins configured channels on (re)connect.",
    parseConfig(raw) {
      const v = new Validator();
      const channels = v.optStringArray(raw.channels, "modules.autojoin.channels") ?? [];
      const delayMs = v.optNonNegativeNumber(raw.delayMs, "modules.autojoin.delayMs") ?? 0;
      // A null-prototype map so a hostile channel key (`__proto__`) can't pollute.
      const keys: Record<string, string> = Object.create(null) as Record<string, string>;
      const keysRaw = v.optRecord(raw.keys, "modules.autojoin.keys");
      if (keysRaw) {
        for (const [channel, key] of Object.entries(keysRaw)) {
          const value = v.optString(key, `modules.autojoin.keys.${channel}`);
          if (value !== undefined) keys[channel] = value;
        }
      }
      v.throwIfAny();
      return { channels, keys, delayMs };
    },
    setup(ctx) {
      const { channels, keys, delayMs } = ctx.config;
      if (channels.length === 0) return;

      const join = (channel: string): void => {
        // join() can throw (e.g. a full outbound queue on a burst); best-effort,
        // via the shared guard so the throw never escapes.
        safeClientCall(() => ctx.client.join(channel, keys[channel]), ctx.log, `autojoin ${channel}`);
      };

      // Join on every registration, with a fresh timer set per connection. The
      // host cancels this connection's teardown (below) on disconnect/dispose and
      // before the next registration, so a stale staggered join can never fire
      // during the reconnect window — no hand-rolled lifecycle handling needed.
      ctx.onEachConnection(() => {
        const pending = new Set<ReturnType<typeof setTimeout>>();
        channels.forEach((channel, index) => {
          if (delayMs > 0) {
            // Stagger: channel N joins at (N+1)*delayMs after registration (so the
            // first is delayed `delayMs`, each subsequent one `delayMs` later).
            const timer = setTimeout(() => {
              pending.delete(timer);
              join(channel);
            }, (index + 1) * delayMs);
            pending.add(timer);
          } else {
            join(channel);
          }
        });
        return () => {
          for (const timer of pending) clearTimeout(timer);
          pending.clear();
        };
      });
    },
  });
}
