import type { Message } from "@mojo-jojo/irc-message";
import type {
  AccountEvent,
  ActionEvent,
  AwayEvent,
  BaseEvent,
  BatchEvent,
  ChghostEvent,
  JoinEvent,
  KickEvent,
  ModeEvent,
  NamesEvent,
  NickEvent,
  NoticeEvent,
  PartEvent,
  PrivmsgEvent,
  QuitEvent,
  SetnameEvent,
  StandardReplyEvent,
  TopicEvent,
} from "./types.ts";

// Thin constructors for the event taxonomy. Each stamps the discriminant `type`
// and the {@link BaseEvent} fields (`raw`, `time`, `tags`) so the dispatcher only
// supplies the resolved, event-specific fields. The `Omit<…, keyof BaseEvent |
// "type">` parameter type guarantees, at compile time, that the dispatcher
// provides exactly the right fields for each event.

/** Resolve an event's timestamp: the `server-time` tag if valid, else now. */
export function eventTime(message: Message): Date {
  const tag = message.tags["time"];
  if (tag !== undefined && tag !== "") {
    const date = new Date(tag);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

/** The {@link BaseEvent} fields shared by every protocol event. */
export function baseEvent(message: Message): BaseEvent {
  return { raw: message, time: eventTime(message), tags: message.tags };
}

/** Fields a factory caller must supply: everything except `type` and base fields. */
type Fields<E> = Omit<E, keyof BaseEvent | "type">;

export function privmsgEvent(message: Message, fields: Fields<PrivmsgEvent>): PrivmsgEvent {
  return { type: "privmsg", ...baseEvent(message), ...fields };
}

export function actionEvent(message: Message, fields: Fields<ActionEvent>): ActionEvent {
  return { type: "action", ...baseEvent(message), ...fields };
}

export function noticeEvent(message: Message, fields: Fields<NoticeEvent>): NoticeEvent {
  return { type: "notice", ...baseEvent(message), ...fields };
}

export function joinEvent(message: Message, fields: Fields<JoinEvent>): JoinEvent {
  return { type: "join", ...baseEvent(message), ...fields };
}

export function partEvent(message: Message, fields: Fields<PartEvent>): PartEvent {
  return { type: "part", ...baseEvent(message), ...fields };
}

export function quitEvent(message: Message, fields: Fields<QuitEvent>): QuitEvent {
  return { type: "quit", ...baseEvent(message), ...fields };
}

export function kickEvent(message: Message, fields: Fields<KickEvent>): KickEvent {
  return { type: "kick", ...baseEvent(message), ...fields };
}

export function nickEvent(message: Message, fields: Fields<NickEvent>): NickEvent {
  return { type: "nick", ...baseEvent(message), ...fields };
}

export function accountEvent(message: Message, fields: Fields<AccountEvent>): AccountEvent {
  return { type: "account", ...baseEvent(message), ...fields };
}

export function modeEvent(message: Message, fields: Fields<ModeEvent>): ModeEvent {
  return { type: "mode", ...baseEvent(message), ...fields };
}

export function topicEvent(message: Message, fields: Fields<TopicEvent>): TopicEvent {
  return { type: "topic", ...baseEvent(message), ...fields };
}

export function namesEvent(message: Message, fields: Fields<NamesEvent>): NamesEvent {
  return { type: "names", ...baseEvent(message), ...fields };
}

export function awayEvent(message: Message, fields: Fields<AwayEvent>): AwayEvent {
  return { type: "away", ...baseEvent(message), ...fields };
}

export function chghostEvent(message: Message, fields: Fields<ChghostEvent>): ChghostEvent {
  return { type: "chghost", ...baseEvent(message), ...fields };
}

export function setnameEvent(message: Message, fields: Fields<SetnameEvent>): SetnameEvent {
  return { type: "setname", ...baseEvent(message), ...fields };
}

export function batchEvent(message: Message, fields: Fields<BatchEvent>): BatchEvent {
  return { type: "batch", ...baseEvent(message), ...fields };
}

export function standardReplyEvent(
  message: Message,
  fields: Fields<StandardReplyEvent>,
): StandardReplyEvent {
  return { type: "standardReply", ...baseEvent(message), ...fields };
}
