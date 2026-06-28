import { describe, expect, test } from "bun:test";
import { parseMessage } from "@mojo-jojo/irc-message";
import { StateStore } from "./StateStore.ts";
import { Dispatcher } from "./dispatch.ts";

// A full scripted session pushed through the dispatcher, asserting the resulting
// StateStore — the "golden transcript" check from the plan. It exercises the
// registration burst, ISUPPORT, NAMES, topic, joins/parts/nick/mode/message
// flow as one coherent story.

const SESSION = [
  // Registration + ISUPPORT.
  ":irc 001 mojo :Welcome to AndroidIRC",
  ":irc 005 mojo PREFIX=(qaohv)~&@%+ CHANMODES=eIbq,k,flj,imnpst CHANTYPES=#& NETWORK=AndroidIRC CASEMAPPING=rfc1459 :are supported by this server",
  ":irc 005 mojo MODES=4 NICKLEN=30 :are supported by this server",
  // We join #mojo2; server sends topic + names.
  ":mojo!~mojo@client JOIN #mojo2",
  ":irc 332 mojo #mojo2 :Welcome to mojo2",
  ":irc 333 mojo #mojo2 founder 1700000000",
  ":irc 353 mojo = #mojo2 :~founder @op +voiced regular mojo",
  ":irc 366 mojo #mojo2 :End of /NAMES list",
  // Another user joins, gets opped, speaks, then renames.
  ":alice!~alice@a.host JOIN #mojo2",
  ":op!~op@o.host MODE #mojo2 +o alice",
  ":alice!~alice@a.host PRIVMSG #mojo2 :hello everyone",
  ":alice!~alice@a.host NICK alice2",
  // A ban is set; a regular user parts; the voiced user quits.
  ":op!~op@o.host MODE #mojo2 +b *!*@spammer.host",
  ":regular!~r@r.host PART #mojo2 :leaving",
  ":voiced!~v@v.host QUIT :Ping timeout",
] as const;

describe("golden session transcript", () => {
  test("final state reflects the whole session", () => {
    const store = new StateStore("mojo");
    const dispatcher = new Dispatcher(store);
    for (const line of SESSION) dispatcher.dispatch(parseMessage(line));

    const server = store.server;
    // Our identity + ISUPPORT.
    expect(server.nick).toBe("mojo");
    expect(server.network).toBe("AndroidIRC");
    expect(server.isupport.modesPerLine).toBe(4);
    expect(server.isupport.raw["NICKLEN"]).toBe("30");
    expect(server.caseMapper.mapping).toBe("rfc1459");

    // Channel + topic.
    const chan = store.channel("#mojo2")!;
    expect(chan).toBeDefined();
    expect(chan.topic).toBe("Welcome to mojo2");
    expect(chan.topicSetBy).toBe("founder");
    expect(chan.topicSetAt?.getTime()).toBe(1700000000 * 1000);

    // Membership after the join/part/quit/nick churn:
    //   started with founder, op, voiced, regular, mojo (5) from NAMES
    //   + alice joined            -> 6
    //   - regular parted          -> 5
    //   - voiced quit             -> 4
    //   alice renamed to alice2
    expect([...chan.members.nicks()].sort()).toEqual(["alice2", "founder", "mojo", "op"]);

    // Status modes from NAMES prefixes.
    expect(chan.members.get("founder")?.isOwner()).toBe(true);
    expect(chan.members.get("op")?.isOp()).toBe(true);
    expect(chan.members.get("mojo")?.hasStatus()).toBe(false);

    // alice was opped, then renamed — the membership (and op) follow the rename.
    const alice = chan.members.get("alice2");
    expect(alice).toBeDefined();
    expect(alice?.isOp()).toBe(true);
    expect(alice?.user.host).toBe("a.host");
    expect(store.user("alice")).toBeUndefined();
    expect(store.user("alice2")?.nick).toBe("alice2");

    // Ban list.
    expect([...(chan.lists.get("b") ?? [])]).toEqual(["*!*@spammer.host"]);

    // Departed users are gone.
    expect(chan.members.has("regular")).toBe(false);
    expect(store.user("voiced")).toBeUndefined();
  });

  test("entity streams receive the right events during the session", () => {
    const store = new StateStore("mojo");
    const dispatcher = new Dispatcher(store);

    // Subscribe to #mojo2 once it exists by replaying the join first.
    dispatcher.dispatch(parseMessage(":irc 001 mojo :hi"));
    dispatcher.dispatch(
      parseMessage(":irc 005 mojo PREFIX=(qaohv)~&@%+ CHANMODES=eIbq,k,flj,imnpst CHANTYPES=#& :ok"),
    );
    dispatcher.dispatch(parseMessage(":mojo!~m@h JOIN #mojo2"));

    const chan = store.channel("#mojo2")!;
    const messages: string[] = [];
    const joins: string[] = [];
    chan.messages$.subscribe((e) => messages.push(e.text));
    chan.joins$.subscribe((e) => joins.push(e.user.nick));

    dispatcher.dispatch(parseMessage(":bob!~b@h JOIN #mojo2"));
    dispatcher.dispatch(parseMessage(":bob!~b@h PRIVMSG #mojo2 :hi there"));

    expect(joins).toEqual(["bob"]);
    expect(messages).toEqual(["hi there"]);
  });
});
