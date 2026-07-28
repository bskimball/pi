// task-card: small safe-layout primitives shared by sync and async task views.
//
// These helpers deliberately provide tree chrome only. Each task extension owns
// its own header, report, and card layout.

import { padStartToWidth, safeTruncateToWidth } from "./safe-text-layout.ts";
import { DURATION_COLUMN, TREE, formatDuration } from "./ui-common.ts";

export type ActivityCardStatus = "running" | "completed" | "error";

export interface TaskCardTheme {
  fg(token: string, text: string): string;
}

export interface TreeRow {
  /** Receives the already-selected branch glyph (`├─` or `╰─`). */
  line: (rail: string) => string;
  /** Bounded text that hangs under this row rather than becoming a child. */
  continuation?: string[];
  /** Theme token for continuation text. Defaults to `toolOutput`. */
  continuationToken?: string;
}

/** Status glyph with the shared task activity palette. */
export function activityGlyph(theme: TaskCardTheme, status: ActivityCardStatus): string {
  if (status === "running") return theme.fg("warning", "●");
  if (status === "error") return theme.fg("error", "×");
  return theme.fg("success", "✓");
}

/** A dim, right-aligned duration suitable for a task activity row. */
export function durationText(theme: TaskCardTheme, ms: number): string {
  return theme.fg(
    "dim",
    padStartToWidth(formatDuration(Math.max(0, ms)), DURATION_COLUMN),
  );
}

/** Optional bounded rail text, for previews that belong under a card header. */
export function boundedRailTextLines(
  theme: TaskCardTheme,
  width: number,
  lines: readonly string[],
  token = "toolOutput",
): string[] {
  return lines.map((line) =>
    safeTruncateToWidth(
      `${theme.fg("dim", TREE.rail)}  ${theme.fg(token, line)}`,
      width,
    ),
  );
}

/**
 * Assemble a header and tree children while assigning exactly one terminal
 * branch. Continuations follow their owning child with `│` or `hang` chrome.
 */
export function buildTreeLines(
  theme: TaskCardTheme,
  width: number,
  headerLine: string,
  rows: readonly TreeRow[],
  railText: readonly string[] = [],
): string[] {
  const lines = [safeTruncateToWidth(headerLine, width), ...railText.map((line) => safeTruncateToWidth(line, width))];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const isLast = index === rows.length - 1;
    lines.push(safeTruncateToWidth(row.line(isLast ? TREE.last : TREE.branch), width));
    const prefix = isLast ? TREE.hang : `${theme.fg("dim", TREE.rail)}  `;
    for (const line of row.continuation ?? []) {
      lines.push(
        safeTruncateToWidth(
          `${prefix}${theme.fg(row.continuationToken ?? "toolOutput", line)}`,
          width,
        ),
      );
    }
  }
  return lines;
}
