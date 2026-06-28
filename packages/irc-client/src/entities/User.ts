import type { Observable } from "rxjs";
import type { Source } from "@mojo-jojo/irc-message";
import { ReactiveEntity } from "./ReactiveEntity.ts";
import type {
  ActionEvent,
  NickEvent,
  NoticeEvent,
  PrivmsgEvent,
  QuitEvent,
  UserEvent,
} from "../events/types.ts";

/**
 * A single network identity (one per nick, case-insensitively). Tracks the
 * user's current nick and the latest `user`/`host`/`realName`/`account` learned
 * from any message. Distinct from {@link "./Member.ts" | Member}, which is this
 * user's membership in one specific channel.
 *
 * State is mutated only by the StateStore via the `@internal` methods.
 */
export class User extends ReactiveEntity<UserEvent> {
  #nick: string;
  #username: string | null = null;
  #host: string | null = null;
  #realName: string | null = null;
  #account: string | null = null;
  #away = false;
  readonly #isSelf: boolean;

  constructor(nick: string, isSelf = false) {
    super();
    this.#nick = nick;
    this.#isSelf = isSelf;
  }

  /** Current nickname (display case). */
  get nick(): string {
    return this.#nick;
  }
  /** Username / ident, if learned. */
  get username(): string | null {
    return this.#username;
  }
  /** Hostname, if learned. */
  get host(): string | null {
    return this.#host;
  }
  /** Real name (GECOS), if learned (extended-join / WHO). */
  get realName(): string | null {
    return this.#realName;
  }
  /** Services account name, if known (`account-tag` / extended-join / M4). */
  get account(): string | null {
    return this.#account;
  }
  /** Whether the user is marked away (populated once away-notify lands in M4). */
  get away(): boolean {
    return this.#away;
  }
  /** `true` if this identity is us. */
  get isSelf(): boolean {
    return this.#isSelf;
  }

  /** Messages this user sent. */
  get messages$(): Observable<PrivmsgEvent> {
    return this.stream("privmsg");
  }
  /** CTCP actions (`/me`) this user sent. */
  get actions$(): Observable<ActionEvent> {
    return this.stream("action");
  }
  /** Notices this user sent. */
  get notices$(): Observable<NoticeEvent> {
    return this.stream("notice");
  }
  /** This user's nick changes. */
  get nickChanges$(): Observable<NickEvent> {
    return this.stream("nick");
  }
  /** This user quitting the network. */
  get quit$(): Observable<QuitEvent> {
    return this.stream("quit");
  }

  /** @internal Update the current nick (on `NICK`). */
  rename(nick: string): void {
    this.#nick = nick;
  }

  /** @internal Fill in user/host from a message {@link Source} when present. */
  updateFromSource(source: Source): void {
    if (source.user !== undefined) this.#username = source.user;
    if (source.host !== undefined) this.#host = source.host;
  }

  /** @internal Set the real name (extended-join / WHO). */
  setRealName(realName: string | null): void {
    this.#realName = realName;
  }

  /** @internal Set the services account (`*`/empty means logged out). */
  setAccount(account: string | null): void {
    this.#account = account === "" || account === "*" ? null : account;
  }

  /** @internal Set the away flag (M4 away-notify). */
  setAway(away: boolean): void {
    this.#away = away;
  }
}
