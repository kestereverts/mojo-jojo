import { describe, expect, test } from "bun:test";
import { parseMessage, type Message } from "@mojo-jojo/irc-message";
import { StateStore } from "./StateStore.ts";
import { Dispatcher } from "./dispatch.ts";
import type { IrcEvent } from "../events/types.ts";

/** A dispatcher + store wired up, with a helper to feed raw lines. */
function harness(selfNick = "me"): {
  store: StateStore;
  events: IrcEvent[];
  feed: (line: string) => IrcEvent | null;
} {
  const store = new StateStore(selfNick);
  const dispatcher = new Dispatcher(store);
  const events: IrcEvent[] = [];
  const feed = (line: string): IrcEvent | null => {
    const event = dispatcher.dispatch(parseMessage(line));
    if (event) events.push(event);
    return event;
  };
  return { store, events, feed };
}

/** Drive a minimal registration so casemapping/isupport are known. */
function register(h: ReturnType<typeof harness>, nick = "me"): void {
  h.feed(`:irc 001 ${nick} :Welcome`);
  h.feed(`:irc 005 ${nick} PREFIX=(qaohv)~&@%+ CHANMODES=eIbq,k,flj,imnpst CHANTYPES=#& :are supported`);
}

describe("dispatch — registration burst", () => {
  test("001 sets our nick and creates our self user", () => {
    const h = harness("requested");
    h.feed(":irc 001 actualNick :Welcome");
    expect(h.store.server.nick).toBe("actualNick");
    expect(h.store.user("actualNick")?.isSelf).toBe(true);
  });

  test("005 accumulates ISUPPORT", () => {
    const h = harness();
    register(h);
    expect(h.store.server.isupport.prefixes).toHaveLength(5);
    expect(h.store.server.isupport.chanTypes).toBe("#&");
  });
});

describe("dispatch — membership", () => {
  test("self JOIN creates the channel and adds us", () => {
    const h = harness();
    register(h);
    const event = h.feed(":me!u@h JOIN #mojo2");
    expect(event?.type).toBe("join");
    const channel = h.store.channel("#mojo2");
    expect(channel).toBeDefined();
    expect(channel?.members.get("me")).toBeDefined();
    expect(channel?.members.get("me")?.user.isSelf).toBe(true);
  });

  test("other JOIN with extended-join populates account and realname", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    const event = h.feed(":alice!a@host JOIN #chan accountName :Alice Real");
    expect(event?.type).toBe("join");
    if (event?.type === "join") {
      expect(event.account).toBe("accountName");
      expect(event.realName).toBe("Alice Real");
      expect(event.isSelf).toBe(false);
    }
    const alice = h.store.user("alice");
    expect(alice?.account).toBe("accountName");
    expect(alice?.host).toBe("host");
  });

  test("PART by another removes only that member; self PART drops the channel", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":bob!b@h JOIN #chan");
    expect(h.store.channel("#chan")?.members.size).toBe(2);

    h.feed(":bob!b@h PART #chan :bye");
    expect(h.store.channel("#chan")?.members.has("bob")).toBe(false);
    expect(h.store.channel("#chan")?.members.size).toBe(1);

    h.feed(":me!u@h PART #chan");
    expect(h.store.channel("#chan")).toBeUndefined();
  });

  test("QUIT removes the user from all channels and disposes its stream", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #a");
    h.feed(":me!u@h JOIN #b");
    h.feed(":carol!c@h JOIN #a");
    h.feed(":carol!c@h JOIN #b");

    let quitSeen = false;
    let completed = false;
    const carol = h.store.user("carol")!;
    carol.quit$.subscribe({ next: () => (quitSeen = true), complete: () => (completed = true) });

    const event = h.feed(":carol!c@h QUIT :Ping timeout");
    expect(event?.type).toBe("quit");
    if (event?.type === "quit") {
      expect(event.channels.map((c) => c.name).sort()).toEqual(["#a", "#b"]);
      expect(event.reason).toBe("Ping timeout");
    }
    expect(quitSeen).toBe(true);
    expect(completed).toBe(true); // dispose completed the stream
    expect(h.store.user("carol")).toBeUndefined();
    expect(h.store.channel("#a")?.members.has("carol")).toBe(false);
  });

  test("KICK removes the target; self kick drops the channel", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":dave!d@h JOIN #chan");
    const event = h.feed(":op!o@h KICK #chan dave :rude");
    expect(event?.type).toBe("kick");
    if (event?.type === "kick") {
      expect(event.target.nick).toBe("dave");
      expect(event.by?.nick).toBe("op");
      expect(event.reason).toBe("rude");
    }
    expect(h.store.channel("#chan")?.members.has("dave")).toBe(false);

    h.feed(":op!o@h KICK #chan me :you too");
    expect(h.store.channel("#chan")).toBeUndefined();
  });
});

