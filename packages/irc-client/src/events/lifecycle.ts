// Connection lifecycle events emitted by the client (M2).
//
// These describe the *connection*, not IRC protocol traffic, so — unlike the
// protocol event taxonomy that lands in M3 — they carry no `raw` Message. The
// full `ClientEvent = IrcEvent | LifecycleEvent` surface and the `.on()` facade
// are unified in M5; for now `IrcClient` exposes `lifecycle$` directly.

/** A connection attempt is starting (`attempt` is 1-based across reconnects). */
export interface ConnectingEvent {
  readonly type: "connecting";
  readonly attempt: number;
}

/** The transport connected (socket open / TLS handshake done), before registration. */
export interface ConnectedEvent {
  readonly type: "connected";
  readonly attempt: number;
}

/** Registration completed (`001` received); the client is usable. */
export interface RegisteredEvent {
  readonly type: "registered";
  readonly nick: string;
}

/** The connection ended. `local` distinguishes a deliberate quit from a drop. */
export interface DisconnectedEvent {
  readonly type: "disconnected";
  readonly local: boolean;
  readonly error?: Error;
}

/** A reconnect is scheduled after a backoff delay. */
export interface ReconnectingEvent {
  readonly type: "reconnecting";
  readonly attempt: number;
  readonly delayMs: number;
}

/** A terminal error: reconnection is disabled or exhausted; the client gives up. */
export interface ClientErrorEvent {
  readonly type: "error";
  readonly error: Error;
}

/** Discriminated union of all connection lifecycle events. */
export type LifecycleEvent =
  | ConnectingEvent
  | ConnectedEvent
  | RegisteredEvent
  | DisconnectedEvent
  | ReconnectingEvent
  | ClientErrorEvent;
