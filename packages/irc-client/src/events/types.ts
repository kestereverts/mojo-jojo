import type { Message, Tags } from "@mojo-jojo/irc-message";
import type { Channel } from "../entities/Channel.ts";
import type { User } from "../entities/User.ts";
import type { Member } from "../entities/Member.ts";
import type { ModeChange } from "../protocol/modeParser.ts";
import type { LifecycleEvent } from "./lifecycle.ts";

// The rich, entity-resolved event taxonomy produced by the dispatcher (M3).
//
// Every protocol event extends {@link BaseEvent}, so it carries the originating
// `raw` {@link Message} (the escape hatch for tags/params the typed shape omits),
// a `time` (from the IRCv3 `server-time` tag when present, else receipt time),
// and the raw `tags`. Connection lifecycle events are a *separate* union (see
// `events/lifecycle.ts`) with no `raw`; M5 unifies both under `ClientEvent` and
// the `.on()` facade. M4/M6 extend this union (account/away/chghost/batch/…).

/** Fields shared by every protocol event. */
export interface BaseEvent {
  /** The raw parsed message this event was derived from. */
  readonly raw: Message;
  /** `server-time` tag as a `Date`, or the receipt time when the tag is absent. */
  readonly time: Date;
  /** The raw IRCv3 message tags. */
  readonly tags: Tags;
}

/** Shared shape of the three "someone said something" events. */
interface MessageLikeEvent extends BaseEvent {
  /** Channel the message was sent to, or `null` for a direct/private message. */
  readonly channel: Channel | null;
  /** Resolved sender, or `null` for a server-sourced notice. */
  readonly user: User | null;
  /** Sender's membership in `channel`, or `null` for PMs / non-members. */
  readonly member: Member | null;
  /** Raw target (a channel name or our nick). */
  readonly target: string;
  /** Message text (CTCP `\x01ACTION …\x01` framing stripped for actions). */
  readonly text: string;
  /** `true` when the target is us, not a channel. */
  readonly isPrivate: boolean;
  /** `account-tag` value, when present. */
  readonly account: string | null;
}

/** A `PRIVMSG`. `user` is always resolved (channel/PM messages carry a nick). */
export interface PrivmsgEvent extends MessageLikeEvent {
  readonly type: "privmsg";
  readonly user: User;
}

/** A CTCP `ACTION` (`/me`), surfaced as its own event per design decision. */
export interface ActionEvent extends MessageLikeEvent {
  readonly type: "action";
  readonly user: User;
}

/** A `NOTICE`. `user` may be `null` for server/pre-registration notices. */
export interface NoticeEvent extends MessageLikeEvent {
  readonly type: "notice";
}

/** A user joined a channel. */
export interface JoinEvent extends BaseEvent {
  readonly type: "join";
  readonly channel: Channel;
  readonly user: User;
  readonly member: Member;
  /** `true` when *we* joined. */
  readonly isSelf: boolean;
  /** `extended-join` account (`*` normalized to `null`), when advertised. */
  readonly account: string | null;
  /** `extended-join` real name, when advertised. */
  readonly realName: string | null;
}

/** A user left a channel. */
export interface PartEvent extends BaseEvent {
  readonly type: "part";
  readonly channel: Channel;
  readonly user: User;
  /** The membership as it was just before removal, or `null` if unknown. */
  readonly member: Member | null;
  readonly isSelf: boolean;
  readonly reason: string | null;
}

/** A user disconnected from the network (affects every shared channel). */
export interface QuitEvent extends BaseEvent {
  readonly type: "quit";
  readonly user: User;
  /** Channels we shared with the user at quit time. */
  readonly channels: readonly Channel[];
  readonly isSelf: boolean;
  readonly reason: string | null;
}

/** A user was kicked from a channel. */
export interface KickEvent extends BaseEvent {
  readonly type: "kick";
  readonly channel: Channel;
  /** The kicked user. */
  readonly target: User;
  /** The kicked user's membership just before removal, or `null`. */
  readonly member: Member | null;
  /** Who performed the kick (the source), or `null` if server-sourced. */
  readonly by: User | null;
  /** `true` when *we* were kicked. */
  readonly isSelf: boolean;
  readonly reason: string | null;
}

/** A user changed nick (affects every shared channel). */
export interface NickEvent extends BaseEvent {
  readonly type: "nick";
  readonly user: User;
  readonly oldNick: string;
  readonly newNick: string;
  readonly channels: readonly Channel[];
  readonly isSelf: boolean;
}

/**
 * A user logged in to or out of a services account (`account-notify`). Affects
 * every channel we share with them.
 */
export interface AccountEvent extends BaseEvent {
  readonly type: "account";
  readonly user: User;
  /** New account name, or `null` when the user logged out (`*`). */
  readonly account: string | null;
  /** Channels we share with the user (the event is routed to each). */
  readonly channels: readonly Channel[];
  readonly isSelf: boolean;
}

