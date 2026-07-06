import { JSDOM, VirtualConsole } from "jsdom";
import { Defuddle } from "defuddle/node";
import { tool } from "ai";
import { z } from "zod";
import { isIP } from "node:net";
import { fetchLimited, readCapped } from "./http.ts";
import { resolvePublicHttpUrl } from "./ssrf-guard.ts";
import { TtlCache } from "./cache.ts";
import type { ToolDefinition } from "./define.ts";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CONTENT_CHUNK_SIZE = 20_000;
const FAST_PATH_HTML_THRESHOLD = 1_000_000; // above this, skip Defuddle entirely — see extractFastMarkdown
const FAST_TEXT_LIMIT = 120_000;
const DEFUDDLE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
// Bounds both memory (the cache holds full extracted content per URL) and
// how far pagination can run for one page — a defensive cap, not a
// request-time reject like mojo-ai3's (pagination alone already bounds any
// single response to CONTENT_CHUNK_SIZE).
const MAX_CACHED_CONTENT_CHARS = 500_000;

const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const JSON_CONTENT_TYPES = new Set(["application/json", "application/ld+json"]);
const XML_CONTENT_TYPES = new Set(["application/xml", "text/xml", "application/rss+xml", "application/atom+xml"]);
const YAML_CONTENT_TYPES = new Set(["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"]);

interface ExtractedPage {
  readonly url: string;
  readonly title: string | null;
  readonly author: string | null;
  readonly published: string | null;
  readonly description: string | null;
  readonly domain: string | null;
  readonly language: string | null;
  readonly wordCount: number | null;
  readonly site: string | null;
  readonly contentType: string | null;
  readonly content: string;
  readonly extractorType?: string;
  /** Set when extraction fell back to the fast-DOM path because Defuddle itself threw — surfaced so a systematic Defuddle failure isn't silently invisible. */
  readonly extractionWarning?: string;
  readonly fetchedAt: string;
}

// Caches the FULL extracted page per URL — mojo-ai3 re-fetched and
// re-extracted the entire page on every pagination (startIndex) call.
const pageCache = new TtlCache<ExtractedPage>(50);

function isHtmlContentType(contentType: string | undefined): boolean {
  return !contentType || HTML_CONTENT_TYPES.has(contentType);
}

function isTextBasedContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  if (contentType.startsWith("text/")) return true;
  if (contentType.endsWith("+json") || contentType.endsWith("+xml")) return true;
  if (JSON_CONTENT_TYPES.has(contentType) || XML_CONTENT_TYPES.has(contentType) || YAML_CONTENT_TYPES.has(contentType)) {
    return true;
  }
  return contentType === "application/javascript" || contentType === "application/x-javascript";
}

function countWords(input: string): number {
  const words = input.trim().match(/\S+/g);
  return words ? words.length : 0;
}

function deriveTitleFromUrl(url: string): string {
  const parsed = new URL(url);
  const fileName = parsed.pathname.split("/").filter(Boolean).pop();
  return fileName ? decodeURIComponent(fileName) : parsed.hostname;
}

/** Wraps a non-HTML text-based response as a fenced code block so it renders sensibly as Markdown. */
function toTextMarkdown(rawContent: string, contentType: string | undefined): string {
  const trimmed = rawContent.trim();
  if (!trimmed) return "";
  if (!contentType || contentType === "text/plain" || contentType === "text/markdown") return trimmed;

  if (JSON_CONTENT_TYPES.has(contentType) || contentType.endsWith("+json")) {
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(trimmed), null, 2)}\n\`\`\``;
    } catch {
      return `\`\`\`json\n${trimmed}\n\`\`\``;
    }
  }
  if (XML_CONTENT_TYPES.has(contentType) || contentType.endsWith("+xml")) return `\`\`\`xml\n${trimmed}\n\`\`\``;
  if (YAML_CONTENT_TYPES.has(contentType)) return `\`\`\`yaml\n${trimmed}\n\`\`\``;
  if (contentType === "text/csv") return `\`\`\`csv\n${trimmed}\n\`\`\``;
  if (contentType === "application/javascript" || contentType === "application/x-javascript") {
    return `\`\`\`javascript\n${trimmed}\n\`\`\``;
  }
  return `\`\`\`text\n${trimmed}\n\`\`\``;
}

function normalizeBlockText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/**
 * A cheap, direct DOM-block extraction used for HTML too large to run
 * through Defuddle's full scoring pass in reasonable time (see
 * FAST_PATH_HTML_THRESHOLD), and as a fallback if Defuddle itself fails or
 * times out.
 */
