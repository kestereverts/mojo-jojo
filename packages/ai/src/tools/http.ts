const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2_000_000;
/** Identifies this bot honestly rather than spoofing a browser UA. */
const USER_AGENT = "mojo-jojo-bot/1.0 (+https://github.com/kestereverts/mojo-jojo)";

export interface FetchLimits {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** Fetch with a timeout (aborts the request) and a stable, honest User-Agent. */
async function fetchLimited(url: string, init: FetchLimits & RequestInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes: _maxBytes, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...rest.headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new Error(`response too large (${buf.byteLength} bytes, max ${maxBytes})`);
  }
  return new TextDecoder().decode(buf);
}

/** Fetch and parse JSON. Throws on a non-2xx status or an oversized body. */
export async function fetchJson<T = unknown>(url: string, opts: FetchLimits & RequestInit = {}): Promise<T> {
  const res = await fetchLimited(url, opts);
  const text = await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return JSON.parse(text) as T;
}

/**
 * Fetch raw text WITHOUT throwing on a non-2xx status — for APIs (like
 * Wolfram Alpha's LLM endpoint) where a "failure" status is itself a
 * meaningful response the caller needs to inspect, not just an error to
 * propagate. Still throws on an oversized body.
 */
export async function fetchText(
  url: string,
  opts: FetchLimits & RequestInit = {},
): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await fetchLimited(url, opts);
  const text = await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  return { status: res.status, ok: res.ok, text };
}
