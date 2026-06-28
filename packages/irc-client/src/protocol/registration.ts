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
  SASL_NUMERICS,
} from "./numerics.ts";
import { mechanismFor, SaslSession } from "./sasl.ts";
import type { SaslOptions } from "../options.ts";

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
   * SASL credentials. When set, `sasl` is kept in the requested cap set and the
   * `AUTHENTICATE` exchange runs after `ACK` and before `CAP END`. If the server
   * then refuses the `sasl` capability, registration fails closed rather than
   * silently continuing unauthenticated.
   */
  readonly sasl?: SaslOptions;
  /**
   * Force `sasl` into the requested set even without {@link sasl} credentials
   * (rarely useful on its own). Implied whenever {@link sasl} is set.
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
  /** Services account from a successful SASL login (`900`), or `null`. */
  readonly account: string | null;
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
 * When {@link RegistrationOptions.sasl} is set, the `AUTHENTICATE` exchange runs
 * between the final `ACK`/`NAK` and `CAP END`: the inbound `AUTHENTICATE` lines
 * and SASL numerics (900–908) are routed to a {@link SaslSession}, and `CAP END`
 * is held until it succeeds. A terminal SASL failure rejects registration.
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
  // Setting `sasl` credentials implies requesting the `sasl` capability.
  const saslRequested = options.sasl !== undefined || (options.saslRequested ?? false);

  let nickIndex = 0;
  let currentNick = options.nick;
  let capsConcluded = false;
  let saslSession: SaslSession | null = null;
  let saslSucceeded = false;
  let saslAccount: string | null = null;

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

    /**
     * Once CAP REQ has fully resolved (all pending caps ACK/NAK'd), either kick
     * off the SASL exchange or conclude negotiation. With SASL credentials but no
     * enabled `sasl` cap, fail closed instead of registering unauthenticated.
     */
    const beginSaslOrConclude = (): void => {
      if (options.sasl === undefined) {
        concludeCaps();
        return;
      }
      if (!caps.isEnabled("sasl")) {
        settle(() =>
          reject(
            new RegistrationError(
              "SASL was requested but the server did not enable the `sasl` capability",
            ),
          ),
        );
        return;
      }
      saslSession = new SaslSession(mechanismFor(options.sasl));
      send(saslSession.start());
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
          const requested = reconcileCaps(options.desiredCaps, caps.available, saslRequested);
          if (requested.length === 0) {
            beginSaslOrConclude();
            return;
          }
          for (const name of requested) pending.add(name);
          for (const chunk of chunkCaps(requested)) send(capReq(chunk));
          return;
        }
        case "ACK": {
          caps.applyAck(cap.tokens);
          for (const token of cap.tokens) pending.delete(token.name);
          if (pending.size === 0) beginSaslOrConclude();
          return;
        }
        case "NAK": {
          for (const token of cap.tokens) pending.delete(token.name);
          if (pending.size === 0) beginSaslOrConclude();
          return;
        }
        // NEW/DEL/LIST are runtime concerns (M3+), not part of registration.
        default:
          return;
      }
    };

    /** Reject because SASL was required but registration finished without it. */
    const failSaslClosed = (reason: string): void => {
      settle(() => reject(new RegistrationError(reason)));
    };

    const handle = (message: Message): void => {
      // A synchronous throw here (e.g. a malformed SASL challenge) must reject the
      // handshake cleanly, never error the shared inbound pipeline.
      try {
        const cmd = message.command;

        if (cmd === RPL_WELCOME) {
          // Fail closed: if credentials were configured but SASL never succeeded,
          // a premature/early `001` (or an injected one) must not register us
          // unauthenticated.
          if (options.sasl !== undefined && !saslSucceeded) {
            failSaslClosed("registration completed (001) before SASL authentication succeeded");
            return;
          }
          const accepted = message.params[0] ?? currentNick;
          settle(() =>
            resolve({ nick: accepted, welcome: message, capabilities: caps, account: saslAccount }),
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
          // Legacy server with no capability support. With SASL configured this is
          // a fail-closed condition (and guards against a spoofed 421 downgrade);
          // otherwise let the already-sent NICK/USER complete registration without
          // ever sending CAP END.
          if (options.sasl !== undefined) {
            failSaslClosed("server does not support capability negotiation; cannot SASL");
            return;
          }
          capsConcluded = true;
          return;
        }

        // SASL exchange: while a session is live, AUTHENTICATE lines and SASL
        // numerics (900–908) belong to it, not the generic CAP/numeric handling.
        if (saslSession !== null && (cmd === "AUTHENTICATE" || SASL_NUMERICS.has(cmd))) {
          const step = saslSession.handle(message);
          switch (step.type) {
            case "send":
              for (const line of step.messages) send(line);
              break;
            case "success":
              saslSucceeded = true;
              saslAccount = step.account;
              saslSession = null;
              concludeCaps();
              break;
            case "failure":
              saslSession = null;
              failSaslClosed(`SASL authentication failed (${step.code}): ${step.reason}`);
              break;
            case "continue":
              break;
          }
          return;
        }

        const cap = parseCapMessage(message);
        if (cap !== null) handleCap(cap);
      } catch (err) {
        settle(() =>
          reject(
            new RegistrationError(
              "unexpected error during registration handshake",
              err instanceof Error ? err : new Error(String(err)),
            ),
          ),
        );
      }
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
