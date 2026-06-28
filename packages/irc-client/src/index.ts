// @mojo-jojo/irc-client — public API.
//
// M1 exposed the transport seam and the inbound byte -> message pipeline. M2
// adds the connection facade: registration, CAP negotiation, PING/PONG, a
// flood-controlled outbound queue, and exponential-backoff reconnection. State
// entities, the rich event taxonomy, and the `.on()` facade arrive in M3/M5.

// High-level facade
export { IrcClient, type ClientState, type IrcClientInternals } from "./IrcClient.ts";
export {
  resolveOptions,
  DEFAULT_CAPS,
  DEFAULT_RECONNECT,
  type IrcClientOptions,
  type ResolvedOptions,
  type ReconnectOptions,
  type SaslOptions,
  type Backend,
} from "./options.ts";
export type { LifecycleEvent } from "./events/lifecycle.ts";

// Transport
export {
  TransportClosedError,
  type Transport,
  type TransportFactory,
  type TransportClose,
} from "./transport/Transport.ts";
export {
  BunSocketTransport,
  type BunSocketTransportOptions,
  type SocketConnector,
} from "./transport/BunSocketTransport.ts";
export { MockTransport } from "./transport/MockTransport.ts";

// Inbound pipeline
export { decodeLines } from "./pipeline/lineDecoder.ts";
export { createMessageStream, type IrcPipelineOptions } from "./pipeline/IrcPipeline.ts";

// Outbound pipeline
export { OutboundQueue, type OutboundQueueOptions } from "./pipeline/outbound.ts";

// Reconnection
export {
  backoffDelay,
  retryWithBackoff,
  type ReconnectPolicy,
  type BackoffDeps,
} from "./reconnect.ts";

// Protocol building blocks (advanced callers / testing)
export * as commands from "./protocol/commands.ts";
export * as numerics from "./protocol/numerics.ts";
export {
  parseCapMessage,
  reconcileCaps,
  CapabilityStore,
  type CapMessage,
  type CapToken,
  type CapValue,
  type CapSubcommand,
} from "./protocol/capabilities.ts";
export {
  register,
  RegistrationError,
  type RegistrationOptions,
  type RegistrationResult,
  type RegistrationDeps,
} from "./protocol/registration.ts";

// Re-export the message intermediate representation for convenience.
export type { Message, Source, Tags } from "@mojo-jojo/irc-message";
