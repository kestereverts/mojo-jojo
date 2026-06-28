import { Subject, takeUntil, timer, type Observable } from "rxjs";
import type { Message } from "@mojo-jojo/irc-message";
import {
  CapabilityStore,
  parseCapMessage,
  reconcileCaps,
  type CapMessage,
} from "./capabilities.ts";
import { capEnd, capLs, capReq, nick, pass, user } from "./commands.ts";
import {
  ERR_NICKCOLLISION,
  ERR_NICKNAMEINUSE,
  ERR_UNKNOWNCOMMAND,
  REGISTRATION_FATAL_NUMERICS,
  RPL_WELCOME,
} from "./numerics.ts";

/** Raised when the registration handshake cannot complete. */
export class RegistrationError extends Error {
  override readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "RegistrationError";
    this.cause = cause;
  }
}

/** Inputs for {@link register}, scoped to a single connection attempt. */
export interface RegistrationOptions {
  /** Primary nickname to register. */
  readonly nick: string;
  /** Username (the first `USER` argument / ident). */
  readonly username: string;
  /** Real name (the `USER` trailing argument / GECOS). */
  readonly realName: string;
  /** Optional server password, sent as `PASS` before anything else. */
  readonly password?: string;
  /** Capabilities to request (intersected with the advertised set), or `"all"`. */
  readonly desiredCaps: readonly string[] | "all";
  /** Alternate nicks to try, in order, when the primary is in use (`433`). */
  readonly altNicks?: readonly string[];
  /**
   * Whether to keep `sasl` in the requested set (M4). When false (the M2
   * default) `sasl` is dropped during reconciliation — there is nothing to
   * authenticate with yet.
   */
  readonly saslRequested?: boolean;
  /** Overall handshake timeout in milliseconds (default 30000). */
  readonly timeoutMs?: number;
}

/** The outcome of a successful registration. */
export interface RegistrationResult {
  /** The nickname the server actually accepted (after any `433` fallback). */
  readonly nick: string;
  /** The `001` welcome message. */
  readonly welcome: Message;
  /** Capability state (available + enabled) as of `CAP END`. */
  readonly capabilities: CapabilityStore;
}

/** Collaborators {@link register} drives the handshake through. */
export interface RegistrationDeps {
  /** Inbound messages for this connection (the shared parse pipeline). */
  readonly messages$: Observable<Message>;
  /** Priority send (bypasses the flood queue) used for all handshake traffic. */
  readonly send: (message: Message) => void;
}

/** Keep each `CAP REQ` line comfortably under the 512-byte message limit. */
const MAX_CAP_REQ_LEN = 400;

