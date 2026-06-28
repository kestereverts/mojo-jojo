import { describe, expect, test } from "bun:test";
import { firstValueFrom, lastValueFrom, take, toArray } from "rxjs";
import { MockTransport } from "./MockTransport.ts";
import { TransportClosedError } from "./Transport.ts";

const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("MockTransport", () => {
  test("captures string writes as both text and bytes", () => {
    const transport = new MockTransport();
    transport.write("NICK mojo\r\n");
    expect(transport.written).toEqual(["NICK mojo\r\n"]);
    expect(transport.writtenBytes).toHaveLength(1);
    expect(dec(transport.writtenBytes[0]!)).toBe("NICK mojo\r\n");
  });

  test("captures byte writes", () => {
    const transport = new MockTransport();
    transport.write(new TextEncoder().encode("USER a 0 * :b\r\n"));
    expect(transport.written).toEqual(["USER a 0 * :b\r\n"]);
  });

  test("receive() and receiveLine() push bytes onto bytes$", async () => {
    const transport = new MockTransport();
    const collected = firstValueFrom(transport.bytes$.pipe(take(2), toArray()));
    transport.receiveLine("PING :1");
    transport.receive("PONG\r\n");
    const chunks = await collected;
    expect(chunks.map(dec)).toEqual(["PING :1\r\n", "PONG\r\n"]);
  });

  test("close() completes bytes$ and reports a local close", async () => {
    const transport = new MockTransport();
    const closed = firstValueFrom(transport.closed$);
    const bytesDone = lastValueFrom(transport.bytes$.pipe(toArray()));

    transport.receiveLine("PING :1");
    transport.close();

    expect((await bytesDone).map(dec)).toEqual(["PING :1\r\n"]);
    expect(await closed).toEqual({ local: true });
  });

  test("fail() errors bytes$ and reports the error on closed$", async () => {
    const transport = new MockTransport();
    const closed = firstValueFrom(transport.closed$);
    const bytesDone = lastValueFrom(transport.bytes$.pipe(toArray()));

    const boom = new Error("reset by peer");
    transport.fail(boom);

    let caught: unknown;
    await bytesDone.catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(TransportClosedError);
    expect((caught as TransportClosedError).cause).toBe(boom);
    expect(await closed).toEqual({ local: false, error: boom });
  });

  test("close() is idempotent", () => {
    const transport = new MockTransport();
    transport.close();
    expect(() => {
      transport.close();
    }).not.toThrow();
  });
});
