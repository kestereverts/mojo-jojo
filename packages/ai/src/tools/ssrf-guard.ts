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
  const dottedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dottedMatch) return isPrivateIPv4(dottedMatch[1]!);
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMatch) {
    const g1 = parseInt(hexMatch[1]!, 16);
    const g2 = parseInt(hexMatch[2]!, 16);
    const dotted = [(g1 >> 8) & 0xff, g1 & 0xff, (g2 >> 8) & 0xff, g2 & 0xff].join(".");
    return isPrivateIPv4(dotted);
  }

  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  return false;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Throws unless `urlString` is safe for a server-side fetch of a
 * user/model-supplied URL: rejects non-http(s) schemes, well-known local
 * hostnames, and — after DNS resolution for a hostname, or directly for a
 * literal IP — private/loopback/link-local/multicast address ranges
 * (link-local covers the 169.254.169.254 cloud metadata endpoint used by
 * AWS/GCP/Azure).
 *
 * Call this for the INITIAL url AND for every redirect hop's target before
 * following it — a public URL redirecting to a private one is exactly the
 * bypass this exists to prevent; checking only the first URL misses it.
 */
export async function assertPublicHttpUrl(urlString: string): Promise<URL> {
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
    return url;
  }

  const { address, family } = await lookup(hostname);
  const isPrivate = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
  if (isPrivate) throw new Error(`refusing to fetch ${hostname} — resolves to a private/internal address (${address})`);
  return url;
}
