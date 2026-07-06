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

function extractErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error ?? body;
  } catch {
    return body;
  }
}

/**
 * Accepts either a bare paste ID (`:GESjAk`, with or without the leading
 * colon) or a full portal URL (`https://mojo.v00l.com/:GESjAk`) — parsed via
 * the `URL` API's `pathname`, not mojo-ai3's nested regex/string-split
 * heuristics, which had to special-case each input shape by hand.
 */
function extractPasteId(input: string): string {
  const trimmed = input.trim();
  let id: string;
  try {
    id = new URL(trimmed).pathname.replace(/^\//, "");
  } catch {
    id = trimmed.replace(/^\//, "");
  }
  if (!id) throw new Error(`could not extract a paste ID from "${input}"`);
  return id.startsWith(":") ? id : `:${id}`;
}

export function getPasteTool(): ToolDefinition {
  return {
    name: "get_paste",
    durableTranscript: true,
    tool: tool({
      description:
        "Retrieve content previously uploaded to the Mojo Portal paste service. " +
        "Use when the user provides a Mojo Portal URL (e.g. https://mojo.v00l.com/:GESjAk) or a bare paste ID (e.g. :GESjAk) and asks to read it.",
      inputSchema: z.object({
        id: z.string().describe("The paste ID (e.g. ':GESjAk') or full portal URL."),
      }),
      execute: async ({ id }) => {
        const apiKey = requireApiKey();
        const pasteId = extractPasteId(id);
        const res = await fetchText(`${PORTAL_BASE_URL}/api/paste/${pasteId}`, {
          headers: { "X-API-Key": apiKey },
        });
        if (res.status === 404) throw new Error("paste not found");
        if (!res.ok) throw new Error(`get_paste failed: ${extractErrorMessage(res.text)}`);
        const data = JSON.parse(res.text) as {
          title: string;
          files: { filename: string; content: string; language?: string }[];
        };
        return {
          title: data.title,
          files: data.files.map((f) => ({ filename: f.filename, content: f.content, language: f.language })),
        };
      },
    }),
    guidance: {
      id: "tool-get-paste",
      title: "get_paste",
      body: `Call when the user shares a Mojo Portal URL or paste ID and asks about its contents.`,
    },
  };
}
