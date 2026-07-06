import { JSDOM, VirtualConsole } from "jsdom";
import { Defuddle } from "defuddle/node";
import { tool } from "ai";
import { z } from "zod";
import { fetchText } from "./http.ts";
import { TtlCache } from "./cache.ts";
import type { ToolDefinition } from "./define.ts";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const CONTENT_CHUNK_SIZE = 20_000;
const FAST_PATH_HTML_THRESHOLD = 1_000_000; // above this, skip Defuddle entirely — see extractFastMarkdown
const FAST_TEXT_LIMIT = 120_000;
const DEFUDDLE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

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

async function extractHtml(html: string, url: string): Promise<Omit<ExtractedPage, "url" | "contentType" | "fetchedAt">> {
  const virtualConsole = new VirtualConsole(); // suppress noisy page-script console spam from jsdom
  const dom = new JSDOM(html, { url, virtualConsole });

  if (html.length >= FAST_PATH_HTML_THRESHOLD) {
    const fast = fastPathFields(dom, url);
    return { ...fast, author: null, published: null, description: null, site: fast.domain };
  }

  try {
    const result = await withTimeout(
      Defuddle(dom, url, { markdown: true, removeImages: true }),
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
  } catch {
    const fast = fastPathFields(dom, url);
    return {
      ...fast,
      author: null,
      published: null,
      description: null,
      site: fast.domain,
      extractorType: "fast-dom-fallback",
    };
  }
}

async function fetchAndExtract(url: string): Promise<ExtractedPage> {
  const normalized = new URL(url).toString();
  const cached = pageCache.get(normalized);
  if (cached) return cached;

  const res = await fetchText(normalized, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES });
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
      content,
      fetchedAt: new Date().toISOString(),
    };
  } else {
    const extracted = await extractHtml(res.text, res.url);
    if (!extracted.content) {
      throw new Error(`no readable text extracted from ${res.url} — it may be behind a consent or paywall screen`);
    }
    page = { ...extracted, url: res.url, contentType: res.contentType ?? null, fetchedAt: new Date().toISOString() };
  }

  pageCache.set(normalized, page, CACHE_TTL_MS);
  return page;
}

function paginate(content: string, startIndex: number): { totalLength: number; slice: string; hasMore: boolean } {
  const totalLength = content.length;
  const slice = content.slice(startIndex, startIndex + CONTENT_CHUNK_SIZE);
  const hasMore = startIndex + CONTENT_CHUNK_SIZE < totalLength;
  return { totalLength, slice, hasMore };
}

export function webReaderTool(): ToolDefinition {
  return {
    name: "web_reader",
    durableTranscript: false,
    tool: tool({
      description:
        "Fetch a webpage and extract its content as clean Markdown with metadata (title, author, published date, description). " +
        "Use startIndex to paginate through long content — the response includes totalLength and hasMore when truncated.",
      inputSchema: z.object({
        url: z.string().describe("Absolute URL to fetch (https://example.com/article)."),
        startIndex: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Character offset to resume from — set to the previous response's totalLength boundary to continue reading."),
      }),
      execute: async ({ url, startIndex }) => {
        const page = await fetchAndExtract(url);
        const { totalLength, slice, hasMore } = paginate(page.content, startIndex ?? 0);
        return { ...page, content: slice, totalLength, startIndex: startIndex ?? 0, hasMore };
      },
    }),
    guidance: {
      id: "tool-web-reader",
      title: "web_reader",
      body: `Call to fetch a URL's full content — after web_search (snippets alone are not enough to answer from) or when the user shares a link. If hasMore is true, call again with startIndex set to the previous response's totalLength to continue reading.`,
    },
  };
}