function extractFastMarkdown(dom: JSDOM): string {
  const document = dom.window.document;
  const root = document.querySelector("article, main, [role='main']") ?? document.body;
  if (!root) return "";

  for (const el of root.querySelectorAll("script, style, noscript, svg, nav, header, footer, aside, form, button, iframe")) {
    el.remove();
  }

  const blocks = root.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, tr");
  const collected: string[] = [];
  let totalLength = 0;

  const title = normalizeBlockText(document.title);
  if (title) {
    collected.push(`# ${title}`);
    totalLength += title.length + 2;
  }

  for (const block of blocks) {
    let text: string;
    if (block.tagName === "TR") {
      text = [...block.querySelectorAll("th, td")]
        .map((cell) => normalizeBlockText(cell.textContent ?? ""))
        .filter(Boolean)
        .join(" | ");
    } else {
      text = normalizeBlockText(block.textContent ?? "");
    }
    if (!text) continue;

    let formatted = text;
    if (/^H[1-6]$/.test(block.tagName)) {
      formatted = `${"#".repeat(Number(block.tagName.slice(1)))} ${text}`;
    } else if (block.tagName === "LI") {
      formatted = `- ${text}`;
    } else if (block.tagName === "BLOCKQUOTE") {
      formatted = `> ${text}`;
    }

    if (collected[collected.length - 1] !== formatted) {
      collected.push(formatted);
      totalLength += formatted.length + 2;
    }
    if (totalLength >= FAST_TEXT_LIMIT) break;
  }

  if (collected.length === 0) return normalizeBlockText(root.textContent ?? "").slice(0, FAST_TEXT_LIMIT);
  return collected.join("\n\n").slice(0, FAST_TEXT_LIMIT).trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fastPathFields(dom: JSDOM, url: string): { content: string; title: string | null; domain: string; language: string | null; wordCount: number; extractorType: string } {
  const document = dom.window.document;
  const content = extractFastMarkdown(dom);
  return {
    content,
    title: document.title || null,
    domain: new URL(url).hostname,
    language: document.documentElement.lang || null,
    wordCount: countWords(content),
    extractorType: "fast-dom",
  };
}

function newDom(html: string, url: string): JSDOM {
  const virtualConsole = new VirtualConsole(); // suppress noisy page-script console spam from jsdom
  return new JSDOM(html, { url, virtualConsole });
}

async function extractHtml(html: string, url: string): Promise<Omit<ExtractedPage, "url" | "contentType" | "fetchedAt">> {
  if (html.length >= FAST_PATH_HTML_THRESHOLD) {
    const fast = fastPathFields(newDom(html, url), url);
    return { ...fast, author: null, published: null, description: null, site: fast.domain };
  }

  try {
    const result = await withTimeout(
      Defuddle(newDom(html, url), url, { markdown: true, removeImages: true }),
      DEFUDDLE_TIMEOUT_MS,
      `Defuddle extraction exceeded ${DEFUDDLE_TIMEOUT_MS}ms`,
    );
    return {
      content: (result.content ?? "").trim(),
      title: result.title || null,
      author: result.author || null,
      published: result.published || null,
      description: result.description || null,
      domain: result.domain || null,
      language: result.language || null,
      wordCount: result.wordCount ?? null,
      site: result.site || null,
      ...(result.extractorType ? { extractorType: result.extractorType } : {}),
    };
  } catch (cause) {
    // A FRESH dom, not the one just handed to Defuddle: extraction libraries
    // commonly mutate their input in place while scoring, so the instance
    // Defuddle threw on may already be partially stripped — falling back on
    // it risked returning wrong (not just degraded) content.
    const fast = fastPathFields(newDom(html, url), url);
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ...fast,
      author: null,
      published: null,
      description: null,
      site: fast.domain,
      extractorType: "fast-dom-fallback",
      extractionWarning: `Defuddle extraction failed, used fallback: ${message}`,
    };
  }
}

interface GuardedResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
  readonly url: string;
  readonly contentType: string | undefined;
}

/**
 * Fetches `url`, following redirects MANUALLY (not via `fetch`'s automatic
 * handling) so every hop — including the initial URL — can be checked by
 * `resolvePublicHttpUrl` before being followed. A public URL that redirects
 * to a private/internal address is exactly the SSRF bypass automatic
 * redirect-following would otherwise allow straight through.
 *
 * Connects to the VALIDATED literal address (`connectAddress`), not by
 * re-resolving the hostname — `fetch()` doing its own independent DNS
 * lookup at connect time would reopen the exact DNS-rebinding/TOCTOU gap
 * `resolvePublicHttpUrl` closes (a hostname could resolve to a different,
 * unvalidated address the second time). An explicit `Host` header preserves
 * virtual-hosting AND — confirmed empirically against a real HTTPS site —
 * Bun's fetch still validates the TLS certificate against it correctly even
 * though the URL's own host is a literal IP.
 */
