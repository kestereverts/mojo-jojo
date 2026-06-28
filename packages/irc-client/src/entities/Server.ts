import { CaseMapper } from "../casemapping/CaseMapper.ts";
import { IrcMap } from "../casemapping/IrcMap.ts";
import { EMPTY_ISUPPORT, parseIsupport, type ISupport } from "../isupport/parseIsupport.ts";
import type { Channel } from "./Channel.ts";
import type { User } from "./User.ts";

/**
 * The root state aggregate for one connection: our nick, the typed
 * {@link ISupport} (accumulated from `005`), the active {@link CaseMapper}, the
 * enabled caps, and the case-insensitive {@link IrcMap}s of joined channels and
 * known users. Owned and mutated by the StateStore via the `@internal` methods.
 */
export class Server {
  #nick: string;
  #name: string | null = null;
  #isupport: ISupport = EMPTY_ISUPPORT;
  #caseMapper: CaseMapper;
  #caps: ReadonlySet<string> = new Set();

  readonly channels: IrcMap<Channel>;
  readonly users: IrcMap<User>;

  constructor(nick: string) {
    this.#nick = nick;
    this.#caseMapper = new CaseMapper(EMPTY_ISUPPORT.caseMapping);
    this.channels = new IrcMap<Channel>(this.#caseMapper);
    this.users = new IrcMap<User>(this.#caseMapper);
  }

  /** Our current nickname. */
  get nick(): string {
    return this.#nick;
  }
  /** The server's own name (from the `001` prefix), or `null` if not yet known. */
  get name(): string | null {
    return this.#name;
  }
  /** Network name from ISUPPORT `NETWORK`, or `null`. */
  get network(): string | null {
    return this.#isupport.network;
  }
  /** The accumulated, typed ISUPPORT view. */
  get isupport(): ISupport {
    return this.#isupport;
  }
  /** The casemapping currently in force. */
  get caseMapper(): CaseMapper {
    return this.#caseMapper;
  }
  /** Capabilities enabled on this connection. */
  get caps(): ReadonlySet<string> {
    return this.#caps;
  }

  /** @internal Update our nick (on self `NICK` / `001`). */
  setNick(nick: string): void {
    this.#nick = nick;
  }

  /** @internal Record the server's own name (from the `001` prefix). */
  setName(name: string): void {
    this.#name = name;
  }

  /** @internal Replace the enabled-caps snapshot. */
  setCaps(caps: ReadonlySet<string>): void {
    this.#caps = new Set(caps);
  }

  /**
   * @internal Apply ISUPPORT tokens from a `005` line. If the casemapping
   * changed, swap the {@link CaseMapper} and re-fold every keyed collection
   * (channels, users, and each channel's member list) so lookups stay correct.
   */
  applyIsupport(tokens: readonly string[]): void {
    const previousMapping = this.#isupport.caseMapping;
    this.#isupport = parseIsupport(tokens, this.#isupport);
    if (this.#isupport.caseMapping !== previousMapping) {
      this.#caseMapper = new CaseMapper(this.#isupport.caseMapping);
      this.channels.rekey(this.#caseMapper);
      this.users.rekey(this.#caseMapper);
      for (const channel of this.channels.values()) channel.members.rekey(this.#caseMapper);
    }
  }
}
