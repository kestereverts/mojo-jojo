import { Server } from "../entities/Server.ts";
import { Channel } from "../entities/Channel.ts";
import { User } from "../entities/User.ts";
import { Member } from "../entities/Member.ts";
import { DISPOSE } from "../entities/internal.ts";

// The single writer for connection state. Owns the {@link Server} aggregate and
// provides the get-or-create / rename / remove operations the dispatcher uses to
// keep entities live. Entity *event* routing is the dispatcher's job; the store
// only mutates state and disposes entity streams on removal.

/**
 * Hard ceiling on tracked channels. A bot drives its own joins, so a few
 * thousand never clips real use; it only stops a hostile server from forcing
 * unbounded channel allocation (e.g. forged `:<ournick> JOIN #fakeN` floods —
 * the source nick is forgeable, so an `isSelf` check alone is not a memory bound).
 */
export const MAX_CHANNELS = 4096;

export class StateStore {
  readonly server: Server;

  constructor(nick: string) {
    this.server = new Server(nick);
  }

  /** True when `nick` is us, under the active casemapping. */
  isSelf(nick: string): boolean {
    return this.server.caseMapper.equals(nick, this.server.nick);
  }

  user(nick: string): User | undefined {
    return this.server.users.get(nick);
  }

  channel(name: string): Channel | undefined {
    return this.server.channels.get(name);
  }

  /** Set our authoritative nick (from `001`) and ensure our own {@link User}. */
  markSelf(nick: string): User {
    this.server.setNick(nick);
    return this.getOrCreateUser(nick);
  }

  /** Apply a `005` line's ISUPPORT tokens (handles casemapping re-keying). */
  applyIsupport(tokens: readonly string[]): void {
    // A casemapping change can collide two distinct names into one; dispose the
    // entities the rekey displaced so their streams complete (no leak).
    const { channels, users } = this.server.applyIsupport(tokens);
    for (const channel of channels) {
      // Dispose the displaced channel, then GC any member left with no remaining
      // channel (same discipline as a self-PART/KICK), so users that lived only
      // in the disposed channel don't linger with a live stream.
      const formerMembers = [...channel.members];
      channel[DISPOSE]();
      for (const member of formerMembers) this.pruneOrphan(member.nick);
    }
    for (const user of users) {
      // The per-channel member maps rekey independently of the global user map, so
      // a surviving channel can still hold a Member that references this displaced
      // (loser) user. Drop those by object identity so no disposed user remains
      // reachable from channel state. (A mid-session casemapping collision thus
      // drops the membership rather than merging the two identities — an identity
      // merge is out of scope for this non-conformant case; the surviving user
      // stays tracked in `users`.)
      for (const channel of this.server.channels.values()) {
        for (const member of [...channel.members]) {
          if (member.user === user) channel.members.remove(member.nick);
        }
      }
      user[DISPOSE]();
    }
  }

  getOrCreateUser(nick: string): User {
    const existing = this.server.users.get(nick);
    if (existing) return existing;
    const user = new User(nick, this.isSelf(nick));
    this.server.users.set(nick, user);
    return user;
  }

  /**
   * Get the channel, creating it if absent — unless we're at {@link MAX_CHANNELS},
   * in which case a brand-new channel is refused (returns `undefined`) so a
   * hostile server can't grow the channel map without bound. Existing channels
   * are always returned.
   */
  getOrCreateChannel(name: string): Channel | undefined {
    const existing = this.server.channels.get(name);
    if (existing) return existing;
    if (this.server.channels.size >= MAX_CHANNELS) return undefined;
    const channel = new Channel(name, this.server);
    this.server.channels.set(name, channel);
    return channel;
  }

  /** Remove and dispose a channel (e.g. when we part/are kicked). */
  removeChannel(name: string): Channel | undefined {
    const channel = this.server.channels.get(name);
    if (!channel) return undefined;
    this.server.channels.delete(name);
    channel[DISPOSE]();
    return channel;
  }

  /** Get-or-create the membership of `user` in `channel`. */
  addMember(channel: Channel, user: User): Member {
    const existing = channel.members.get(user.nick);
    if (existing) return existing;
    const member = new Member(user, channel);
    channel.members.add(member);
    return member;
  }

  /** Every joined channel that currently lists `nick` as a member. */
  channelsWithUser(nick: string): Channel[] {
    const result: Channel[] = [];
    for (const channel of this.server.channels.values()) {
      if (channel.members.has(nick)) result.push(channel);
    }
    return result;
  }

  /**
   * Remove a user from every channel and from the global map, then dispose its
   * stream. Callers must route any final event (e.g. QUIT) to the user/channels
   * *before* calling this, since dispose completes the user's stream.
   */
  removeUser(nick: string): void {
    const user = this.server.users.get(nick);
    if (!user) return;
    for (const channel of this.channelsWithUser(nick)) channel.members.remove(nick);
    this.server.users.delete(nick);
    user[DISPOSE]();
  }

  /**
   * Remove a user that no longer shares any channel with us (and isn't us),
   * freeing memory and completing its streams. A no-op for self or still-shared
   * users. Call after a member leaves (PART/KICK) or a channel is removed so the
   * global users map doesn't grow without bound over a long session.
   */
  pruneOrphan(nick: string): void {
    if (this.isSelf(nick)) return;
    if (this.channelsWithUser(nick).length > 0) return;
    this.removeUser(nick);
  }

  /**
   * Dispose every entity's stream — used on connection teardown (drop, reconnect,
   * or quit) so subscribers to entity references from the dead connection receive
   * completion instead of hanging.
   */
  disposeAll(): void {
    for (const channel of this.server.channels.values()) channel[DISPOSE]();
    for (const user of this.server.users.values()) user[DISPOSE]();
  }

  /**
   * Re-key a user after a `NICK` change across the global map and every channel
   * membership. If the user is us, our authoritative nick is updated too.
   * Returns the affected user and channels, or `undefined` if unknown.
   */
  renameUser(oldNick: string, newNick: string): { user: User; channels: Channel[] } | undefined {
    const user = this.server.users.get(oldNick);
    if (!user) return undefined;

    // Nick collision (a non-conformant server: nicks are supposed to be unique).
    // Renaming onto a *different* live user would otherwise silently overwrite it,
    // leaking its stream (never completed) and conflating two identities.
    const displaced = this.server.users.get(newNick);
    if (displaced !== undefined && displaced !== user) {
      // Never let a rename clobber our own self identity (e.g. `:alice NICK us`).
      if (this.isSelf(newNick)) return undefined;
      // Otherwise dispose the displaced user before the nick is reused.
      for (const channel of this.channelsWithUser(newNick)) channel.members.remove(newNick);
      this.server.users.delete(newNick);
      displaced[DISPOSE]();
    }

    const wasSelf = this.isSelf(oldNick);
    const channels = this.channelsWithUser(oldNick);

    this.server.users.delete(oldNick);
    user.rename(newNick);
    this.server.users.set(newNick, user);
    for (const channel of channels) channel.members.rename(oldNick, newNick);
    if (wasSelf) this.server.setNick(newNick);

    return { user, channels };
  }
}
