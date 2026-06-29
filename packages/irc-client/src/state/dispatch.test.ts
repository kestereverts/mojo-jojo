import { describe, expect, test } from "bun:test";
import { parseMessage, type Message } from "@mojo-jojo/irc-message";
import { MAX_CHANNELS, StateStore } from "./StateStore.ts";
import { Dispatcher } from "./dispatch.ts";
import { WHOX_TOKEN } from "../protocol/whox.ts";
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

  test("a casemapping change that collides two nicks disposes the displaced user", () => {
    const h = harness();
    h.feed(":irc 001 me :hi");
    // Start on ascii, where Nick[] and Nick{} are DISTINCT (no []<->{} folding).
    h.feed(":irc 005 me CASEMAPPING=ascii CHANTYPES=# PREFIX=(o)@ :are supported");
    h.feed(":me!u@h JOIN #chan");
    h.feed(":Nick[]!a@h JOIN #chan");
    h.feed(":Nick{}!b@h JOIN #chan");
    expect(h.store.server.users.size).toBe(3); // me, Nick[], Nick{}

    let disposed = false;
    h.store.user("Nick[]")!.events$.subscribe({ complete: () => (disposed = true) });

    // Switch to rfc1459: [] now folds to {}, so the two nicks collide on rekey.
    h.feed(":irc 005 me CASEMAPPING=rfc1459 :are supported");
    expect(disposed).toBe(true); // displaced user's stream completed — no leaked Subject
    expect(h.store.server.users.size).toBe(2); // me + the surviving nick
    expect(h.store.channel("#chan")?.members.size).toBe(2); // me + one member (collapsed)
  });

  test("a casemapping collision never disposes the self user (the usurper loses)", () => {
    const h = harness("Me[]"); // our own nick is Me[]
    h.feed(":irc 001 Me[] :hi");
    h.feed(":irc 005 Me[] CASEMAPPING=ascii CHANTYPES=# PREFIX=(o)@ :are supported");
    h.feed(":Me[]!u@h JOIN #chan"); // self join (self user inserted first)
    h.feed(":Me{}!x@h JOIN #chan"); // a distinct user that will collide under rfc1459
    expect(h.store.server.users.size).toBe(2);

    let selfDisposed = false;
    let usurperDisposed = false;
    h.store.user("Me[]")!.events$.subscribe({ complete: () => (selfDisposed = true) });
    h.store.user("Me{}")!.events$.subscribe({ complete: () => (usurperDisposed = true) });

    // [] folds to {} under rfc1459; self (inserted first) would otherwise be evicted.
    h.feed(":irc 005 Me[] CASEMAPPING=rfc1459 :are supported");
    expect(selfDisposed).toBe(false); // our identity stream is preserved
    expect(usurperDisposed).toBe(true); // the non-self user is the one disposed
    expect(h.store.user(h.store.server.nick)?.isSelf).toBe(true); // self lookup still resolves to us
    expect(h.store.server.users.size).toBe(1);
    // ...and channel membership is repaired too: our own Member survives the
    // collision rather than one pointing at the disposed non-self user.
    expect(h.store.channel("#chan")?.members.get(h.store.server.nick)?.user.isSelf).toBe(true);
    expect(h.store.channel("#chan")?.members.size).toBe(1);
  });

  test("a channel collision prunes users orphaned by the disposed channel", () => {
    const h = harness("me");
    h.feed(":irc 001 me :hi");
    h.feed(":irc 005 me CASEMAPPING=ascii CHANTYPES=# :are supported");
    h.feed(":me!u@h JOIN #a[]"); // self in both (distinct channels under ascii)
    h.feed(":me!u@h JOIN #a{}");
    h.feed(":bob!b@h JOIN #a[]"); // bob lives ONLY in #a[]
    expect(h.store.server.channels.size).toBe(2);
    let bobDisposed = false;
    h.store.user("bob")!.events$.subscribe({ complete: () => (bobDisposed = true) });

    // rfc1459 folds [] <-> {}, so #a[] and #a{} collide; #a[] is displaced.
    h.feed(":irc 005 me CASEMAPPING=rfc1459 :are supported");
    expect(h.store.server.channels.size).toBe(1); // one channel survives
    expect(bobDisposed).toBe(true); // bob, orphaned by the disposed channel, is pruned
    expect(h.store.user("bob")).toBeUndefined();
  });

  test("divergent global/channel collision winners leave no disposed user reachable", () => {
    // Global and per-channel maps rekey independently, so the collision winner can
    // differ between them. The invariant that must hold afterwards: every channel
    // member references the live, canonical user for its nick (no disposed user).
    const h = harness("me");
    h.feed(":irc 001 me :hi");
    h.feed(":irc 005 me CASEMAPPING=ascii CHANTYPES=# :are supported");
    h.feed(":me!u@h JOIN #other");
    h.feed(":me!u@h JOIN #chan");
    h.feed(":Nick[]!a@h JOIN #other"); // Nick[] seen first globally
    h.feed(":Nick{}!b@h JOIN #chan"); // Nick{} seen first in #chan
    h.feed(":Nick[]!a@h JOIN #chan"); // Nick[] later in #chan (channel winner != global winner)
    h.feed(":irc 005 me CASEMAPPING=rfc1459 :are supported"); // [] folds to {} -> collide

    for (const name of ["#other", "#chan"]) {
      const channel = h.store.channel(name);
      for (const member of channel?.members ?? []) {
        // member.user must be the same object the global map resolves for its nick.
        expect(h.store.user(member.nick)).toBe(member.user);
      }
    }
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

  test("account-notify ACCOUNT login updates the user and emits an AccountEvent", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":grace!g@h JOIN #chan");
    const event = h.feed(":grace!g@h ACCOUNT graceAcct");
    expect(event?.type).toBe("account");
    if (event?.type === "account") {
      expect(event.user.nick).toBe("grace");
      expect(event.account).toBe("graceAcct");
      expect(event.isSelf).toBe(false);
      expect(event.channels.map((c) => c.name)).toEqual(["#chan"]);
    }
    expect(h.store.user("grace")?.account).toBe("graceAcct");
  });

  test("account-notify ACCOUNT * clears the account (logout)", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":grace!g@h JOIN #chan");
    h.feed(":grace!g@h ACCOUNT graceAcct");
    const event = h.feed(":grace!g@h ACCOUNT *");
    expect(event?.type).toBe("account");
    if (event?.type === "account") expect(event.account).toBeNull();
    expect(h.store.user("grace")?.account).toBeNull();
  });

  test("ACCOUNT routes to the user's and shared channel's per-entity streams", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":grace!g@h JOIN #chan");
    const onUser: (string | null)[] = [];
    const onChannel: (string | null)[] = [];
    h.store.user("grace")!.accountChanges$.subscribe((e) => onUser.push(e.account));
    h.store.channel("#chan")!.accountChanges$.subscribe((e) => onChannel.push(e.account));
    h.feed(":grace!g@h ACCOUNT graceAcct");
    expect(onUser).toEqual(["graceAcct"]);
    expect(onChannel).toEqual(["graceAcct"]);
  });

  test("ACCOUNT for an untracked user is ignored (no event, no phantom user)", () => {
    const h = harness();
    register(h);
    const event = h.feed(":stranger!s@h ACCOUNT acct");
    expect(event).toBeNull();
    expect(h.store.user("stranger")).toBeUndefined();
  });
});

