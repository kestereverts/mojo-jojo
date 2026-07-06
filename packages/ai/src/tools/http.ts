const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2_000_000;
/** Identifies this bot honestly rather than spoofing a browser UA. */
const USER_AGENT = "mojo-jojo-bot/1.0 (+https://github.com/kestereverts/mojo-jojo)";

export interface FetchLimits {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/**
 * Fetch with a timeout (aborts the request) and a stable, honest User-Agent.
 * Exported for callers (e.g. `web-reader.ts`) that need to drive their own
 * redirect loop instead of relying on `fetch`'s automatic following — e.g. to
 * validate each hop's target before following it.
 */
export async function fetchLimited(url: string, init: FetchLimits & RequestInit = {}): Promise<Response> {
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

/**
 * Read a response body as text, aborting as soon as the running byte count
 * exceeds `maxBytes` rather than buffering the whole body first — a hostile
 * or just very large response never gets fully materialized in memory.
 *
 * Also bounds WALL-CLOCK time for the read itself via `timeoutMs`: the
 * initial `fetch()` call's own timeout (`fetchLimited`'s `timeoutMs`) only
 * covers getting a `Response` back — it's cleared as soon as headers arrive,
 * before the body is ever read. Without a read-phase timeout of its own, a
 * server that returns a small `Content-Length` but "drips" bytes far below
 * `maxBytes` could hold the reader open indefinitely.
 */
export async function readCapped(res: Response, maxBytes: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No readable stream (e.g. an empty body) — nothing to cap or time out.
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error(`response too large (${buf.byteLength} bytes, max ${maxBytes})`);
    return new TextDecoder().decode(buf);
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel("read timed out").catch(() => {});
  }, timeoutMs);

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response too large (exceeded ${maxBytes} bytes)`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  // A timed-out cancel() resolves the pending read() as `done: true`, which
  // would otherwise look identical to the body genuinely ending — check the
  // flag explicitly so a slow-drip response is reported as a timeout, not
  // silently returned as if it were complete.
  if (timedOut) throw new Error(`response body read timed out after ${timeoutMs}ms`);
  chunks.push(decoder.decode());
  return chunks.join("");
}

/** Fetch and parse JSON. Throws on a non-2xx status or an oversized body. */
export async function fetchJson<T = unknown>(url: string, opts: FetchLimits & RequestInit = {}): Promise<T> {
  const res = await fetchLimited(url, opts);
  const text = await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return JSON.parse(text) as T;
}

/**
 * Fetch raw text WITHOUT throwing on a non-2xx status — for APIs (like
 * Wolfram Alpha's LLM endpoint) where a "failure" status is itself a
 * meaningful response the caller needs to inspect, not just an error to
 * propagate. Still throws on an oversized body. `url`/`contentType` reflect
 * the response actually received (post-redirect final URL; the media type
 * with any `; charset=...` stripped) for callers that need to dispatch on them.
 */
export async function fetchText(
  url: string,
  opts: FetchLimits & RequestInit = {},
): Promise<{ status: number; ok: boolean; text: string; url: string; contentType: string | undefined }> {
  const res = await fetchLimited(url, opts);
  const text = await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return { status: res.status, ok: res.ok, text, url: res.url, contentType };
}
