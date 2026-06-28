import type { Message, Source } from "@mojo-jojo/irc-message";
import type { StateStore } from "./StateStore.ts";
import type { IrcEvent } from "../events/types.ts";
import { EMIT } from "../entities/internal.ts";
import { isChannelName } from "../isupport/parseIsupport.ts";
import { parseModeChanges, type ModeChange } from "../protocol/modeParser.ts";
import * as numerics from "../protocol/numerics.ts";
import * as factory from "../events/factory.ts";

// The dispatcher: one connection's `Message` -> entity-resolved {@link IrcEvent}
// translator. Each handler mutates the {@link StateStore}, routes the event into
// the relevant per-entity streams (via the symbol-keyed {@link EMIT}), and
// returns it for the global firehose. Unhandled commands return `null` (they
// remain visible on the raw `messages$`).

const CTCP = "\x01";

/** Strip CTCP `\x01ACTION …\x01` framing; returns the action text or `null`. */
function parseActionText(text: string): string | null {
  if (!text.startsWith(CTCP + "ACTION")) return null;
  let inner = text.slice(1);
  if (inner.endsWith(CTCP)) inner = inner.slice(0, -1);
  if (inner === "ACTION") return "";
  if (inner.startsWith("ACTION ")) return inner.slice("ACTION ".length);
  return null;
}

/** One token from a `353` NAMES list, split into status prefixes + identity. */
interface NamesEntry {
  prefixChars: string;
  nick: string;
  user?: string;
  host?: string;
}

/** An open `BATCH` being reassembled (M6). */
interface OpenBatch {
  readonly batchType: string;
  readonly params: readonly string[];
  readonly messages: Message[];
}

/**
 * Bounds on retained batch state so a server that opens batches but never sends
 * the matching `BATCH -` (malformed or hostile) can't grow memory without limit.
 * Inner messages always dispatch regardless; only the (optional) reassembled
 * grouping is capped. Generous enough not to clip a real netjoin/chathistory.
 */
const MAX_OPEN_BATCHES = 64;
const MAX_BATCH_MESSAGES = 4096;

export class Dispatcher {
  readonly #store: StateStore;
  /** Open batches by reference tag; entries collect their tagged messages (M6). */
  readonly #batches = new Map<string, OpenBatch>();

  constructor(store: StateStore) {
    this.#store = store;
  }

  /** Translate one inbound message, mutating state and routing entity events. */
  dispatch(message: Message): IrcEvent | null {
    // BATCH reassembly (P2): if this message belongs to an open batch, collect it.
    // It still dispatches normally below — per the spec, a client processes a
    // batch's messages even when it doesn't recognise the batch type; the
    // collected group is additionally surfaced as a BatchEvent when it closes.
    const batchRef = message.tags["batch"];
    if (batchRef !== undefined) {
      const batch = this.#batches.get(batchRef);
      // Cap per-batch retention; over the limit the message still dispatches but
      // is no longer collected for the BatchEvent.
      if (batch && batch.messages.length < MAX_BATCH_MESSAGES) batch.messages.push(message);
    }

    switch (message.command) {
      case numerics.RPL_WELCOME:
        return this.#welcome(message);
      case numerics.RPL_ISUPPORT:
        return this.#isupport(message);
      case numerics.RPL_TOPIC:
      case numerics.RPL_NOTOPIC:
        return this.#topicReply(message);
      case numerics.RPL_TOPICWHOTIME:
        return this.#topicWhoTime(message);
      case numerics.RPL_NAMREPLY:
        return this.#namreply(message);
      case numerics.RPL_ENDOFNAMES:
        return this.#endOfNames(message);
      case "JOIN":
        return this.#join(message);
      case "PART":
        return this.#part(message);
      case "QUIT":
        return this.#quit(message);
      case "KICK":
        return this.#kick(message);
      case "NICK":
        return this.#nick(message);
      case "ACCOUNT":
        return this.#account(message);
      case "AWAY":
        return this.#away(message);
      case "CHGHOST":
        return this.#chghost(message);
      case "SETNAME":
        return this.#setname(message);
      case "MODE":
        return this.#mode(message);
      case "TOPIC":
        return this.#topic(message);
      case "PRIVMSG":
        return this.#privmsg(message);
      case "NOTICE":
        return this.#notice(message);
      case "BATCH":
        return this.#batch(message);
      case "FAIL":
        return this.#standardReply(message, "FAIL");
      case "WARN":
        return this.#standardReply(message, "WARN");
      case "NOTE":
        return this.#standardReply(message, "NOTE");
      case numerics.RPL_WHOREPLY:
        return this.#whoReply(message);
      default:
        return null;
    }
  }