describe("dispatch — echo-message", () => {
  test("our own echoed PRIVMSG resolves us as the speaker and routes to the channel", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    const seen: string[] = [];
    h.store.channel("#chan")!.messages$.subscribe((e) => seen.push(e.text));
    const event = h.feed("@time=2021-11-14T22:13:20.000Z :me!u@h PRIVMSG #chan :hi from me");
    expect(event?.type).toBe("privmsg");
    if (event?.type === "privmsg") {
      expect(event.user.isSelf).toBe(true);
      expect(event.member?.nick).toBe("me");
      expect(event.text).toBe("hi from me");
      // server-time on the echo drives the event timestamp.
      expect(event.time.toISOString()).toBe("2021-11-14T22:13:20.000Z");
    }
    expect(seen).toEqual(["hi from me"]);
  });
});

describe("dispatch — resource hygiene (no unbounded growth)", () => {
  test("a PM/NOTICE from a non-channel stranger is not retained", () => {
    const h = harness();
    register(h);
    // A stranger who shares no channel with us must not leak a User entity.
    expect(h.feed(":stranger!s@h PRIVMSG me :hi")?.type).toBe("privmsg");
    expect(h.store.user("stranger")).toBeUndefined();
    expect(h.feed(":svc!s@h NOTICE me :a notice")?.type).toBe("notice");
    expect(h.store.user("svc")).toBeUndefined();
    expect(h.store.server.users.size).toBe(1); // only us

    // ...but a channel member who PMs us IS kept (shared channel).
    h.feed(":me!u@h JOIN #chan");
    h.feed(":alice!a@h JOIN #chan");
    h.feed(":alice!a@h PRIVMSG me :hey");
    expect(h.store.user("alice")).toBeDefined();
  });

  test("TOPIC/MODE/332 for a non-joined channel create no phantom channel", () => {
    const h = harness();
    register(h);
    expect(h.feed(":eve!e@h TOPIC #notjoined :hi")).toBeNull();
    expect(h.feed(":op!o@h MODE #notjoined +m")).toBeNull();
    expect(h.feed(":irc 332 me #notjoined :a topic")).toBeNull();
    expect(h.store.channel("#notjoined")).toBeUndefined();
    expect(h.store.server.channels.size).toBe(0);
    // The non-member setters likewise leave no orphan users behind.
    expect(h.store.user("eve")).toBeUndefined();
    expect(h.store.user("op")).toBeUndefined();
  });

  test("a foreign JOIN to an untracked channel is ignored (no phantom growth)", () => {
    const h = harness();
    register(h);
    // We never joined #fake; a hostile server pushing a foreign JOIN must not
    // create the channel/user (otherwise unbounded phantom growth → OOM).
    expect(h.feed(":rand!u@h JOIN #fake")).toBeNull();
    expect(h.store.channel("#fake")).toBeUndefined();
    expect(h.store.user("rand")).toBeUndefined();
    expect(h.store.server.channels.size).toBe(0);

    // ...but a foreign JOIN to a channel we ARE in still adds the member.
    h.feed(":me!u@h JOIN #chan");
    expect(h.feed(":bob!b@h JOIN #chan")?.type).toBe("join");
    expect(h.store.channel("#chan")?.members.has("bob")).toBe(true);
  });

  test("total tracked channels are bounded against a forged self-JOIN flood", () => {
    const h = harness();
    register(h);
    // `isSelf` is forgeable (the server controls the prefix), so a hostile server
    // can send `:<ournick> JOIN #fakeN` — the channel COUNT must still be capped.
    for (let i = 0; i < MAX_CHANNELS + 5; i++) h.feed(`:me!u@h JOIN #fake${i}`);
    expect(h.store.server.channels.size).toBe(MAX_CHANNELS);
  });

  test("channel list-mode (ban) retention is bounded", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    for (let i = 0; i < 1100; i++) h.feed(`:op!o@h MODE #chan +b mask${i}!*@*`);
    expect(h.store.channel("#chan")!.lists.get("b")!.size).toBe(1000);
  });

  test("a forged user-MODE source is not retained (no channel involved)", () => {
    const h = harness();
    register(h);
    // `:fake MODE fake +i` is a user mode (no channel); the source must not leak.
    expect(h.feed(":fake!f@h MODE fake +i")?.type).toBe("mode");
    expect(h.store.user("fake")).toBeUndefined();
    expect(h.store.server.users.size).toBe(1); // only us
  });

  test("a forged KICK source (kicker) and target are not retained", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    // A non-member kicker (forged source) and a non-member target must not linger.
    expect(h.feed(":fake!f@h KICK #chan ghost :bye")?.type).toBe("kick");
    expect(h.store.user("fake")).toBeUndefined();
    expect(h.store.user("ghost")).toBeUndefined();
  });

  test("a non-member MODE/TOPIC setter in a joined channel is not retained", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    // ChanServ sets a mode but isn't a member: applied, but not kept as a User.
    const ev = h.feed(":ChanServ!s@services MODE #chan +m");
    expect(ev?.type).toBe("mode");
    expect(h.store.channel("#chan")?.modes.has("m")).toBe(true);
    expect(h.store.user("ChanServ")).toBeUndefined();
  });
});

