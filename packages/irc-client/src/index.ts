// @mojo-jojo/irc-client — public API.
//
// M1 exposed the transport seam and the inbound byte -> message pipeline. M2
// added the connection facade: registration, CAP negotiation, PING/PONG, a
// flood-controlled outbound queue, and exponential-backoff reconnection. M3 adds
// live state tracking (casemapping, ISUPPORT, entities) and the entity-resolved
// event taxonomy. M4 adds SASL (PLAIN/EXTERNAL) and the `account-notify`
// dynamic. M5 adds the action methods, the `MemberList.by` index sugar, and the
// unified `ClientEvent` surface + top-level `.on()`/`once()`/`off()` facade. M6
// adds the P2/P3 cap dynamics: away-notify, chghost, setname, BATCH reassembly,
// standard replies (FAIL/WARN/NOTE), WHO enrichment, and labeled-response
// correlation (`sendLabeled`/`chatHistory`).

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

// Entity-resolved event taxonomy (M3); ClientEvent unifies it with lifecycle (M5)
export type {
  BaseEvent,
  IrcEvent,
  ClientEvent,
  UserEvent,
  ChannelEvent,
  PrivmsgEvent,
  ActionEvent,
  NoticeEvent,
  JoinEvent,
  PartEvent,
  QuitEvent,
  KickEvent,
  NickEvent,
  AccountEvent,
  AwayEvent,
  ChghostEvent,
  SetnameEvent,
  ModeEvent,
  TopicEvent,
  NamesEvent,
  BatchEvent,
  StandardReplyEvent,
  CapEvent,
} from "./events/types.ts";
export * as eventFactory from "./events/factory.ts";

// State entities (M3)
export { ReactiveEntity, type Unsubscribe } from "./entities/ReactiveEntity.ts";
export { Server } from "./entities/Server.ts";
export { Channel, type ChannelSnapshot } from "./entities/Channel.ts";
export { User, type UserSnapshot } from "./entities/User.ts";
export { Member, type MemberSnapshot } from "./entities/Member.ts";
export { MemberList, type MembersByNick } from "./entities/MemberList.ts";

// State store + dispatch (M3)
export { StateStore } from "./state/StateStore.ts";
export { Dispatcher } from "./state/dispatch.ts";

// Casemapping + ISUPPORT (M3)
export {
  CaseMapper,
  toCaseMapping,
  DEFAULT_CASE_MAPPING,
  type CaseMapping,
} from "./casemapping/CaseMapper.ts";
export { IrcMap, IrcSet } from "./casemapping/IrcMap.ts";
export {
  parseIsupport,
  isChannelName,
  prefixToMode,
  modeToPrefix,
  EMPTY_ISUPPORT,
  type ISupport,
  type PrefixSpec,
  type ChanModes,
} from "./isupport/parseIsupport.ts";
export {
  parseModeChanges,
  classifyMode,
  type ModeChange,
  type ModeKind,
} from "./protocol/modeParser.ts";

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
export { OutboundQueue, MAX_LINE_BYTES, type OutboundQueueOptions } from "./pipeline/outbound.ts";

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
export {
  whoxQuery,
  parseWhoxReply,
  WHOX_TOKEN,
  WHOX_FIELDS,
  type WhoxReply,
} from "./protocol/whox.ts";
export {
  SaslSession,
  plain,
  external,
  mechanismFor,
  chunkSaslResponse,
  encodeBase64,
  decodeBase64,
  type SaslMechanism,
  type SaslStep,
} from "./protocol/sasl.ts";

// Re-export the message intermediate representation for convenience.
export type { Message, Source, Tags } from "@mojo-jojo/irc-message";
