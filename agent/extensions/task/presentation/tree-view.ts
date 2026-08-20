// tree-view: deep, safe-layout tree primitives shared by bounded receipts.
//
// Hosts supply their header/status and host-specific rows; this module owns
// activity selection, activity rendering, tree terminality, rail continuation,
// and bounded line assembly.

import { padStartToWidth, safeTruncateToWidth } from "./safe-text-layout.ts";
import { boundExpandedCardText } from "../runtime/text-bounds.ts";
import {
  DURATION_COLUMN,
  TREE,
  fitLine,
  formatDuration,
} from "./ui-common.ts";

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

export interface TaskCardActivity {
  tool: string;
  summary: string;
  status: ActivityCardStatus;
  startedAt: number;
  duration?: number;
}

export interface ActivityRowsOptions {
  expanded: boolean;
  collapsedLimit?: number;
  expandedLimit?: number;
  now?: number;
  /** Keep all currently-running activities even when the history is clipped. */
  preserveRunning?: boolean;
  /** Label for a clipped-history row. */
  hiddenLabel?: (count: number) => string;
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

/**
 * Build shared activity rows. Completed history is tail-clipped while running
 * tools remain visible, so Mission and Worker cards cannot diverge on overlap,
 * limits, duration alignment, or hidden-history signaling.
 */
export function activityRows(
  theme: TaskCardTheme,
  width: number,
  activities: readonly TaskCardActivity[],
  options: ActivityRowsOptions,
): TreeRow[] {
  const limit = options.expanded
    ? (options.expandedLimit ?? 16)
    : (options.collapsedLimit ?? 4);
  const now = options.now ?? Date.now();
  const preserveRunning = options.preserveRunning !== false;
  const running = preserveRunning
    ? activities.filter((activity) => activity.status === "running")
    : [];
  const completed = preserveRunning
    ? activities.filter((activity) => activity.status !== "running")
    : [...activities];
  const historyLimit = Math.max(0, limit - running.length);
  const shown = preserveRunning
    ? [...completed.slice(-historyLimit), ...running].slice(-Math.max(limit, running.length))
    : completed.slice(-limit);
  const hidden = Math.max(0, activities.length - shown.length);
  const rows: TreeRow[] = [];
  if (hidden > 0) {
    const label = options.hiddenLabel?.(hidden) ?? `${hidden} more steps`;
    rows.push({
      line: (rail) =>
        safeTruncateToWidth(
          `${theme.fg("dim", rail)} ${theme.fg("muted", `▸ ${label}`)}`,
          width,
        ),
    });
  }
  for (const activity of shown) {
    rows.push({
      line: (rail) => {
        const glyph = activityGlyph(theme, activity.status);
        const detail = activity.summary
          ? ` ${theme.fg("dim", activity.summary)}`
          : "";
        const elapsed = durationText(
          theme,
          activity.duration ?? Math.max(0, now - activity.startedAt),
        );
        return fitLine(
          `${theme.fg("dim", rail)} ${glyph} ${theme.fg("muted", activity.tool)}${detail}`,
          elapsed,
          width,
        );
      },
    });
  }
  return rows;
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
  options: { hasFollowingContent?: boolean } = {},
): string[] {
  const lines = [safeTruncateToWidth(headerLine, width), ...railText.map((line) => safeTruncateToWidth(line, width))];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const isLast =
      index === rows.length - 1 && !options.hasFollowingContent;
    lines.push(safeTruncateToWidth(row.line(isLast ? TREE.last : TREE.branch), width));
    const prefix = isLast ? TREE.hang : `${theme.fg("dim", TREE.rail)}  `;
    const continuation = boundExpandedCardText(
      (row.continuation ?? []).join("\n"),
      { maxChars: 2_400, maxLines: 8 },
    ).text.split("\n").filter((line, index, all) => !(all.length === 1 && line === ""));
    for (const line of continuation) {
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