async function fetchTextGuarded(url: string): Promise<GuardedResponse> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const { url: validatedUrl, connectAddress } = await resolvePublicHttpUrl(current);
    const connectUrl = new URL(validatedUrl);
    connectUrl.hostname = isIP(connectAddress) === 6 ? `[${connectAddress}]` : connectAddress;

    const res = await fetchLimited(connectUrl.toString(), {
      timeoutMs: FETCH_TIMEOUT_MS,
      redirect: "manual",
      headers: { Host: validatedUrl.host },
    });

    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) {
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS}) while fetching ${url}`);
      current = new URL(location, validatedUrl).toString();
      continue;
    }

    const text = await readCapped(res, MAX_RESPONSE_BYTES, FETCH_TIMEOUT_MS);
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    // NOT res.url — that reflects the literal-IP connect URL we actually
    // requested. Report the real, human-meaningful hostname-based URL.
    return { status: res.status, ok: res.ok, text, url: validatedUrl.toString(), contentType };
  }
}

/** Bounds both cache memory and pagination depth for one page — see MAX_CACHED_CONTENT_CHARS. */
function capContent(content: string): string {
  if (content.length <= MAX_CACHED_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_CACHED_CONTENT_CHARS)}\n\n[content truncated at ${MAX_CACHED_CONTENT_CHARS} characters]`;
}

async function fetchAndExtract(url: string): Promise<ExtractedPage> {
  const normalized = new URL(url).toString();
  const cached = pageCache.get(normalized);
  if (cached) return cached;

  const res = await fetchTextGuarded(normalized);
  if (!res.ok) throw new Error(`request failed with status ${res.status}`);

  const htmlContent = isHtmlContentType(res.contentType);
  const textBasedContent = isTextBasedContentType(res.contentType);
  if (!htmlContent && !textBasedContent) {
    throw new Error(`unsupported content-type: ${res.contentType ?? "unknown"}`);
  }

  let page: ExtractedPage;
  if (textBasedContent && !htmlContent) {
    const content = toTextMarkdown(res.text, res.contentType);
    if (!content) throw new Error(`no readable text extracted from ${res.url}`);
    const parsedUrl = new URL(res.url);
    page = {
      url: res.url,
      title: deriveTitleFromUrl(res.url),
      author: null,
      published: null,
      description: null,
      domain: parsedUrl.hostname,
      language: null,
      wordCount: countWords(content),
      site: parsedUrl.hostname,
      contentType: res.contentType ?? null,
      content: capContent(content),
      fetchedAt: new Date().toISOString(),
    };
  } else {
    const extracted = await extractHtml(res.text, res.url);
    if (!extracted.content) {
      throw new Error(`no readable text extracted from ${res.url} — it may be behind a consent or paywall screen`);
    }
    page = {
      ...extracted,
      content: capContent(extracted.content),
      url: res.url,
      contentType: res.contentType ?? null,
      fetchedAt: new Date().toISOString(),
    };
  }

  pageCache.set(normalized, page, CACHE_TTL_MS);
  return page;
}

function paginate(
  content: string,
  startIndex: number,
): { totalLength: number; slice: string; hasMore: boolean; nextIndex: number | undefined } {
  const totalLength = content.length;
  const nextIndex = startIndex + CONTENT_CHUNK_SIZE;
  const slice = content.slice(startIndex, nextIndex);
  const hasMore = nextIndex < totalLength;
  return { totalLength, slice, hasMore, nextIndex: hasMore ? nextIndex : undefined };
}

export function webReaderTool(): ToolDefinition {
  return {
    name: "web_reader",
    durableTranscript: false,
    tool: tool({
      description:
        "Fetch a webpage and extract its content as clean Markdown with metadata (title, author, published date, description). " +
        "Use startIndex to paginate through long content — when hasMore is true, the response's nextIndex is the exact startIndex to pass to continue reading.",
      inputSchema: z.object({
        url: z.string().describe("Absolute URL to fetch (https://example.com/article)."),
        startIndex: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Character offset to resume from — pass the previous response's nextIndex verbatim (NOT totalLength) to continue reading."),
      }),
      execute: async ({ url, startIndex }) => {
        const page = await fetchAndExtract(url);
        const { totalLength, slice, hasMore, nextIndex } = paginate(page.content, startIndex ?? 0);
        return { ...page, content: slice, totalLength, startIndex: startIndex ?? 0, hasMore, nextIndex };
      },
    }),
    guidance: {
      id: "tool-web-reader",
      title: "web_reader",
      body: `Call to fetch a URL's full content — after web_search (snippets alone are not enough to answer from) or when the user shares a link. If hasMore is true, call again with startIndex set to the response's nextIndex value (NOT totalLength — that is the full document length, not a valid offset).`,
    },
  };
}