/** A channel (or our user) mode changed. */
export interface ModeEvent extends BaseEvent {
  readonly type: "mode";
  /** Raw target (channel name or nick). */
  readonly target: string;
  /** The channel for a channel mode, or `null` for a user mode. */
  readonly channel: Channel | null;
  /** Who set the mode (the source), or `null` if server-sourced. */
  readonly by: User | null;
  /** The resolved, parameter-bound mode changes. */
  readonly changes: readonly ModeChange[];
}

/** A channel topic was set or learned. */
export interface TopicEvent extends BaseEvent {
  readonly type: "topic";
  readonly channel: Channel;
  readonly topic: string | null;
  /** Who set it (live `TOPIC` source), or `null` when learned via 332/333. */
  readonly setBy: User | null;
  /** `true` when learned from the `332` reply on join, `false` for a live change. */
  readonly isInitial: boolean;
}

/** A channel's member list was (re)learned via `353`/`366`. */
export interface NamesEvent extends BaseEvent {
  readonly type: "names";
  readonly channel: Channel;
  readonly members: readonly Member[];
}

/**
 * A user's away status changed (`away-notify`). `away` is `true` when they went
 * away (with the `message` reason), `false` when they returned (`message` null).
 */
export interface AwayEvent extends BaseEvent {
  readonly type: "away";
  readonly user: User;
  readonly away: boolean;
  readonly message: string | null;
  /** Channels we share with the user (the event is routed to each). */
  readonly channels: readonly Channel[];
  readonly isSelf: boolean;
}

/** A user's username/host changed without reconnecting (`chghost`). */
export interface ChghostEvent extends BaseEvent {
  readonly type: "chghost";
  readonly user: User;
  readonly newUser: string;
  readonly newHost: string;
  readonly channels: readonly Channel[];
  readonly isSelf: boolean;
}

/** A user changed their real name (`setname`). */
export interface SetnameEvent extends BaseEvent {
  readonly type: "setname";
  readonly user: User;
  readonly realName: string;
  readonly channels: readonly Channel[];
  readonly isSelf: boolean;
}

/**
 * A completed `BATCH` (P2): the reassembled group of messages received between
 * `BATCH +ref` and `BATCH -ref`. The inner messages also dispatch normally (so
 * state stays correct for unknown batch types); this event additionally exposes
 * them as one logical unit (e.g. a `netjoin`, `chathistory`, or labeled batch).
 */
export interface BatchEvent extends BaseEvent {
  readonly type: "batch";
  /** The batch's reference tag (the identifier after `+`/`-`). */
  readonly reference: string;
  /** The batch type token (e.g. `netjoin`, `chathistory`, `labeled-response`). */
  readonly batchType: string;
  /** Any parameters that followed the type on the `BATCH +` line. */
  readonly params: readonly string[];
  /** The raw messages collected inside the batch (control lines excluded). */
  readonly messages: readonly Message[];
}

/**
 * A standard reply (`FAIL`/`WARN`/`NOTE`): a machine-readable status message for
 * a command. Carries the subject `command`, a `code`, any `context` params, and a
 * human-readable `text`. Surfaced on the firehose only (not entity-scoped).
 */
export interface StandardReplyEvent extends BaseEvent {
  readonly type: "standardReply";
  readonly replyType: "FAIL" | "WARN" | "NOTE";
  /** The command the reply concerns, or `*` when general. */
  readonly command: string;
  /** Machine-readable code (e.g. `ACCOUNT_REQUIRED`). */
  readonly code: string;
  /** Extra context params between the code and the description. */
  readonly context: readonly string[];
  /** Human-readable description (the trailing param). */
  readonly text: string;
}

/** Discriminated union of every entity-resolved protocol event (M3 + M4 + M6). */
export type IrcEvent =
  | PrivmsgEvent
  | ActionEvent
  | NoticeEvent
  | JoinEvent
  | PartEvent
  | QuitEvent
  | KickEvent
  | NickEvent
  | AccountEvent
  | AwayEvent
  | ChghostEvent
  | SetnameEvent
  | ModeEvent
  | TopicEvent
  | NamesEvent
  | BatchEvent
  | StandardReplyEvent;

/** The events routed into a {@link User}'s per-entity stream. */
export type UserEvent =
  | PrivmsgEvent
  | ActionEvent
  | NoticeEvent
  | NickEvent
  | AccountEvent
  | AwayEvent
  | ChghostEvent
  | SetnameEvent
  | QuitEvent;

/** The events routed into a {@link Channel}'s per-entity stream. */
export type ChannelEvent =
  | PrivmsgEvent
  | ActionEvent
  | NoticeEvent
  | JoinEvent
  | PartEvent
  | QuitEvent
  | KickEvent
  | NickEvent
  | AccountEvent
  | AwayEvent
  | ChghostEvent
  | SetnameEvent
  | ModeEvent
  | TopicEvent
  | NamesEvent;

/**
 * The unified top-level event surface (M5): every entity-resolved protocol event
 * plus every connection {@link LifecycleEvent}. This is what the `IrcClient`
 * `.on()`/`.once()`/`.off()` facade and the `clientEvents$` firehose range over,
 * so a single subscription can observe both `"privmsg"` and `"registered"`. The
 * two unions share no `type` discriminant, so narrowing stays unambiguous.
 */
export type ClientEvent = IrcEvent | LifecycleEvent;
