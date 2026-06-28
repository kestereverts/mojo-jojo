import type { Observable } from "rxjs";
import { ReactiveEntity } from "./ReactiveEntity.ts";
import { MemberList } from "./MemberList.ts";
import type { Server } from "./Server.ts";
import type { ModeChange } from "../protocol/modeParser.ts";
import type {
  AccountEvent,
  ActionEvent,
  AwayEvent,
  ChannelEvent,
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
  TopicEvent,
} from "../events/types.ts";

/**
 * A joined channel: its topic (with who/when set it), its channel modes, and its
 * {@link MemberList}. State is mutated only by the StateStore via the `@internal`
 * methods; consumers read it through the getters and reactive streams.
 */
export class Channel extends ReactiveEntity<ChannelEvent> {
  readonly name: string;
  readonly server: Server;
  readonly members: MemberList;

  #topic: string | null = null;
  #topicSetBy: string | null = null;
  #topicSetAt: Date | null = null;
  /** Non-list channel modes (CHANMODES B/C/D): mode letter -> param (or null). */
  readonly #modes = new Map<string, string | null>();
  /** List channel modes (CHANMODES A, e.g. bans): mode letter -> set of masks. */
  readonly #lists = new Map<string, Set<string>>();

  constructor(name: string, server: Server) {
    super();
    this.name = name;
    this.server = server;
    this.members = new MemberList(server.caseMapper);
  }

  /** Current topic text, or `null` if unset/unknown. */
  get topic(): string | null {
    return this.#topic;
  }
  /** Nick that last set the topic, if known. */
  get topicSetBy(): string | null {
    return this.#topicSetBy;
  }
  /** When the topic was last set, if known. */
  get topicSetAt(): Date | null {
    return this.#topicSetAt;
  }
  /** Non-list channel modes (B/C/D): mode letter -> param (or `null`). */
  get modes(): ReadonlyMap<string, string | null> {
    return this.#modes;
  }
  /** List channel modes (A, e.g. `b` bans): mode letter -> set of masks. */
  get lists(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.#lists;
  }

  /** Messages sent to this channel. */
  get messages$(): Observable<PrivmsgEvent> {
    return this.stream("privmsg");
  }
  get actions$(): Observable<ActionEvent> {
    return this.stream("action");
  }
  get notices$(): Observable<NoticeEvent> {
    return this.stream("notice");
  }
  get joins$(): Observable<JoinEvent> {
    return this.stream("join");
  }
  get parts$(): Observable<PartEvent> {
    return this.stream("part");
  }
  get kicks$(): Observable<KickEvent> {
    return this.stream("kick");
  }
  /** Nick changes of this channel's members (routed to every shared channel). */
  get nickChanges$(): Observable<NickEvent> {
    return this.stream("nick");
  }
  /** Quits by this channel's members (routed just before they are removed). */
  get quits$(): Observable<QuitEvent> {
    return this.stream("quit");
  }
  get topicChanges$(): Observable<TopicEvent> {
    return this.stream("topic");
  }
  get modeChanges$(): Observable<ModeEvent> {
    return this.stream("mode");
  }
  get names$(): Observable<NamesEvent> {
    return this.stream("names");
  }
  /** Account (login/logout) changes for members of this channel (`account-notify`). */
  get accountChanges$(): Observable<AccountEvent> {
    return this.stream("account");
  }
  /** Away/return changes for members of this channel (`away-notify`). */
  get awayChanges$(): Observable<AwayEvent> {
    return this.stream("away");
  }
  /** Username/host changes for members of this channel (`chghost`). */
  get chghost$(): Observable<ChghostEvent> {
    return this.stream("chghost");
  }
  /** Real-name changes for members of this channel (`setname`). */
  get setname$(): Observable<SetnameEvent> {
    return this.stream("setname");
  }

  /** @internal Set the topic and its provenance. */
  setTopic(topic: string | null, setBy: string | null, setAt: Date | null): void {
    this.#topic = topic;
    if (setBy !== null) this.#topicSetBy = setBy;
    if (setAt !== null) this.#topicSetAt = setAt;
  }

  /**
   * @internal Apply one non-prefix channel mode change (CHANMODES A/B/C/D).
   * Prefix (status) modes are applied to the {@link Member} by the dispatcher.
   */
  applyChannelMode(change: ModeChange): void {
    const { mode, param, added, kind } = change;
    if (kind === "A") {
      // List mode (bans etc.): maintain a set of masks.
      if (param === null) return;
      let set = this.#lists.get(mode);
      if (added) {
        if (!set) {
          set = new Set<string>();
          this.#lists.set(mode, set);
        }
        set.add(param);
      } else {
        set?.delete(param);
      }
      return;
    }
    // B/C/D non-list modes.
    if (added) {
      this.#modes.set(mode, param);
    } else {
      this.#modes.delete(mode);
    }
  }
}
