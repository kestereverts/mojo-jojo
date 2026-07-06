import { tool } from "ai";
import { z } from "zod";
import { fetchText } from "./http.ts";
import type { ToolDefinition } from "./define.ts";

const PORTAL_BASE_URL = process.env.MOJO_PORTAL_BASE_URL ?? "https://mojo.v00l.com";

function requireApiKey(): string {
  const key = process.env.MOJO_PORTAL_API_KEY;
  if (!key) throw new Error("MOJO_PORTAL_API_KEY is not configured");
  return key;
}

/** The portal's error responses are sometimes JSON (`{"error": "..."}`), sometimes plain text (deserialize failures) — try JSON first, fall back to the raw body. */
function extractErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error ?? body;
  } catch {
    return body;
  }
}

export function pasteTool(): ToolDefinition {
  return {
    name: "paste",
    durableTranscript: true,
    tool: tool({
      description:
        "Upload text content to the Mojo Portal paste service and get a shareable URL. Supports multiple files in one paste (like a GitHub Gist). " +
        "Use when a response would exceed IRC's line-length limits, or to share code, logs, or long-form text (poems, stories, detailed explanations).",
      inputSchema: z.object({
        title: z.string().optional().describe("Title for the paste. Defaults to 'Mojo Paste' if omitted."),
        files: z
          .array(
            z.object({
              filename: z.string(),
              content: z.string(),
              language: z.string().optional().describe("Language identifier for syntax highlighting."),
              renderMarkdown: z.boolean().optional().describe("Render this file as Markdown."),
            }),
          )
          .min(1)
          .describe("One entry per file. Use a one-item array for a single-file paste."),
      }),
      execute: async ({ title, files }) => {
        const apiKey = requireApiKey();
        const res = await fetchText(`${PORTAL_BASE_URL}/api/paste`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
          body: JSON.stringify({
            title: title?.trim() || "Mojo Paste",
            files: files.map((f) => ({
              filename: f.filename,
              content: f.content,
              language: f.language,
              render_markdown: f.renderMarkdown,
            })),
          }),
        });
        if (!res.ok) throw new Error(`paste failed: ${extractErrorMessage(res.text)}`);
        const { id, url } = JSON.parse(res.text) as { id: string; url: string };
        return { id, url };
      },
    }),
    guidance: {
      id: "tool-paste",
      title: "paste",
      body: `Call to upload long text/code/logs and get a shareable Mojo Portal URL, instead of dumping a huge reply into IRC. Pass files: [{ filename, content, language?, renderMarkdown? }] — one entry per file, or a one-item array for a single file. Always relay the returned URL to the user; never fabricate a URL.`,
    },
  };
}
