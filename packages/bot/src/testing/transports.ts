import { MockTransport } from "@mojo-jojo/irc-client";
import type { TransportFactory } from "@mojo-jojo/irc-client";

/**
 * A {@link TransportFactory} that mints a FRESH {@link MockTransport} per connection
 * attempt (recording each in `mocks`). A single mock is unusable after `.fail()`/`.close()`
 * — its `bytes$` is settled — so reconnect tests must mint a new one per attempt.
 */
export function freshMockTransports(): { factory: TransportFactory; mocks: MockTransport[] } {
  const mocks: MockTransport[] = [];
  const factory: TransportFactory = () => {
    const mock = new MockTransport();
    mocks.push(mock);
    return mock;
  };
  return { factory, mocks };
}

/** Poll `predicate` until it holds, or throw after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
