import type { Message } from "@mojo-jojo/irc-message";
import type { SaslOptions } from "../options.ts";
import { authenticate } from "./commands.ts";
import {
  ERR_NICKLOCKED,
  ERR_SASLABORTED,
  ERR_SASLALREADY,
  ERR_SASLFAIL,
  ERR_SASLTOOLONG,
  RPL_LOGGEDIN,
  RPL_SASLMECHS,
  RPL_SASLSUCCESS,
} from "./numerics.ts";

// SASL authentication (IRCv3). The control flow — when to start, and concluding
// CAP negotiation on success/failure — lives in `registration.ts`; this module
// is the pure, unit-testable substrate: the mechanisms (PLAIN/EXTERNAL), the
// base64 + 400-byte chunking of the `AUTHENTICATE` exchange, and a small session
// state machine that turns inbound messages into "send these lines" / "done".
//
// @see https://ircv3.net/specs/extensions/sasl-3.1

/** Max bytes of base64 payload per `AUTHENTICATE` line (IRCv3 SASL). */
const SASL_CHUNK_SIZE = 400;

/**
 * Upper bound on a reassembled inbound SASL challenge (bytes). PLAIN/EXTERNAL
 * challenges are tiny; even SCRAM is well under this. It only stops a hostile
 * server from streaming endless 400-byte continuation chunks (memory DoS).
 */
const MAX_SASL_CHALLENGE = 65536;

/**
 * A SASL mechanism. Given the decoded server challenge (empty string for the
 * initial `AUTHENTICATE +` prompt), it produces the raw — pre-base64 — response.
 * PLAIN and EXTERNAL are client-first and ignore the challenge; interactive
 * mechanisms (SCRAM, a later addition) will consume it.
 */
export interface SaslMechanism {
  /** Wire name sent as `AUTHENTICATE <name>` (e.g. `PLAIN`). */
  readonly name: string;
  /** Produce the raw response to a (decoded) server challenge. */
  respond(challenge: string): string;
}

/** SASL PLAIN (RFC 4616): `authzid \0 authcid \0 passwd`; authzid usually empty. */
export function plain(username: string, password: string, authzid = ""): SaslMechanism {
  return {
    name: "PLAIN",
    respond: () => `${authzid}\0${username}\0${password}`,
  };
}

/**
 * SASL EXTERNAL (RFC 4422): authenticate via an out-of-band credential (e.g. a
 * TLS client certificate). The response is the authorization identity, normally
 * empty (the server uses the certificate's identity).
 */
export function external(authzid = ""): SaslMechanism {
  return {
    name: "EXTERNAL",
    respond: () => authzid,
  };
}

/** Build the {@link SaslMechanism} described by a resolved {@link SaslOptions}. */
export function mechanismFor(options: SaslOptions): SaslMechanism {
  switch (options.mechanism) {
    case "PLAIN":
      return plain(options.username, options.password);
    case "EXTERNAL":
      return external();
  }
}

/** Encode a UTF-8 string to base64 (Web-standard; handles non-ASCII payloads). */
export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode a base64 string back to UTF-8 text. */
export function decodeBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Split an already-base64-encoded SASL response into `AUTHENTICATE` lines, per
 * the IRCv3 wire rules:
 *
 *  - an empty response is sent as a single `AUTHENTICATE +`;
 *  - otherwise the response is split into 400-byte chunks;
 *  - if the final chunk is exactly 400 bytes (i.e. the length is a multiple of
 *    400), a trailing `AUTHENTICATE +` is appended so the server can tell the
 *    payload ended.
 */
export function chunkSaslResponse(encoded: string): Message[] {
  if (encoded.length === 0) return [authenticate("+")];
  const lines: Message[] = [];
  for (let i = 0; i < encoded.length; i += SASL_CHUNK_SIZE) {
    lines.push(authenticate(encoded.slice(i, i + SASL_CHUNK_SIZE)));
  }
  if (encoded.length % SASL_CHUNK_SIZE === 0) lines.push(authenticate("+"));
  return lines;
}