  /**
   * Does this source identify a user (nick) rather than a server? A user prefix
   * always carries a `user` and/or `host` component; a bare name (no user, no
   * host) is the server itself or a service pseudo-source — true even for
   * pre-registration notices (`:irc NOTICE * :…`) that arrive before we learn
   * the server name, which must not create phantom users.
   */
  #isUserSource(source: Source): boolean {
    return source.user !== undefined || source.host !== undefined;
  }

  // ---- registration burst ----

  #welcome(message: Message): null {
    if (message.source !== null) this.#store.server.setName(message.source.name);
    const nick = message.params[0];
    if (nick !== undefined) this.#store.markSelf(nick);
    return null;
  }

  #isupport(message: Message): null {
    // params: <nick> <token>... :are supported by this server
    const tokens = message.params.slice(1, Math.max(1, message.params.length - 1));
    this.#store.applyIsupport(tokens);
    return null;
  }

  // ---- topic ----

  /** Handle both `332` (RPL_TOPIC) and `331` (RPL_NOTOPIC). */
  #topicReply(message: Message): IrcEvent | null {
    const name = message.params[1];
    if (name === undefined) return null;
    const channel = this.#store.getOrCreateChannel(name);
    const topic = message.command === numerics.RPL_TOPIC ? (message.params[2] ?? null) : null;
    channel.setTopic(topic, null, null);
    const event = factory.topicEvent(message, { channel, topic, setBy: null, isInitial: true });
    channel[EMIT](event);
    return event;
  }

  /** `333` RPL_TOPICWHOTIME: who set the current topic, and when. */
  #topicWhoTime(message: Message): null {
    const name = message.params[1];
    if (name === undefined) return null;
    const channel = this.#store.channel(name);
    if (!channel) return null;
    const setBy = message.params[2] ?? null;
    const unix = Number(message.params[3]);
    const setAt = Number.isFinite(unix) ? new Date(unix * 1000) : null;
    channel.setTopic(channel.topic, setBy, setAt);
    return null;
  }

  // ---- names ----

  #namreply(message: Message): null {
    // params: <nick> <symbol> <channel> :<name list>
    const name = message.params[2];
    const list = message.params[3];
    if (name === undefined || list === undefined) return null;
    const channel = this.#store.getOrCreateChannel(name);
    for (const token of list.split(" ")) {
      if (token === "") continue;
      const entry = this.#splitNamesEntry(token);
      const user = this.#store.getOrCreateUser(entry.nick);
      if (entry.user !== undefined || entry.host !== undefined) {
        user.updateFromSource({ name: entry.nick, user: entry.user, host: entry.host });
      }
      const member = this.#store.addMember(channel, user);
      member.applyPrefixChars(entry.prefixChars);
    }
    return null;
  }

  #endOfNames(message: Message): IrcEvent | null {
    const name = message.params[1];
    if (name === undefined) return null;
    const channel = this.#store.channel(name);
    if (!channel) return null;
    const event = factory.namesEvent(message, { channel, members: [...channel.members] });
    channel[EMIT](event);
    return event;
  }

  #splitNamesEntry(token: string): NamesEntry {
    const prefixSet = new Set(this.#store.server.isupport.prefixes.map((p) => p.prefix));
    let i = 0;
    while (i < token.length && prefixSet.has(token[i]!)) i++;
    const prefixChars = token.slice(0, i);
    const rest = token.slice(i);
    // userhost-in-names: nick!user@host
    const bang = rest.indexOf("!");
    const at = rest.indexOf("@");
    if (bang !== -1 && at > bang) {
      return {
        prefixChars,
        nick: rest.slice(0, bang),
        user: rest.slice(bang + 1, at),
        host: rest.slice(at + 1),
      };
    }
    return { prefixChars, nick: rest };
  }

  // ---- membership ----

  #join(message: Message): IrcEvent | null {
    const source = message.source;
    const name = message.params[0];
    if (source === null || name === undefined) return null;

    const channel = this.#store.getOrCreateChannel(name);
    const user = this.#store.getOrCreateUser(source.name);
    user.updateFromSource(source);

    // extended-join: JOIN <channel> <account> :<realname>
    let account: string | null = null;
    let realName: string | null = null;
    if (message.params.length >= 3) {
      const rawAccount = message.params[1] ?? "";
      account = rawAccount === "*" || rawAccount === "" ? null : rawAccount;
      realName = message.params[2] ?? null;
      user.setAccount(rawAccount);
      user.setRealName(realName);
    }

    const member = this.#store.addMember(channel, user);
    const event = factory.joinEvent(message, {
      channel,
      user,
      member,
      isSelf: this.#store.isSelf(source.name),
      account,
      realName,
    });
    channel[EMIT](event);
    return event;
  }

  #part(message: Message): IrcEvent | null {
    const source = message.source;
    const name = message.params[0];
    if (source === null || name === undefined) return null;
    const channel = this.#store.channel(name);
    if (!channel) return null;

    const user = this.#store.getOrCreateUser(source.name);
    const member = channel.members.get(source.name) ?? null;
    const isSelf = this.#store.isSelf(source.name);
    const event = factory.partEvent(message, {
      channel,
      user,
      member,
      isSelf,
      reason: message.params[1] ?? null,
    });
    // Route before any disposal so the event is delivered.
    channel[EMIT](event);

    if (isSelf) {
      // We left: drop the channel, then GC members we no longer share with.
      const formerMembers = [...channel.members];
      this.#store.removeChannel(name);
      for (const m of formerMembers) this.#store.pruneOrphan(m.nick);
    } else {
      channel.members.remove(source.name);
      this.#store.pruneOrphan(source.name);
    }
    return event;
  }

  #quit(message: Message): IrcEvent | null {
    const source = message.source;
    if (source === null) return null;
    const user = this.#store.user(source.name);
    if (!user) return null;

    const channels = this.#store.channelsWithUser(source.name);
    const event = factory.quitEvent(message, {
      user,
      channels,
      isSelf: this.#store.isSelf(source.name),
      reason: message.params[0] ?? null,
    });
    // Route to the user and every shared channel before removal/dispose.
    for (const channel of channels) channel[EMIT](event);
    user[EMIT](event);

    this.#store.removeUser(source.name);
    return event;
  }

  #kick(message: Message): IrcEvent | null {
    const source = message.source;
    const name = message.params[0];
    const targetNick = message.params[1];
    if (name === undefined || targetNick === undefined) return null;
    const channel = this.#store.channel(name);
    if (!channel) return null;

    const target = this.#store.getOrCreateUser(targetNick);
    const member = channel.members.get(targetNick) ?? null;
    const by =
      source !== null && this.#isUserSource(source)
        ? this.#store.getOrCreateUser(source.name)
        : null;
    const isSelf = this.#store.isSelf(targetNick);
    const event = factory.kickEvent(message, {
      channel,
      target,
      member,
      by,
      isSelf,
      reason: message.params[2] ?? null,
    });
    channel[EMIT](event);

    if (isSelf) {
      const formerMembers = [...channel.members];
      this.#store.removeChannel(name);
      for (const m of formerMembers) this.#store.pruneOrphan(m.nick);
    } else {
      channel.members.remove(targetNick);
      this.#store.pruneOrphan(targetNick);
    }
    return event;
  }

  #nick(message: Message): IrcEvent | null {
    const source = message.source;
    const newNick = message.params[0];
    if (source === null || newNick === undefined) return null;
    const oldNick = source.name;
    const renamed = this.#store.renameUser(oldNick, newNick);
    if (!renamed) return null;

    const event = factory.nickEvent(message, {
      user: renamed.user,
      oldNick,
      newNick,
      channels: renamed.channels,
      isSelf: renamed.user.isSelf,
    });
    renamed.user[EMIT](event);
    for (const channel of renamed.channels) channel[EMIT](event);
    return event;
  }

  /**
   * `account-notify`: `:nick!user@host ACCOUNT <account>` (`*` = logged out).
   * Updates the user's account and routes an {@link AccountEvent} to the user and
   * every channel we share with them. Ignored for untracked users.
   */
  #account(message: Message): IrcEvent | null {
    const source = message.source;
    if (source === null || !this.#isUserSource(source)) return null;
    const user = this.#store.user(source.name);
    if (!user) return null;
    user.updateFromSource(source);
    user.setAccount(message.params[0] ?? "*");
    const channels = this.#store.channelsWithUser(source.name);
    const event = factory.accountEvent(message, {
      user,
      account: user.account,
      channels,
      isSelf: this.#store.isSelf(source.name),
    });
    user[EMIT](event);
    for (const channel of channels) channel[EMIT](event);
    return event;
  }

  /**
   * `away-notify`: `:nick!u@h AWAY [:message]`. A present message means the user
   * is now away; an absent one means they returned. Routes to the user + shared
   * channels. Ignored for untracked users.
   */
  #away(message: Message): IrcEvent | null {
    const source = message.source;
    if (source === null || !this.#isUserSource(source)) return null;
    const user = this.#store.user(source.name);
    if (!user) return null;
    user.updateFromSource(source);
    const reason = message.params[0] ?? null;
    const away = reason !== null;
    user.setAway(away);
    const channels = this.#store.channelsWithUser(source.name);
    const event = factory.awayEvent(message, {
      user,
      away,
      message: reason,
      channels,
      isSelf: this.#store.isSelf(source.name),
    });
    user[EMIT](event);
    for (const channel of channels) channel[EMIT](event);
    return event;
  }

  /**
   * `chghost`: `:nick!olduser@oldhost CHGHOST <newuser> <newhost>`. Updates the
   * user's username/host in place. Ignored for untracked users.
   */
  #chghost(message: Message): IrcEvent | null {
    const source = message.source;
    if (source === null || !this.#isUserSource(source)) return null;
    const user = this.#store.user(source.name);
    if (!user) return null;
    const newUser = message.params[0];
    const newHost = message.params[1];
    if (newUser === undefined || newHost === undefined) return null;
    user.updateFromSource({ name: source.name, user: newUser, host: newHost });
    const channels = this.#store.channelsWithUser(source.name);
    const event = factory.chghostEvent(message, {
      user,
      newUser,
      newHost,
      channels,
      isSelf: this.#store.isSelf(source.name),
    });
    user[EMIT](event);
    for (const channel of channels) channel[EMIT](event);
    return event;
  }

  /** `setname`: `:nick!u@h SETNAME :<realname>`. Updates the user's real name. */
  #setname(message: Message): IrcEvent | null {
    const source = message.source;
    if (source === null || !this.#isUserSource(source)) return null;
    const user = this.#store.user(source.name);
    if (!user) return null;
    user.updateFromSource(source);
    const realName = message.params[0] ?? "";
    user.setRealName(realName);
    const channels = this.#store.channelsWithUser(source.name);
    const event = factory.setnameEvent(message, {
      user,
      realName,
      channels,
      isSelf: this.#store.isSelf(source.name),
    });
    user[EMIT](event);
    for (const channel of channels) channel[EMIT](event);
    return event;
  }

  /**
   * `BATCH +ref type [params]` opens a batch; `BATCH -ref` closes it and emits a
   * {@link BatchEvent} with the reassembled messages. Inner messages were already
   * collected (and dispatched) as they arrived. Unknown/unopened refs are no-ops.
   */
  #batch(message: Message): IrcEvent | null {
    const token = message.params[0];
    if (token === undefined || token.length < 1) return null;
    const reference = token.slice(1);
    if (token[0] === "+") {
      // Bound the number of concurrently-open batches; past the cap we don't
      // track this one (its inner messages still dispatch, the close is a no-op).
      if (this.#batches.size >= MAX_OPEN_BATCHES) return null;
      this.#batches.set(reference, {
        batchType: message.params[1] ?? "",
        params: message.params.slice(2),
        messages: [],
      });
      return null;
    }
    if (token[0] === "-") {
      const batch = this.#batches.get(reference);
      if (!batch) return null;
      this.#batches.delete(reference);
      return factory.batchEvent(message, {
        reference,
        batchType: batch.batchType,
        params: batch.params,
        messages: batch.messages,
      });
    }
    return null;
  }

  /**
   * Standard replies `FAIL`/`WARN`/`NOTE`:
   * `<verb> <command> <code> [<context>...] :<description>`. Firehose-only.
   */
  #standardReply(message: Message, replyType: "FAIL" | "WARN" | "NOTE"): IrcEvent {
    const params = message.params;
    const command = params[0] ?? "*";
    const code = params[1] ?? "";
    const text = params.length > 2 ? (params[params.length - 1] ?? "") : "";
    const context = params.length > 3 ? params.slice(2, -1) : [];
    return factory.standardReplyEvent(message, { replyType, command, code, context, text });
  }

  /**
   * `352` RPL_WHOREPLY: `<me> <channel> <user> <host> <server> <nick> <flags>
   * :<hopcount> <realname>`. Enriches an already-known user (host/user/realname,
   * and the away flag from `G`); does not create users from WHO output.
   */
  #whoReply(message: Message): null {
    const nick = message.params[5];
    if (nick === undefined) return null;
    const user = this.#store.user(nick);
    if (!user) return null;
    user.updateFromSource({ name: nick, user: message.params[2], host: message.params[3] });
    const flags = message.params[6];
    if (flags !== undefined) user.setAway(flags.includes("G"));
    const trailing = message.params[7];
    if (trailing !== undefined) {
      const space = trailing.indexOf(" ");
      const realName = space === -1 ? "" : trailing.slice(space + 1);
      if (realName !== "") user.setRealName(realName);
    }
    return null;
  }

  #mode(message: Message): IrcEvent | null {
    const target = message.params[0];
    const modeString = message.params[1];
    if (target === undefined || modeString === undefined) return null;
    const source = message.source;
    const by =
      source !== null && this.#isUserSource(source)
        ? this.#store.getOrCreateUser(source.name)
        : null;

    if (!isChannelName(target, this.#store.server.isupport)) {
      // User mode: no params, no channel; track as a simple change list.
      const changes = this.#parseUserModes(modeString);
      return factory.modeEvent(message, { target, channel: null, by, changes });
    }

    const channel = this.#store.getOrCreateChannel(target);
    const changes = parseModeChanges(modeString, message.params.slice(2), this.#store.server.isupport);
    for (const change of changes) {
      if (change.kind === "prefix") {
        if (change.param === null) continue;
        const member = channel.members.get(change.param);
        if (!member) continue;
        if (change.added) member.addMode(change.mode);
        else member.removeMode(change.mode);
      } else {
        channel.applyChannelMode(change);
      }
    }
    const event = factory.modeEvent(message, { target, channel, by, changes });
    channel[EMIT](event);
    return event;
  }

  #parseUserModes(modeString: string): ModeChange[] {
    const changes: ModeChange[] = [];
    let added = true;
    for (const char of modeString) {
      if (char === "+") added = true;
      else if (char === "-") added = false;
      else changes.push({ added, mode: char, param: null, kind: "D" });
    }
    return changes;
  }

  #topic(message: Message): IrcEvent | null {
    const source = message.source;
    const name = message.params[0];
    if (name === undefined) return null;
    const channel = this.#store.getOrCreateChannel(name);
    const topic = message.params[1] ?? null;
    const setBy =
      source !== null && this.#isUserSource(source)
        ? this.#store.getOrCreateUser(source.name)
        : null;
    channel.setTopic(topic, setBy?.nick ?? null, factory.eventTime(message));
    const event = factory.topicEvent(message, { channel, topic, setBy, isInitial: false });
    channel[EMIT](event);
    return event;
  }

  // ---- messages ----

  #privmsg(message: Message): IrcEvent | null {
    const source = message.source;
    if (source === null || !this.#isUserSource(source)) return null;
    const target = message.params[0];
    const text = message.params[1];
    if (target === undefined || text === undefined) return null;

    const user = this.#store.getOrCreateUser(source.name);
    user.updateFromSource(source);
    const account = message.tags["account"] ?? null;
    if (account !== null) user.setAccount(account);
    const isChannel = isChannelName(target, this.#store.server.isupport);
    const channel = isChannel ? (this.#store.channel(target) ?? null) : null;
    const member = channel?.members.get(source.name) ?? null;

    const actionText = parseActionText(text);
    const fields = {
      channel,
      user,
      member,
      target,
      isPrivate: !isChannel,
      account,
    };
    const event =
      actionText !== null
        ? factory.actionEvent(message, { ...fields, text: actionText })
        : factory.privmsgEvent(message, { ...fields, text });
    channel?.[EMIT](event);
    user[EMIT](event);
    return event;
  }

  #notice(message: Message): IrcEvent | null {
    const source = message.source;
    const target = message.params[0];
    const text = message.params[1];
    if (target === undefined || text === undefined) return null;

    const user =
      source !== null && this.#isUserSource(source)
        ? this.#store.getOrCreateUser(source.name)
        : null;
    const account = message.tags["account"] ?? null;
    if (user !== null && source !== null) {
      user.updateFromSource(source);
      if (account !== null) user.setAccount(account);
    }
    const isChannel = isChannelName(target, this.#store.server.isupport);
    const channel = isChannel ? (this.#store.channel(target) ?? null) : null;
    const member = user !== null ? (channel?.members.get(user.nick) ?? null) : null;

    const event = factory.noticeEvent(message, {
      channel,
      user,
      member,
      target,
      text,
      isPrivate: !isChannel,
      account,
    });
    channel?.[EMIT](event);
    user?.[EMIT](event);
    return event;
  }
}
