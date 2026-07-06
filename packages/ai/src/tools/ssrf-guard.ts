import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed — treat as unsafe rather than risk a parse-mismatch bypass
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — includes the 169.254.169.254 cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments (192.0.0.0/24)
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4)
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified

  // IPv4-mapped (::ffff:a.b.c.d). WHATWG URL's parser normalizes the literal
  // hostname to the HEX-GROUP form (e.g. "::ffff:7f00:1" for 127.0.0.1), not
  // the dotted-quad form — checked empirically, both forms are handled here.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) return isPrivateIPv4(hexPairToDotted(mappedHex[1]!, mappedHex[2]!));

  // Deprecated "IPv4-compatible" form (::a.b.c.d / its hex-group equivalent,
  // no "ffff:" marker) — legacy, but still parses, so still worth rejecting
  // when it encodes a private address.
  const compatDotted = /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (compatDotted) return isPrivateIPv4(compatDotted[1]!);
  const compatHex = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (compatHex) return isPrivateIPv4(hexPairToDotted(compatHex[1]!, compatHex[2]!));

  if (/^ff[0-9a-f]{2}:/.test(lower)) return true; // ff00::/8 multicast
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  return false;
}

function hexPairToDotted(g1Hex: string, g2Hex: string): string {
  const g1 = parseInt(g1Hex, 16);
  const g2 = parseInt(g2Hex, 16);
  return [(g1 >> 8) & 0xff, g1 & 0xff, (g2 >> 8) & 0xff, g2 & 0xff].join(".");
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export interface SafeFetchTarget {
  /** The original request URL — path/query/hash are read from this. */
  readonly url: URL;
  /**
   * The literal IP address to actually CONNECT to. Using this instead of
   * `url.hostname` for the connection is what closes the DNS-rebinding /
   * TOCTOU gap: a separate re-resolution at fetch time (a public URL's
   * hostname could legitimately or maliciously resolve to a DIFFERENT
   * address than the one just validated — either a short-TTL rebind, or a
   * multi-A-record response mixing a public "decoy" with a private target)
   * would otherwise connect to an address nobody checked.
   */
  readonly connectAddress: string;
}

/**
 * Resolves and validates `urlString` as a safe target for a server-side
 * fetch of a user/model-supplied URL, returning the exact address to connect
 * to. Rejects non-http(s) schemes, well-known local hostnames, and (for a
 * literal IP, or every address a hostname resolves to) private/loopback/
 * link-local/multicast ranges — link-local covers the 169.254.169.254 cloud
 * metadata endpoint used by AWS/GCP/Azure. All of a hostname's resolved
 * addresses are checked, not just the first, since a multi-A-record
 * response could mix a public "decoy" with a private target.
 *
 * Call this for the INITIAL url AND for every redirect hop's target before
 * following it — a public URL redirecting to a private one is exactly the
 * bypass this exists to prevent; checking only the first URL misses it. The
 * caller MUST connect to the returned `connectAddress`, not re-resolve
 * `url.hostname` itself — that reintroduces the exact TOCTOU gap this
 * function closes.
 */
export async function resolvePublicHttpUrl(urlString: string): Promise<SafeFetchTarget> {
  const url = new URL(urlString);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing to fetch a non-http(s) URL: ${url.protocol}`);
  }

  const hostname = stripBrackets(url.hostname.toLowerCase());
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`refusing to fetch a local/internal host: ${hostname}`);
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    const isPrivate = literalFamily === 4 ? isPrivateIPv4(hostname) : isPrivateIPv6(hostname);
    if (isPrivate) throw new Error(`refusing to fetch a private/internal address: ${hostname}`);
    return { url, connectAddress: hostname };
  }

  const records = await lookup(hostname, { all: true });
  if (records.length === 0) throw new Error(`could not resolve ${hostname}`);
  for (const { address, family } of records) {
    const isPrivate = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (isPrivate) throw new Error(`refusing to fetch ${hostname} — resolves to a private/internal address (${address})`);
  }
  // Connect to the SAME address just validated — not a fresh re-resolution.
  return { url, connectAddress: records[0]!.address };
}
