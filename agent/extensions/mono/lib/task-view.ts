// task-view: shared mission/activity summary helpers for sync and async tasks.
//
// Pure string helpers only — no rendering timers, no pi-tui components.

import { cleanInline } from "./ui-common.ts";

/**
 * Extract a short mission label from a multi-line task prompt.
 * Prefers a `goal:` line when present; otherwise the first non-empty line.
 */
export function missionFromPrompt(prompt: string): string {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => cleanInline(line, 180))
    .filter(Boolean);
  const goal = lines.find((line) => /^goal\s*:/i.test(line));
  return cleanInline(
    (goal ?? lines[0] ?? "Mission").replace(/^goal\s*:\s*/i, ""),
    140,
  );
}

/**
 * Compact primary-argument summary for a tool-call activity row.
 * Picks the first useful field rather than dumping full JSON.
 */
export function shortArgs(args: unknown): string {
  try {
    const a = args as Record<string, unknown>;
    return cleanInline(
      a?.command ??
        a?.path ??
        a?.pattern ??
        a?.url ??
        a?.query ??
        a?.prompt ??
        "",
      100,
    );
  } catch {
    return "";
  }
}

/** Flat one-line mission preview (list/status caps). */
export function missionPreview(prompt: string, max = 100): string {
  return cleanInline(prompt, max);
}

/** JSON-shaped args summary for activity logs that need the full payload. */
export function argsSummary(args: unknown, max = 120): string {
  try {
    return cleanInline(JSON.stringify(args ?? {}), max);
  } catch {
    return cleanInline(String(args ?? ""), max);
  }
}
