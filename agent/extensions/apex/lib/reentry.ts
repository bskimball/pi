// reentry: the one-line surfacing shown when an existing session is resumed.
//
// The observatory splash is reserved for a genuinely fresh chat, so resuming
// an old session currently opens onto nothing at all. But re-entry is exactly
// the moment you need orientation: which sky is this, how long has it been,
// how much was already said. This is that, in one row plus the project's own
// constellation — never the full mark, so the splash stays special.

import { starFieldRow } from "./star-field.ts";
import { safeTruncateToWidth, safeVisibleWidth } from "./safe-text-layout.ts";

export interface ReentryTheme {
  fg(token: any, text: string): string;
}

export interface Reentry {
  /** Workspace label, already cleaned. */
  workspace: string;
  /** Seeds the same constellation the observatory would draw for this cwd. */
  seed: string;
  /** Conversation messages carried into this session. */
  messages: number;
  /** Milliseconds since the last entry, when a timestamp was readable. */
  sinceMs?: number;
  /** Context usage 0..1 when known; thins the sky the same way. */
  contextFill?: number;
}

const MIN_WIDTH = 24;

/**
 * Coarse age. The shared `formatAge` tops out at minutes because it measures
 * tool activity; a resumed session is usually hours or days old.
 */
function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 90) return `${Math.max(1, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`;
}

/**
 * One row: constellation, then the facts. Falls back to just the facts when
 * the terminal is too narrow to carry both.
 */
export function renderReentry(
  fg: ReentryTheme["fg"],
  width: number,
  view: Reentry,
): string[] {
  if (width < MIN_WIDTH) return [];

  const parts: string[] = [];
  if (view.workspace) {
    parts.push(fg("text", view.workspace.toUpperCase()));
  }
  parts.push(
    fg(
      "muted",
      view.messages === 1 ? "1 message" : `${view.messages} messages`,
    ),
  );
  if (view.sinceMs !== undefined && view.sinceMs > 0) {
    parts.push(fg("dim", `${elapsed(view.sinceMs)} ago`));
  }

  const dot = fg("borderMuted", "  \u00b7  ");
  const facts = parts.join(dot);
  const lead = `${fg("customMessageLabel", "\u25b4")} ${fg("dim", "resumed")}${dot}`;
  const line = `${lead}${facts}`;

  const rows: string[] = [];
  // The sky sits above the line at the same left margin, so re-entry reads as
  // a smaller composition in the same family as the splash.
  const skySpan = Math.min(width, 42);
  const sky = starFieldRow(fg, skySpan, view.seed, view.contextFill);
  if (sky.trim()) rows.push(safeTruncateToWidth(sky, width));

  rows.push(
    safeVisibleWidth(line) <= width
      ? line
      : safeTruncateToWidth(`${lead}${fg("muted", `${view.messages} messages`)}`, width),
  );
  return rows;
}