/** Split a capability request into chunks whose joined length stays bounded. */
function chunkCaps(caps: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const cap of caps) {
    if (current.length > 0 && length + 1 + cap.length > MAX_CAP_REQ_LEN) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    length += current.length === 0 ? cap.length : 1 + cap.length;
    current.push(cap);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Drive the IRC registration handshake to completion.
 *
 * The flow, all on the priority send path:
 *
 * ```text
 * PASS? -> CAP LS 302 -> NICK -> USER
 *   -> (CAP LS accumulated) -> CAP REQ -> (ACK/NAK) -> CAP END
 *   -> 001  => resolved
 * ```
 *
 * `NICK`/`USER` are sent immediately after `CAP LS`; the server holds
 * registration open until `CAP END`, so this ordering is both spec-compatible
 * and robust against servers that ignore `CAP` (detected via `421`/`001`).
 * `433` nick-in-use walks `altNicks`, then falls back to numeric suffixes.
 *
 * Resolves with the accepted nick + capability state on `001`; rejects on a
 * fatal registration numeric, an abnormal disconnect, or timeout. `PING` is
 * left to the client's long-lived responder.
 *
 * SASL slots in after `ACK` and before `CAP END` in M4; the seam is the
 * `concludeCaps` call below.
 */
export function register(
  deps: RegistrationDeps,
  options: RegistrationOptions,
): Promise<RegistrationResult> {
  const { messages$, send } = deps;
  const timeoutMs = options.timeoutMs ?? 30000;
  const caps = new CapabilityStore();
  const altNicks = options.altNicks ?? [];
  const pending = new Set<string>();

  let nickIndex = 0;
  let currentNick = options.nick;
  let capsConcluded = false;

  return new Promise<RegistrationResult>((resolve, reject) => {
    const done$ = new Subject<void>();
    let finished = false;
    const settle = (action: () => void): void => {
      // Set the guard *before* signalling done$: `takeUntil(done$)` completes the
      // message subscription synchronously here, re-entering `settle` via the
      // `complete` handler — this flag makes that re-entrant call a no-op so the
      // first outcome (resolve / the real rejection) wins.
      if (finished) return;
      finished = true;
      done$.next();
      done$.complete();
      action();
    };

    const concludeCaps = (): void => {
      if (capsConcluded) return;
      capsConcluded = true;
      send(capEnd());
    };

    const nextNick = (): void => {
      nickIndex += 1;
      currentNick = altNicks[nickIndex - 1] ?? `${options.nick}${nickIndex}`;
      send(nick(currentNick));
    };

    const handleCap = (cap: CapMessage): void => {
      switch (cap.subcommand) {
        case "LS": {
          caps.addAvailable(cap.tokens);
          if (!cap.final) return; // continuation line; wait for the rest
          const requested = reconcileCaps(
            options.desiredCaps,
            caps.available,
            options.saslRequested ?? false,
          );
          if (requested.length === 0) {
            concludeCaps();
            return;
          }
          for (const name of requested) pending.add(name);
          for (const chunk of chunkCaps(requested)) send(capReq(chunk));
          return;
        }
        case "ACK": {
          caps.applyAck(cap.tokens);
          for (const token of cap.tokens) pending.delete(token.name);
          // M4 seam: if `sasl` is now enabled and credentials exist, run the
          // AUTHENTICATE exchange here before concluding.
          if (pending.size === 0) concludeCaps();
          return;
        }
        case "NAK": {
          for (const token of cap.tokens) pending.delete(token.name);
          if (pending.size === 0) concludeCaps();
          return;
        }
        // NEW/DEL/LIST are runtime concerns (M3+), not part of registration.
        default:
          return;
      }
    };

    const handle = (message: Message): void => {
      const cmd = message.command;

      if (cmd === RPL_WELCOME) {
        const accepted = message.params[0] ?? currentNick;
        settle(() =>
          resolve({ nick: accepted, welcome: message, capabilities: caps }),
        );
        return;
      }
      if (cmd === ERR_NICKNAMEINUSE || cmd === ERR_NICKCOLLISION) {
        nextNick();
        return;
      }
      if (REGISTRATION_FATAL_NUMERICS.has(cmd)) {
        settle(() =>
          reject(
            new RegistrationError(
              `registration rejected by server (${cmd}): ${message.params.join(" ")}`,
            ),
          ),
        );
        return;
      }
      if (cmd === ERR_UNKNOWNCOMMAND && message.params[1] === "CAP") {
        // Legacy server with no capability support: stop waiting on CAP and let
        // the already-sent NICK/USER complete registration. Never send CAP END.
        capsConcluded = true;
        return;
      }

      const cap = parseCapMessage(message);
      if (cap !== null) handleCap(cap);
    };

    timer(timeoutMs)
      .pipe(takeUntil(done$))
      .subscribe(() =>
        settle(() =>
          reject(new RegistrationError(`registration timed out after ${timeoutMs}ms`)),
        ),
      );

    messages$.pipe(takeUntil(done$)).subscribe({
      next: handle,
      error: (err: unknown) =>
        settle(() =>
          reject(
            new RegistrationError(
              "connection error during registration",
              err instanceof Error ? err : new Error(String(err)),
            ),
          ),
        ),
      complete: () =>
        settle(() =>
          reject(new RegistrationError("connection closed during registration")),
        ),
    });

    // Kick off the handshake (subscription is live, so no reply can be missed).
    if (options.password !== undefined) send(pass(options.password));
    send(capLs());
    send(nick(currentNick));
    send(user(options.username, options.realName));
  });
}