describe("dispatch — nick changes", () => {
  test("NICK re-keys the user across channels and updates self nick", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    const event = h.feed(":me!u@h NICK me2");
    expect(event?.type).toBe("nick");
    if (event?.type === "nick") {
      expect(event.oldNick).toBe("me");
      expect(event.newNick).toBe("me2");
      expect(event.isSelf).toBe(true);
      expect(event.channels.map((c) => c.name)).toEqual(["#chan"]);
    }
    expect(h.store.server.nick).toBe("me2");
    expect(h.store.user("me")).toBeUndefined();
    expect(h.store.user("me2")).toBeDefined();
    expect(h.store.channel("#chan")?.members.get("me2")).toBeDefined();
    expect(h.store.channel("#chan")?.members.has("me")).toBe(false);
  });
});

describe("dispatch — topic", () => {
  test("332 sets the topic; 333 records who/when", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":irc 332 me #chan :The Topic");
    h.feed(":irc 333 me #chan alice 1700000000");
    const channel = h.store.channel("#chan")!;
    expect(channel.topic).toBe("The Topic");
    expect(channel.topicSetBy).toBe("alice");
    expect(channel.topicSetAt?.getTime()).toBe(1700000000 * 1000);
  });

  test("live TOPIC command updates the topic with the setter", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    const event = h.feed(":eve!e@h TOPIC #chan :New topic");
    expect(event?.type).toBe("topic");
    if (event?.type === "topic") {
      expect(event.topic).toBe("New topic");
      expect(event.setBy?.nick).toBe("eve");
      expect(event.isInitial).toBe(false);
    }
    expect(h.store.channel("#chan")?.topic).toBe("New topic");
  });
});

describe("dispatch — NAMES", () => {
  test("353/366 populate members with prefixes and userhost-in-names", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":irc 353 me = #chan :@alice!a@ah +bob!b@bh carol");
    const event = h.feed(":irc 366 me #chan :End of NAMES");
    expect(event?.type).toBe("names");
    if (event?.type === "names") {
      expect(event.members.map((m) => m.nick).sort()).toEqual(["alice", "bob", "carol", "me"]);
    }
    const channel = h.store.channel("#chan")!;
    expect(channel.members.get("alice")?.isOp()).toBe(true);
    expect(channel.members.get("alice")?.user.host).toBe("ah");
    expect(channel.members.get("bob")?.isVoice()).toBe(true);
    expect(channel.members.get("carol")?.hasStatus()).toBe(false);
  });
});

describe("dispatch — modes", () => {
  test("channel MODE applies prefix modes to members and other modes to the channel", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":frank!f@h JOIN #chan");
    const event = h.feed(":op!o@h MODE #chan +ok-l frank secret");
    expect(event?.type).toBe("mode");
    const channel = h.store.channel("#chan")!;
    expect(channel.members.get("frank")?.isOp()).toBe(true);
    expect(channel.modes.get("k")).toBe("secret");
    expect(channel.modes.has("l")).toBe(false); // -l removed (was never set)
  });

  test("ban list is tracked under list modes", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":op!o@h MODE #chan +b *!*@bad.host");
    expect([...(h.store.channel("#chan")?.lists.get("b") ?? [])]).toEqual(["*!*@bad.host"]);
  });
});

describe("dispatch — messages", () => {
  test("channel PRIVMSG resolves channel, user, and member", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":grace!g@h JOIN #chan");
    const event = h.feed("@account=graceAcct :grace!g@h PRIVMSG #chan :hello");
    expect(event?.type).toBe("privmsg");
    if (event?.type === "privmsg") {
      expect(event.channel?.name).toBe("#chan");
      expect(event.user.nick).toBe("grace");
      expect(event.member?.nick).toBe("grace");
      expect(event.text).toBe("hello");
      expect(event.isPrivate).toBe(false);
      expect(event.account).toBe("graceAcct");
    }
  });

  test("CTCP ACTION becomes an ActionEvent with framing stripped", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    const event = h.feed(":heidi!h@h PRIVMSG #chan :ACTION waves");
    expect(event?.type).toBe("action");
    if (event?.type === "action") {
      expect(event.text).toBe("waves");
    }
  });

  test("private PRIVMSG to us is flagged isPrivate with a null channel", () => {
    const h = harness();
    register(h);
    const event = h.feed(":ivan!i@h PRIVMSG me :psst");
    expect(event?.type).toBe("privmsg");
    if (event?.type === "privmsg") {
      expect(event.isPrivate).toBe(true);
      expect(event.channel).toBeNull();
    }
  });

  test("server-sourced NOTICE has a null user", () => {
    const h = harness();
    register(h);
    const event = h.feed(":irc.example.net NOTICE me :*** Checking ident");
    expect(event?.type).toBe("notice");
    if (event?.type === "notice") {
      expect(event.user).toBeNull();
    }
  });

  test("server-time tag drives the event time", () => {
    const h = harness();
    register(h);
    const event = h.feed("@time=2021-11-14T22:13:20.000Z :j!j@h PRIVMSG me :hi");
    expect(event?.time.toISOString()).toBe("2021-11-14T22:13:20.000Z");
  });
});

