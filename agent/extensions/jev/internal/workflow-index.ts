// Pure workflow-index helpers. No Pi imports, I/O, or network.

/** Bounds the project-context slice sent with the prompt. Keeps per-turn input near current cost. */
export const MAX_CONTEXT_CHARS = 1_500;

/** AGENTS.md section that lists host workflows and the skill that owns each. */
const SKILLS_SECTION_MARKER = "### Skills";

/**
 * Slice the host project's workflow index (AGENTS.md `### Skills` section) so
 * Jev sees project context alongside the bare user prompt. The per-skill
 * catalog remains the Choice options; this is state, not a second vote. It
 * fails open: any misshape returns undefined and routing falls back to the
 * bare prompt exactly as before.
 */
export function extractWorkflowIndex(
  contextFiles: Array<{ path: string; content: string }> | undefined,
  cwd: string,
  maxChars = MAX_CONTEXT_CHARS,
): string | undefined {
  if (!contextFiles || contextFiles.length === 0 || maxChars <= 0) return undefined;
  // Deepest project file wins; the global agent-dir context carries no skills table.
  // No marker anywhere means the host declares no workflow index: stay on the
  // bare prompt rather than mislabeling unrelated context as one.
  const deepest = [...contextFiles]
    .filter((file) => typeof file.content === "string")
    .sort((a, b) => b.path.length - a.path.length)
    .find((file) => file.content.includes(SKILLS_SECTION_MARKER));
  if (!deepest) return undefined;
  const markerAt = deepest.content.indexOf(SKILLS_SECTION_MARKER);
  const section = deepest.content.slice(markerAt).trim();
  if (!section) return undefined;
  const label = deepest.path.replace(/\\/g, "/").split("/").at(-1) ?? deepest.path;
  const prefix = `Project workflow index (${label}, cwd ${cwd.replace(/\\/g, "/")}):\n`;
  const budget = Math.max(0, maxChars - prefix.length);
  if (budget <= 1) return undefined;
  // maxChars bounds the whole block: reserve one char so the ellipsis never overflows it.
  const body = section.length > budget ? `${section.slice(0, budget - 1).trimEnd()}\u2026` : section;
  return `${prefix}${body}`;
}
