import { describe, expect, test } from "bun:test";
import { firstValueFrom, take, toArray } from "rxjs";
import { BunSocketTransport, type SocketConnector } from "./BunSocketTransport.ts";
import { TransportClosedError } from "./Transport.ts";

type SocketHandlers = Bun.TCPSocketConnectOptions["socket"];

/**
 * Builds a transport wired to a fake connector so the socket-callback mapping
 * can be exercised without a real socket. `deferConnect` holds the connect
 * promise open until {@link Harness.releaseConnect} is called (to test the
 * close-during-connect race).
 */
function makeHarness(opts: { deferConnect?: boolean } = {}): {
  transport: BunSocketTransport;
  writes: Array<string | Uint8Array>;
  fakeSocket: Bun.Socket;
  endCount: () => number;
  handlers: () => SocketHandlers;
  releaseConnect: () => void;
} {
  const writes: Array<string | Uint8Array> = [];
  let endCount = 0;
  const fakeSocket = {
    write: (data: string | Uint8Array) => {
      writes.push(data);
      return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    },
    end: () => {
      endCount += 1;
      return 0;
    },
  } as unknown as Bun.Socket;

  let captured: SocketHandlers | undefined;
  let releaseConnect!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });

  const connector: SocketConnector = async (options) => {
    captured = options.socket;
    if (opts.deferConnect) await gate;
    return fakeSocket;
  };

  const transport = new BunSocketTransport({ hostname: "irc.test", port: 6667, connector });

  return {
    transport,
    writes,
    fakeSocket,
    endCount: () => endCount,
    handlers: () => {
      if (!captured) throw new Error("connector has not been called yet");
      return captured;
    },
    releaseConnect,
  };
}

describe("BunSocketTransport", () => {
  test("forwards inbound socket data to bytes$", async () => {
    const h = makeHarness();
    await h.transport.connect();
    const collected = firstValueFrom(h.transport.bytes$.pipe(take(1), toArray()));
    h.handlers().data!(h.fakeSocket, Buffer.from("PING :x\r\n"));
    const [chunk] = await collected;
    expect(new TextDecoder().decode(chunk)).toBe("PING :x\r\n");
  });

  test("write() forwards to the underlying socket", async () => {
    const h = makeHarness();
    await h.transport.connect();
    h.transport.write("NICK mojo\r\n");
    expect(h.writes).toEqual(["NICK mojo\r\n"]);
  });

  test("write() before connect throws", () => {
    const h = makeHarness();
    expect(() => {
      h.transport.write("x");
    }).toThrow("write before connect");
  });

  test("connecting twice throws", async () => {
    const h = makeHarness();
    await h.transport.connect();
    let caught: unknown;
    await h.transport.connect().catch((err: unknown) => {
      caught = err;
    });
    expect((caught as Error).message).toContain("already connected");
  });

  test("a remote close errors bytes$ with TransportClosedError", async () => {
    const h = makeHarness();
    await h.transport.connect();
    const closed = firstValueFrom(h.transport.closed$);
    const done = firstValueFrom(h.transport.bytes$.pipe(toArray()));
    h.handlers().close!(h.fakeSocket);
    let caught: unknown;
    await done.catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(TransportClosedError);
    expect(await closed).toEqual({ local: false });
  });

  test("a remote end (FIN) errors bytes$", async () => {
    const h = makeHarness();
    await h.transport.connect();
    const done = firstValueFrom(h.transport.bytes$.pipe(toArray()));
    h.handlers().end!(h.fakeSocket);
    let caught: unknown;
    await done.catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(TransportClosedError);
  });

  test("a socket error errors bytes$ and reports the error on closed$", async () => {
    const h = makeHarness();
    await h.transport.connect();
    const closed = firstValueFrom(h.transport.closed$);
    const done = firstValueFrom(h.transport.bytes$.pipe(toArray()));
    const boom = new Error("ECONNRESET");
    h.handlers().error!(h.fakeSocket, boom);
    let caught: unknown;
    await done.catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(TransportClosedError);
    expect((caught as TransportClosedError).cause).toBe(boom);
    expect(await closed).toEqual({ local: false, error: boom });
  });

  test("a local close completes bytes$ without error", async () => {
    const h = makeHarness();
    await h.transport.connect();
    const closed = firstValueFrom(h.transport.closed$);
    const done = firstValueFrom(h.transport.bytes$.pipe(toArray()));
    h.transport.close();
    expect(h.endCount()).toBe(1);
    h.handlers().close!(h.fakeSocket); // Bun fires close after our end()
    expect(await done).toEqual([]);
    expect(await closed).toEqual({ local: true });
  });

  test("settles only once (double-settle guard)", async () => {
    const h = makeHarness();
    await h.transport.connect();
    const closedAll = firstValueFrom(h.transport.closed$.pipe(toArray()));
    h.transport.bytes$.subscribe({ error: () => undefined }); // swallow the error
    const boom = new Error("first");
    h.handlers().error!(h.fakeSocket, boom);
    h.handlers().close!(h.fakeSocket); // ignored after first settle
    h.handlers().end!(h.fakeSocket); // ignored after first settle
    expect(await closedAll).toEqual([{ local: false, error: boom }]);
  });

  test("a connector rejection settles the streams and rejects connect()", async () => {
    const boom = new Error("ECONNREFUSED");
    const connector: SocketConnector = () => Promise.reject(boom);
    const transport = new BunSocketTransport({ hostname: "h", port: 1, connector });
    const closed = firstValueFrom(transport.closed$);
    const done = firstValueFrom(transport.bytes$.pipe(toArray()));

    let connectErr: unknown;
    await transport.connect().catch((err: unknown) => {
      connectErr = err;
    });
    expect(connectErr).toBe(boom);

    let bytesErr: unknown;
    await done.catch((err: unknown) => {
      bytesErr = err;
    });
    expect(bytesErr).toBeInstanceOf(TransportClosedError);
    expect((bytesErr as TransportClosedError).cause).toBe(boom);
    expect(await closed).toEqual({ local: false, error: boom });
  });

  test("close() during an in-flight connect ends the socket once connected", async () => {
    const h = makeHarness({ deferConnect: true });
    const connecting = h.transport.connect();
    h.transport.close(); // socket not assigned yet
    expect(h.endCount()).toBe(0);
    h.releaseConnect(); // let the connect resolve
    await connecting;
    expect(h.endCount()).toBe(1); // honoured the pending close
  });
});
