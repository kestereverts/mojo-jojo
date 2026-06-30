import { describe, expect, test } from "bun:test";
import { bootBot } from "../testing/botHarness.ts";
import { waitFor } from "../testing/transports.ts";
import { autojoinModule } from "./autojoin.ts";

describe("autojoinModule", () => {
  test("joins configured channels on registration and again after reconnect", async () => {
    const h = await bootBot({
      modules: { autojoin: { channels: ["#a", "#b"] } },
      factories: { autojoin: autojoinModule },
    });
    await h.awaitWritten((l) => l.startsWith("JOIN #a"));
    await h.awaitWritten((l) => l.startsWith("JOIN #b"));

    // Drop the connection; autojoin must re-fire on the new attempt's registration.
    const before = h.mocks.length;
    h.mocks[before - 1]!.fail(new Error("reset"));
    await waitFor(() => h.mocks.length === before + 1 && h.mocks[before]!.written.some((l) => l.startsWith("USER")), 2000);
    h.mocks[before]!.receiveLine(":irc 001 mojo :hi again");
    await waitFor(() => h.mocks[before]!.written.some((l) => l.startsWith("JOIN #a")), 2000);
    await h.stop();
  });

  test("staggers multiple channels in order", async () => {
    const h = await bootBot({
      modules: { autojoin: { channels: ["#a", "#b"], delayMs: 15 } },
      factories: { autojoin: autojoinModule },
    });
    await h.awaitWritten((l) => l.startsWith("JOIN #b"), 1000);
    const lines = h.written();
    const ai = lines.findIndex((l) => l.startsWith("JOIN #a"));
    const bi = lines.findIndex((l) => l.startsWith("JOIN #b"));
    expect(ai).toBeGreaterThanOrEqual(0);
    expect(ai).toBeLessThan(bi); // #a is scheduled before #b
    await h.stop();
  });

  test("uses a per-channel key and a stagger delay", async () => {
    const h = await bootBot({
      modules: { autojoin: { channels: ["#keyed"], keys: { "#keyed": "s3cret" }, delayMs: 25 } },
      factories: { autojoin: autojoinModule },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.written().some((l) => l.startsWith("JOIN #keyed"))).toBe(false); // delayed
    await h.awaitWritten((l) => l === "JOIN #keyed s3cret\r\n", 500);
    await h.stop();
  });

  test("does nothing when no channels are configured", async () => {
    const h = await bootBot({ modules: { autojoin: {} }, factories: { autojoin: autojoinModule } });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.written().some((l) => l.startsWith("JOIN"))).toBe(false);
    await h.stop();
  });
});