/** The outcome of feeding one inbound message to a {@link SaslSession}. */
export type SaslStep =
  /** Send these `AUTHENTICATE` lines, then keep feeding messages. */
  | { readonly type: "send"; readonly messages: readonly Message[] }
  /** Nothing to do for this message; keep feeding. */
  | { readonly type: "continue" }
  /** Authentication succeeded; conclude CAP negotiation. */
  | { readonly type: "success"; readonly account: string | null }
  /** Authentication failed terminally; abort registration. */
  | { readonly type: "failure"; readonly code: string; readonly reason: string };

/** SASL numerics that terminate the exchange in failure. */
const TERMINAL_FAILURES: ReadonlySet<string> = new Set([
  ERR_NICKLOCKED,
  ERR_SASLFAIL,
  ERR_SASLTOOLONG,
  ERR_SASLABORTED,
]);

/**
 * Drives a single SASL exchange for one mechanism. The caller sends
 * {@link start}'s line, then routes every inbound `AUTHENTICATE` line and SASL
 * numeric (900–908) to {@link handle}, acting on the returned {@link SaslStep}
 * until it is `success` or `failure`.
 *
 * Pure and synchronous: no I/O and no timers (the registration coordinator owns
 * the overall handshake timeout). Inbound challenges are reassembled from
 * 400-byte chunks symmetrically to the outbound encoding.
 */
export class SaslSession {
  readonly #mechanism: SaslMechanism;
  #challenge = "";
  #account: string | null = null;
  #finished = false;

  constructor(mechanism: SaslMechanism) {
    this.#mechanism = mechanism;
  }

  /** The mechanism being negotiated. */
  get mechanism(): string {
    return this.#mechanism.name;
  }

  /** The opening line: `AUTHENTICATE <MECHANISM>`. */
  start(): Message {
    return authenticate(this.#mechanism.name);
  }

  /** Feed one inbound SASL message; returns the next {@link SaslStep}. */
  handle(message: Message): SaslStep {
    if (this.#finished) return { type: "continue" };

    if (message.command === "AUTHENTICATE") {
      return this.#onChallenge(message.params[0] ?? "");
    }

    switch (message.command) {
      case RPL_LOGGEDIN:
        // 900 <client> <nick!user@host> <account> :You are now logged in as …
        this.#account = message.params[2] ?? this.#account;
        return { type: "continue" };
      case RPL_SASLSUCCESS:
      case ERR_SASLALREADY:
        // 907 (already authenticated) is benign: we are, in fact, logged in.
        this.#finished = true;
        return { type: "success", account: this.#account };
      case RPL_SASLMECHS:
        // Informational; the failing numeric (usually 904) follows.
        return { type: "continue" };
      default:
        if (TERMINAL_FAILURES.has(message.command)) {
          this.#finished = true;
          return {
            type: "failure",
            code: message.command,
            reason: message.params[message.params.length - 1] ?? message.command,
          };
        }
        return { type: "continue" };
    }
  }

  /** Handle an `AUTHENTICATE <param>` line: reassemble, then respond. */
  #onChallenge(param: string): SaslStep {
    // A 400-byte, non-`+` chunk means more challenge is coming.
    if (param !== "+" && param.length === SASL_CHUNK_SIZE) {
      // Bound reassembly: a hostile SASL server could otherwise stream 400-byte
      // continuation chunks forever (and never terminate), growing this buffer
      // without limit before the handshake timeout fires. Fail closed past the cap.
      if (this.#challenge.length >= MAX_SASL_CHALLENGE) {
        this.#challenge = "";
        this.#finished = true;
        return { type: "failure", code: "TOOLONG", reason: "SASL challenge exceeded the size limit" };
      }
      this.#challenge += param;
      return { type: "continue" };
    }
    const full = param === "+" ? this.#challenge : this.#challenge + param;
    this.#challenge = "";
    // A malformed (non-base64) challenge from the server must fail the exchange,
    // not throw out of the caller's message pipeline.
    let decoded: string;
    try {
      decoded = full === "" ? "" : decodeBase64(full);
    } catch {
      this.#finished = true;
      return { type: "failure", code: "PARSE", reason: "malformed base64 challenge" };
    }
    const response = this.#mechanism.respond(decoded);
    return { type: "send", messages: chunkSaslResponse(encodeBase64(response)) };
  }
}
