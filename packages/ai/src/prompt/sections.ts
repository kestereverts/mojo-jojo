/** One titled block of the assembled system prompt. */
export interface PromptSection {
  /** Stable identifier (for tooling — the leak detector embeds per-section, M7). */
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/**
 * Assemble sections into the final instructions string, in the given order.
 * Order is the caller's responsibility (`mojo-ai.ts` fixes it); this just
 * formats — no section is more or less important structurally than another.
 */
export function assembleInstructions(sections: readonly PromptSection[]): string {
  return sections.map((s) => `## ${s.title}\n\n${s.body}`).join("\n\n---\n\n");
}
