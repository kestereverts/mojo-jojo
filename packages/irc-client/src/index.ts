// @mojo-jojo/irc-client — public API (Milestone 1: transport + inbound pipeline).
//
// The high-level IrcClient facade, state entities, and event taxonomy land in
// later milestones; this surface currently exposes the transport seam and the
// byte -> message pipeline so they can be composed and tested directly.

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

// Re-export the message intermediate representation for convenience.
export type { Message, Source, Tags } from "@mojo-jojo/irc-message";