describe("dispatch — casemapping", () => {
  test("nick lookups are case-insensitive under rfc1459", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":Nick[]!n@h JOIN #chan");
    // rfc1459 folds [] -> {}
    expect(h.store.channel("#chan")?.members.get("nick{}")).toBeDefined();
  });
});

describe("dispatch — source classification (server vs user)", () => {
  test("a dotless server name (from 001) is not treated as a user", () => {
    const h = harness();
    register(h); // 001 prefix is :irc -> server name "irc" (no dot)
    const event = h.feed(":irc NOTICE me :*** server notice");
    expect(event?.type).toBe("notice");
    if (event?.type === "notice") expect(event.user).toBeNull();
    expect(h.store.user("irc")).toBeUndefined(); // no phantom user created
  });

  test("a pre-registration dotless server NOTICE (before 001) has a null user", () => {
    const h = harness(); // nothing fed yet -> server name still unknown
    const event = h.feed(":irc NOTICE * :*** Looking up your hostname");
    expect(event?.type).toBe("notice");
    if (event?.type === "notice") expect(event.user).toBeNull();
    expect(h.store.user("irc")).toBeUndefined(); // no phantom user pre-001
  });

  test("a server-sourced KICK has a null `by`", () => {
    const h = harness();
    register(h); // server name "irc"
    h.feed(":me!u@h JOIN #chan");
    h.feed(":dave!d@h JOIN #chan");
    const event = h.feed(":irc KICK #chan dave :services removal");
    expect(event?.type).toBe("kick");
    if (event?.type === "kick") expect(event.by).toBeNull();
  });
});

describe("dispatch — user garbage collection", () => {
  test("a user who parts their last shared channel is removed from the user map", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":bob!b@h JOIN #chan");
    expect(h.store.user("bob")).toBeDefined();
    h.feed(":bob!b@h PART #chan");
    expect(h.store.user("bob")).toBeUndefined(); // GC'd: no shared channels left
  });

  test("a user still sharing another channel is retained", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #a");
    h.feed(":me!u@h JOIN #b");
    h.feed(":bob!b@h JOIN #a");
    h.feed(":bob!b@h JOIN #b");
    h.feed(":bob!b@h PART #a");
    expect(h.store.user("bob")).toBeDefined(); // still in #b
  });

  test("self PART GCs other members of the dropped channel", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #x");
    h.feed(":carol!c@h JOIN #x");
    h.feed(":me!u@h PART #x");
    expect(h.store.channel("#x")).toBeUndefined();
    expect(h.store.user("carol")).toBeUndefined(); // orphaned -> GC'd
    expect(h.store.user("me")).toBeDefined(); // self is never GC'd
  });

  test("a kicked user with no other shared channel is removed", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":dave!d@h JOIN #chan");
    h.feed(":op!o@h KICK #chan dave :bye");
    expect(h.store.user("dave")).toBeUndefined();
  });
});

describe("dispatch — account synchronization", () => {
  test("the account tag updates User.account state", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":grace!g@h JOIN #chan");
    h.feed("@account=graceAcct :grace!g@h PRIVMSG #chan :hi");
    expect(h.store.user("grace")?.account).toBe("graceAcct");
  });
});

describe("dispatch — passthrough", () => {
  test("unhandled commands return null (still visible on messages$)", () => {
    const h = harness();
    register(h);
    expect(h.feed(":irc 372 me :- MOTD line")).toBeNull();
    const event: Message = parseMessage(":irc PONG irc :token");
    expect(new Dispatcher(new StateStore("me")).dispatch(event)).toBeNull();
  });
});
