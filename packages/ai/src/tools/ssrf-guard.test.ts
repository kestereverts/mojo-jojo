import { describe, expect, test } from "bun:test";
import { assertPublicHttpUrl } from "./ssrf-guard.ts";

// Literal-IP and blocked-hostname cases resolve with NO DNS lookup (isIP()
// short-circuits, or the hostname is in the static blocklist), so these are
// fast and don't depend on network/DNS availability in the test environment.

describe("assertPublicHttpUrl — scheme", () => {
  test("rejects non-http(s) schemes", () => {
    expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(/non-http/);
    expect(assertPublicHttpUrl("ftp://example.com/x")).rejects.toThrow(/non-http/);
    expect(assertPublicHttpUrl("gopher://example.com/x")).rejects.toThrow(/non-http/);
  });
});

describe("assertPublicHttpUrl — blocked hostnames", () => {
  test("rejects localhost and known metadata hostnames", () => {
    expect(assertPublicHttpUrl("http://localhost/")).rejects.toThrow(/local\/internal host/);
    expect(assertPublicHttpUrl("http://metadata.google.internal/")).rejects.toThrow(/local\/internal host/);
  });
});

describe("assertPublicHttpUrl — literal IPv4", () => {
  test("rejects loopback, RFC1918, and link-local (incl. the cloud metadata address)", () => {
    expect(assertPublicHttpUrl("http://127.0.0.1/")).rejects.toThrow(/private\/internal/);
    expect(assertPublicHttpUrl("http://10.0.0.5/")).rejects.toThrow(/private\/internal/);
    expect(assertPublicHttpUrl("http://172.16.0.1/")).rejects.toThrow(/private\/internal/);
    expect(assertPublicHttpUrl("http://192.168.1.1/")).rejects.toThrow(/private\/internal/);
    expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private\/internal/);
  });

  test("allows a well-known public IPv4 address", async () => {
    // 8.8.8.8 (Google Public DNS) — a stable, non-private literal IP; no DNS
    // lookup needed since isIP() short-circuits the literal-address path.
    await expect(assertPublicHttpUrl("http://8.8.8.8/")).resolves.toBeInstanceOf(URL);
  });
});

describe("assertPublicHttpUrl — literal IPv6", () => {
  test("rejects the loopback and link-local ranges, brackets stripped correctly", () => {
    expect(assertPublicHttpUrl("http://[::1]/")).rejects.toThrow(/private\/internal/);
    expect(assertPublicHttpUrl("http://[fe80::1]/")).rejects.toThrow(/private\/internal/);
    expect(assertPublicHttpUrl("http://[fd00::1]/")).rejects.toThrow(/private\/internal/);
  });

  test("rejects an IPv4-mapped IPv6 address that maps to a private range", () => {
    expect(assertPublicHttpUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(/private\/internal/);
  });
});

describe("assertPublicHttpUrl — real hostname resolution (network-dependent)", () => {
  test("allows a public hostname that resolves to a public address", async () => {
    await expect(assertPublicHttpUrl("https://example.com/")).resolves.toBeInstanceOf(URL);
  });
});
