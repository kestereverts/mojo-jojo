import { describe, expect, test } from "bun:test";
import { Server } from "./Server.ts";
import { Channel } from "./Channel.ts";
import { User } from "./User.ts";
import { Member } from "./Member.ts";
import { ReactiveEntity } from "./ReactiveEntity.ts";
import { EMIT, DISPOSE } from "./internal.ts";
import { privmsgEvent, nickEvent } from "../events/factory.ts";
import { parseMessage } from "@mojo-jojo/irc-message";

function freshServer(): Server {
  const server = new Server("me");
  server.applyIsupport(["PREFIX=(qaohv)~&@%+", "CHANMODES=eIbq,k,flj,imnpst", "CHANTYPES=#&"]);
  return server;
}

describe("Member", () => {
  test("predicates and prefixes follow the status modes held", () => {
    const server = freshServer();
    const channel = new Channel("#chan", server);
    const member = new Member(new User("bob"), channel);

    expect(member.isOp()).toBe(false);
    expect(member.hasStatus()).toBe(false);

    member.addMode("o");
    member.addMode("v");
    expect(member.isOp()).toBe(true);
    expect(member.isVoice()).toBe(true);
    // Ordered by ISUPPORT rank: @ (op) before + (voice).
    expect(member.prefixes).toEqual(["@", "+"]);
    expect(member.highestPrefix).toBe("@");

    member.removeMode("o");
    expect(member.isOp()).toBe(false);
    expect(member.prefixes).toEqual(["+"]);
  });

  test("applyPrefixChars maps NAMES prefix chars to modes via ISUPPORT", () => {
    const server = freshServer();
    const channel = new Channel("#chan", server);
    const member = new Member(new User("carol"), channel);
    member.applyPrefixChars("@+");
    expect(member.isOp()).toBe(true);
    expect(member.isVoice()).toBe(true);
    expect(member.nick).toBe("carol");
  });
});

describe("Channel", () => {
  test("setTopic records text, setter, and time", () => {
    const server = freshServer();
    const channel = new Channel("#chan", server);
    const when = new Date(1_700_000_000_000);
    channel.setTopic("hello world", "alice", when);
    expect(channel.topic).toBe("hello world");
    expect(channel.topicSetBy).toBe("alice");
    expect(channel.topicSetAt).toBe(when);
  });

  test("applyChannelMode tracks B/C/D modes and A list modes", () => {
    const server = freshServer();
    const channel = new Channel("#chan", server);
    channel.applyChannelMode({ added: true, mode: "k", param: "secret", kind: "B" });
    channel.applyChannelMode({ added: true, mode: "m", param: null, kind: "D" });
    expect(channel.modes.get("k")).toBe("secret");
    expect(channel.modes.has("m")).toBe(true);

    channel.applyChannelMode({ added: true, mode: "b", param: "*!*@bad", kind: "A" });
    channel.applyChannelMode({ added: true, mode: "b", param: "*!*@evil", kind: "A" });
    expect([...(channel.lists.get("b") ?? [])]).toEqual(["*!*@bad", "*!*@evil"]);

    channel.applyChannelMode({ added: false, mode: "b", param: "*!*@bad", kind: "A" });
    expect([...(channel.lists.get("b") ?? [])]).toEqual(["*!*@evil"]);

    channel.applyChannelMode({ added: false, mode: "k", param: null, kind: "B" });
    expect(channel.modes.has("k")).toBe(false);
  });
});

describe("User", () => {
  test("updateFromSource fills user/host; rename changes nick", () => {
    const user = new User("dave");
    user.updateFromSource({ name: "dave", user: "~dave", host: "example.com" });
    expect(user.username).toBe("~dave");
    expect(user.host).toBe("example.com");
    user.rename("dave2");
    expect(user.nick).toBe("dave2");
  });

  test("setAccount normalizes * and empty to null", () => {
    const user = new User("eve");
    user.setAccount("eve_acct");
    expect(user.account).toBe("eve_acct");
    user.setAccount("*");
    expect(user.account).toBeNull();
  });

  test("derived streams filter by event type", () => {
    const user = new User("frank");
    const messages: string[] = [];
    user.messages$.subscribe((e) => messages.push(e.text));

    const raw = parseMessage(":frank!f@h PRIVMSG #x :hi");
    user[EMIT](privmsgEvent(raw, {
      channel: null,
      user,
      member: null,
      target: "#x",
      text: "hi",
      isPrivate: false,
      account: null,
    }));
    // A nick event should NOT appear on messages$.
    user[EMIT](nickEvent(parseMessage(":frank!f@h NICK frank2"), {
      user,
      oldNick: "frank",
      newNick: "frank2",
      channels: [],
      isSelf: false,
    }));
    expect(messages).toEqual(["hi"]);
  });
});

describe("ReactiveEntity facade", () => {
  interface Ping {
    readonly type: "ping";
    readonly n: number;
  }
  class Pinger extends ReactiveEntity<Ping> {}

  test("on returns an unsubscribe; off removes by handler; once fires once", () => {
    const p = new Pinger();
    const seen: number[] = [];
    const handler = (e: Ping): void => void seen.push(e.n);

    const unsub = p.on("ping", handler);
    p[EMIT]({ type: "ping", n: 1 });
    unsub();
    p[EMIT]({ type: "ping", n: 2 });
    expect(seen).toEqual([1]);

    const onceSeen: number[] = [];
    p.once("ping", (e) => onceSeen.push(e.n));
    p[EMIT]({ type: "ping", n: 3 });
    p[EMIT]({ type: "ping", n: 4 });
    expect(onceSeen).toEqual([3]);

    const offSeen: number[] = [];
    const h2 = (e: Ping): void => void offSeen.push(e.n);
    p.on("ping", h2);
    p.off("ping", h2);
    p[EMIT]({ type: "ping", n: 5 });
    expect(offSeen).toEqual([]);
  });

  test("dispose completes the stream", () => {
    const p = new Pinger();
    let completed = false;
    p.events$.subscribe({ complete: () => (completed = true) });
    p[DISPOSE]();
    expect(completed).toBe(true);
  });
});

describe("Server", () => {
  test("applyIsupport accumulates and exposes typed view", () => {
    const server = new Server("me");
    server.applyIsupport(["NETWORK=Test", "PREFIX=(ov)@+"]);
    expect(server.network).toBe("Test");
    expect(server.isupport.prefixes).toHaveLength(2);
  });

  test("casemapping change re-keys channels, users, and members", () => {
    const server = new Server("me"); // default rfc1459
    const channel = new Channel("#Foo", server);
    server.channels.set("#Foo", channel);
    server.users.set("Bar[]", new User("Bar[]"));
    channel.members.add(new Member(new User("Nick[]"), channel));

    // Under rfc1459, "#foo" already matches "#Foo"; switch to ascii to prove rekey.
    server.applyIsupport(["CASEMAPPING=ascii"]);
    expect(server.caseMapper.mapping).toBe("ascii");
    expect(server.channels.get("#Foo")).toBe(channel);
    expect(server.users.get("Bar[]")).toBeDefined();
    expect(channel.members.get("Nick[]")).toBeDefined();
    // Under ascii, the bracket fold no longer applies.
    expect(server.users.get("bar{}")).toBeUndefined();
  });
});
