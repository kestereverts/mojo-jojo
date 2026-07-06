import { describe, expect, test } from "bun:test";
import { resolvePublicHttpUrl } from "./ssrf-guard.ts";

// Literal-IP and blocked-hostname cases resolve with NO DNS lookup (isIP()
// short-circuits, or the hostname is in the static blocklist), so these are
// fast and don't depend on network/DNS availability in the test environment.

describe("resolvePublicHttpUrl — scheme", () => {
  test("rejects non-http(s) schemes", () => {
    expect(resolvePublicHttpUrl("file:///etc/passwd")).rejects.toThrow(/non-http/);
    expect(resolvePublicHttpUrl("ftp://example.com/x")).rejects.toThrow(/non-http/);
    expect(resolvePublicHttpUrl("gopher://example.com/x")).rejects.toThrow(/non-http/);
  });
});

describe("resolvePublicHttpUrl — blocked hostnames", () => {
  test("rejects localhost and known metadata hostnames", () => {
    expect(resolvePublicHttpUrl("http://localhost/")).rejects.toThrow(/local\/internal host/);
    expect(resolvePublicHttpUrl("http://metadata.google.internal/")).rejects.toThrow(/local\/internal host/);
  });
});

describe("resolvePublicHttpUrl — literal IPv4", () => {
  test("rejects loopback, RFC1918, and link-local (incl. the cloud metadata address)", () => {
    expect(resolvePublicHttpUrl("http://127.0.0.1/")).rejects.toThrow(/private\/internal/);
    expect(resolvePublicHttpUrl("http://10.0.0.5/")).rejects.toThrow(/private\/internal/);
    expect(resolvePublicHttpUrl("http://172.16.0.1/")).rejects.toThrow(/private\/internal/);
    expect(resolvePublicHttpUrl("http://192.168.1.1/")).rejects.toThrow(/private\/internal/);
    expect(resolvePublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private\/internal/);
  });

  test("rejects decimal and hex IPv4 notation, since WHATWG URL normalizes them to dotted-quad before we ever see them", () => {
    expect(resolvePublicHttpUrl("http://2130706433/")).rejects.toThrow(/private\/internal/); // decimal for 127.0.0.1
    expect(resolvePublicHttpUrl("http://0x7f000001/")).rejects.toThrow(/private\/internal/); // hex for 127.0.0.1
  });

  test("allows a well-known public IPv4 address and returns it as the connect address", async () => {
    // 8.8.8.8 (Google Public DNS) — a stable, non-private literal IP; no DNS
    // lookup needed since isIP() short-circuits the literal-address path.
    const target = await resolvePublicHttpUrl("http://8.8.8.8/");
    expect(target.url).toBeInstanceOf(URL);
    expect(target.connectAddress).toBe("8.8.8.8");
  });
});

describe("resolvePublicHttpUrl — literal IPv6", () => {
  test("rejects the loopback, link-local, unique-local, and multicast ranges, brackets stripped correctly", () => {
    expect(resolvePublicHttpUrl("http://[::1]/")).rejects.toThrow(/private\/internal/);
    expect(resolvePublicHttpUrl("http://[fe80::1]/")).rejects.toThrow(/private\/internal/);
    expect(resolvePublicHttpUrl("http://[fd00::1]/")).rejects.toThrow(/private\/internal/);
    expect(resolvePublicHttpUrl("http://[ff02::1]/")).rejects.toThrow(/private\/internal/); // multicast
  });

  test("rejects an IPv4-mapped IPv6 address that maps to a private range", () => {
    expect(resolvePublicHttpUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(/private\/internal/);
  });

  test("rejects the deprecated IPv4-compatible IPv6 form (no ffff: marker) mapping to a private range", () => {
    expect(resolvePublicHttpUrl("http://[::127.0.0.1]/")).rejects.toThrow(/private\/internal/);
  });
});

describe("resolvePublicHttpUrl — real hostname resolution (network-dependent)", () => {
  test("allows a public hostname, returning a resolved connect address distinct from the hostname", async () => {
    const target = await resolvePublicHttpUrl("https://example.com/");
    expect(target.url).toBeInstanceOf(URL);
    expect(target.connectAddress.length).toBeGreaterThan(0);
    expect(target.connectAddress).not.toBe("example.com");
  });
});
