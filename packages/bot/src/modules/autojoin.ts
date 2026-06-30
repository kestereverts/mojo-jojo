import { takeUntil } from "rxjs";
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
        // join() can throw (e.g. a full outbound queue on a burst); best-effort.
        try {
          ctx.client.join(channel, keys[channel]);
        } catch (error) {
          ctx.log.warn(`autojoin ${channel} failed`, error);
        }
      };

      // One Set of pending timers (not one onCleanup per timer, which would leak
      // across reconnects); cleared on each re-register so stale joins from a dropped
      // connection can't fire, and on disposal.
      const pending = new Set<ReturnType<typeof setTimeout>>();
      const clearPending = (): void => {
        for (const timer of pending) clearTimeout(timer);
        pending.clear();
      };
      ctx.onCleanup(clearPending);

      ctx.lifecycle$.pipe(takeUntil(ctx.destroyed$)).subscribe((event) => {
        // Cancel stale joins the moment a connection drops, so a pending timer can't
        // fire during the reconnect/pre-registration window.
        if (event.type === "disconnected") {
          clearPending();
          return;
        }
        if (event.type === "registered") {
          clearPending();
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
        }
      });
    },
  });
}