describe("dispatch — NICK collisions (non-conformant server)", () => {
  test("a NICK onto an existing nick disposes the displaced user", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":alice!a@h JOIN #chan");
    h.feed(":bob!b@h JOIN #chan");
    const aliceUser = h.store.user("alice")!;
    let bobCompleted = false;
    h.store.user("bob")!.events$.subscribe({ complete: () => (bobCompleted = true) });

    // alice renames onto the already-present "bob" (a server that broke uniqueness).
    h.feed(":alice!a@h NICK bob");
    expect(bobCompleted).toBe(true); // displaced bob's stream completed (no leak)
    expect(h.store.user("bob")).toBe(aliceUser); // bob now resolves to renamed-alice
    expect(h.store.user("alice")).toBeUndefined();
    expect(h.store.channel("#chan")?.members.size).toBe(2); // me + bob (collapsed)
  });

  test("a NICK onto our own nick is refused (self identity protected)", () => {
    const h = harness(); // self = "me"
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":alice!a@h JOIN #chan");
    expect(h.feed(":alice!a@h NICK me")).toBeNull(); // refused — no event
    expect(h.store.user("me")?.isSelf).toBe(true); // our self user is preserved
    expect(h.store.user("alice")).toBeDefined(); // alice unchanged
  });
});

describe("dispatch — WHOX (354)", () => {
  // Our fixed WHOX layout: <client> <token> <channel> <user> <host> <nick> <flags> <account> :<realname>
  test("354 enriches a known user (account/realname/host/away) and member status", () => {
    const h = harness();
    register(h); // PREFIX=(qaohv)~&@%+
    h.feed(":me!u@h JOIN #chan");
    h.feed(":alice!a@h JOIN #chan");
    h.feed(`:irc 354 me ${WHOX_TOKEN} #chan aliceUser alice.host alice G@ aliceAcct :Alice Real`);

    const alice = h.store.user("alice")!;
    expect(alice.account).toBe("aliceAcct"); // WHOX gives the account (352 can't)
    expect(alice.realName).toBe("Alice Real");
    expect(alice.username).toBe("aliceUser");
    expect(alice.host).toBe("alice.host");
    expect(alice.away).toBe(true); // flags start with G
    expect(h.store.channel("#chan")?.members.get("alice")?.isOp()).toBe(true); // @ in flags
  });

  test("354 account '0' means logged out", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":alice!a@h JOIN #chan");
    h.feed(`:irc 354 me ${WHOX_TOKEN} #chan u host alice H 0 :Real`);
    expect(h.store.user("alice")?.account).toBeNull();
  });

  test("354 with a foreign token is ignored, and WHOX creates no phantom users", () => {
    const h = harness();
    register(h);
    // Different token -> unknown layout -> ignored.
    expect(h.feed(":irc 354 me 5 #chan u host nobody H acct :Real")).toBeNull();
    expect(h.store.user("nobody")).toBeUndefined();
    // Our token, but an untracked nick -> no phantom created.
    h.feed(`:irc 354 me ${WHOX_TOKEN} #chan u host ghost H acct :Real`);
    expect(h.store.user("ghost")).toBeUndefined();
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

describe("dispatch — P2/P3 caps (M6)", () => {
  /** Register and put `me` + `alice` together in `#chan`. */
  function withAlice(): ReturnType<typeof harness> {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":alice!aliceuser@alicehost JOIN #chan");
    return h;
  }

  test("away-notify sets/clears away and routes to user + channels", () => {
    const h = withAlice();
    const onUser: boolean[] = [];
    const onChannel: boolean[] = [];
    h.store.user("alice")!.awayChanges$.subscribe((e) => onUser.push(e.away));
    h.store.channel("#chan")!.awayChanges$.subscribe((e) => onChannel.push(e.away));

    const gone = h.feed(":alice!aliceuser@alicehost AWAY :be right back");
    expect(gone?.type).toBe("away");
    if (gone?.type === "away") {
      expect(gone.away).toBe(true);
      expect(gone.message).toBe("be right back");
    }
    expect(h.store.user("alice")?.away).toBe(true);

    const back = h.feed(":alice!aliceuser@alicehost AWAY");
    if (back?.type === "away") {
      expect(back.away).toBe(false);
      expect(back.message).toBeNull();
    }
    expect(h.store.user("alice")?.away).toBe(false);
    expect(onUser).toEqual([true, false]);
    expect(onChannel).toEqual([true, false]);
  });

  test("chghost updates username/host in place", () => {
    const h = withAlice();
    const event = h.feed(":alice!aliceuser@alicehost CHGHOST newuser new.host");
    expect(event?.type).toBe("chghost");
    if (event?.type === "chghost") {
      expect(event.newUser).toBe("newuser");
      expect(event.newHost).toBe("new.host");
    }
    expect(h.store.user("alice")?.username).toBe("newuser");
    expect(h.store.user("alice")?.host).toBe("new.host");
  });

  test("setname updates the real name", () => {
    const h = withAlice();
    const event = h.feed(":alice!aliceuser@alicehost SETNAME :Alice In Wonderland");
    expect(event?.type).toBe("setname");
    if (event?.type === "setname") expect(event.realName).toBe("Alice In Wonderland");
    expect(h.store.user("alice")?.realName).toBe("Alice In Wonderland");
  });

  test("away/chghost/setname are ignored for untracked users", () => {
    const h = harness();
    register(h);
    expect(h.feed(":ghost!g@h AWAY :poof")).toBeNull();
    expect(h.feed(":ghost!g@h CHGHOST u host")).toBeNull();
    expect(h.feed(":ghost!g@h SETNAME :Ghost")).toBeNull();
  });

  test("standard replies FAIL/WARN/NOTE parse command/code/context/text", () => {
    const h = harness();
    register(h);
    const fail = h.feed(":irc FAIL JOIN ACCOUNT_REQUIRED #chan :You must register first");
    expect(fail?.type).toBe("standardReply");
    if (fail?.type === "standardReply") {
      expect(fail.replyType).toBe("FAIL");
      expect(fail.command).toBe("JOIN");
      expect(fail.code).toBe("ACCOUNT_REQUIRED");
      expect(fail.context).toEqual(["#chan"]);
      expect(fail.text).toBe("You must register first");
    }
    const warn = h.feed(":irc WARN NICK INVALID :bad nick");
    if (warn?.type === "standardReply") {
      expect(warn.replyType).toBe("WARN");
      expect(warn.context).toEqual([]);
      expect(warn.text).toBe("bad nick");
    }
    const note = h.feed(":irc NOTE * CONNECTED :welcome");
    expect(note?.type).toBe("standardReply");
    if (note?.type === "standardReply") expect(note.replyType).toBe("NOTE");
  });

  test("BATCH reassembles tagged messages and still dispatches them", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");

    expect(h.feed(":irc BATCH +xyz netjoin irc.hub other.host")).toBeNull();
    // The inner JOIN dispatches normally (alice becomes a member)...
    const join = h.feed("@batch=xyz :alice!a@host JOIN #chan");
    expect(join?.type).toBe("join");
    expect(h.store.channel("#chan")?.members.has("alice")).toBe(true);

    // ...and is also collected into the batch surfaced on close.
    const batch = h.feed(":irc BATCH -xyz");
    expect(batch?.type).toBe("batch");
    if (batch?.type === "batch") {
      expect(batch.reference).toBe("xyz");
      expect(batch.batchType).toBe("netjoin");
      expect(batch.params).toEqual(["irc.hub", "other.host"]);
      expect(batch.messages).toHaveLength(1);
      expect(batch.messages[0]?.command).toBe("JOIN");
    }
  });

  test("nested BATCH: inner content belongs to the inner batch", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");

    h.feed(":irc BATCH +outer example.com/foo");
    h.feed("@batch=outer :irc BATCH +inner example.com/bar");
    const pm = h.feed("@batch=inner :alice!a@h PRIVMSG #chan :hi");
    expect(pm?.type).toBe("privmsg"); // inner message still dispatches

    const inner = h.feed("@batch=outer :irc BATCH -inner");
    expect(inner?.type).toBe("batch");
    if (inner?.type === "batch") {
      expect(inner.reference).toBe("inner");
      expect(inner.messages).toHaveLength(1);
      expect(inner.messages[0]?.command).toBe("PRIVMSG");
    }

    // The outer batch contains the nested batch's control lines (its direct
    // children), not the deeper PRIVMSG (which belonged to the inner batch).
    const outer = h.feed(":irc BATCH -outer");
    if (outer?.type === "batch") {
      expect(outer.reference).toBe("outer");
      expect(outer.messages.every((m) => m.command === "BATCH")).toBe(true);
      expect(outer.messages).toHaveLength(2);
    }

    const unknown = h.feed(":irc BATCH -nope"); // closing an unknown ref is a no-op
    expect(unknown).toBeNull();
  });

  test("352 WHO reply enriches a known user (host/user/realname/away)", () => {
    const h = withAlice();
    h.feed(":irc 352 me #chan whoUser whoHost irc.server alice G :3 Alice Gone");
    const alice = h.store.user("alice")!;
    expect(alice.username).toBe("whoUser");
    expect(alice.host).toBe("whoHost");
    expect(alice.away).toBe(true);
    expect(alice.realName).toBe("Alice Gone");

    // `H` (here) clears the away flag.
    h.feed(":irc 352 me #chan whoUser whoHost irc.server alice H :3 Alice Gone");
    expect(alice.away).toBe(false);
  });

  test("352 WHO does not create users from WHO output", () => {
    const h = harness();
    register(h);
    expect(h.feed(":irc 352 me #chan u host irc.server nobody H :0 Nobody")).toBeNull();
    expect(h.store.user("nobody")).toBeUndefined();
  });

  test("multi-prefix NAMES stacks all status prefixes", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":irc 353 me = #chan :@+alice me");
    h.feed(":irc 366 me #chan :End of NAMES");
    const alice = h.store.channel("#chan")?.members.get("alice");
    expect(alice?.isOp()).toBe(true);
    expect(alice?.isVoice()).toBe(true);
  });

  test("userhost-in-names populates user/host from the NAMES entry", () => {
    const h = harness();
    register(h);
    h.feed(":me!u@h JOIN #chan");
    h.feed(":irc 353 me = #chan :@alice!aliceuser@alicehost me");
    const alice = h.store.user("alice");
    expect(alice?.username).toBe("aliceuser");
    expect(alice?.host).toBe("alicehost");
    expect(h.store.channel("#chan")?.members.get("alice")?.isOp()).toBe(true);
  });

  test("BATCH retention is bounded (open count + messages per batch)", () => {
    const h = harness();
    register(h);

    // Per-batch message cap (4096): further inner messages still dispatch but
    // stop being collected, so the BatchEvent never grows without bound.
    h.feed(":irc BATCH +big example");
    for (let i = 0; i < 4100; i++) h.feed(`@batch=big :a!a@h PRIVMSG me :m${i}`);
    const big = h.feed(":irc BATCH -big");
    expect(big?.type).toBe("batch");
    if (big?.type === "batch") expect(big.messages.length).toBe(4096);

    // Open-batch cap (64): once the cap is reached, further opens aren't tracked,
    // so their close is a no-op (but the open/inner lines still pass through).
    for (let i = 0; i < 64; i++) h.feed(`:irc BATCH +open${i} t`);
    expect(h.feed(":irc BATCH +overflow t")).toBeNull();
    expect(h.feed(":irc BATCH -overflow")).toBeNull(); // never tracked
  });
});
