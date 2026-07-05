import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * Default toolset. One demo tool for now; real tools (weather, web search,
 * research subagent, …) get ported from mojo-ai3 one at a time.
 */
export function defaultTools(): ToolSet {
  return {
    local_time: tool({
      description: "Current date and time in a given IANA timezone.",
      inputSchema: z.object({
        timezone: z.string().describe("IANA timezone, e.g. Europe/Amsterdam"),
      }),
      execute: ({ timezone }) => {
        // Intl throws on bad timezones; let the loop surface it as a tool error.
        return {
          timezone,
          local: new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            dateStyle: "full",
            timeStyle: "long",
          }).format(new Date()),
        };
      },
    }),
  };
}
