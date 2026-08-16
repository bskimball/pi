// notice-view: Apex chrome for background *notifications* injected into the
// transcript by extensions (async task settlement, background job settlement).
//
// These messages are not conversation. Without chrome they render as a raw
// `[custom-type]` block of prose that reads like something the user or the
// model said. This module gives them one recognizable, bounded receipt shape
// that matches the tool receipts, while keeping the worker/job identity,
// status, and the actionable follow-up commands visible.
//
// Presentation only, and deliberately dependency-free: no pi-tui
// Text/Markdown/Container, no visibleWidth/truncateToWidth, no timers.
// Everything is built from structured `details`, never re-parsed from the
// human-readable body that the model receives.

import { safeTruncateToWidth, wrapPlainText } from "./safe-text-layout.ts";
import { TREE, WidthText, cleanInline, fitLine } from "./ui-common.ts";
import { buildTreeLines, type TreeRow } from "./tree-view.ts";
import {
  detailRow,
  isTerminalKind,
  metaText,
  noteRow,
  safeLine,
  statusLabel,
  type StatusKind,
  type StatusTheme,
} from "./status-view.ts";
import type { Component } from "@earendil-works/pi-tui";

/** One settled worker/job inside a notification. */
export interface NoticeRow {
  kind: StatusKind;
  id: string;
  /** Who did the work: agent name, job title. */
  subject?: string;
  /** Dim trailing metadata: `gen 1 · 11 turns`, `exit 1 · SIGTERM`. */
  detail?: string;
  /** Bounded result/output text. Never the full payload. */
  preview?: string;
}

export interface NoticeOptions {
  /** Subsystem that raised the notice, e.g. `async task`. */
  channel: string;
  rows: readonly NoticeRow[];
  /** Actionable follow-up commands. Always kept; never truncated away first. */
  hint?: string;
  expanded: boolean;
  /** Left inset matching the transcript's configured outputPad. */
  pad?: number;
}

/** Rows the reader should treat as a failure: red tone and the failed count. */
function isFailureKind(kind: StatusKind): boolean {
  return kind === "failed" || kind === "killed";
}

// Hard bounds. A notification is a pointer to work, not the work itself.
const ROWS_COLLAPSED = 4;
const ROWS_EXPANDED = 12;
const PREVIEW_CHARS_COLLAPSED = 150;
const PREVIEW_CHARS_EXPANDED = 400;
const PREVIEW_LINES_EXPANDED = 3;

/**
 * Wrap bounded plain text onto at most `maxLines` continuation rows.
 *
 * Word-wrapped rather than chunked at a fixed character count, so a result
 * preview never breaks mid-token. `width` is the continuation column, which
 * `buildTreeLines` insets by the rail prefix.
 */
function previewRows(
  text: string,
  width: number,
  maxChars: number,
  maxLines: number,
): string[] {
  const clean = cleanInline(text, maxChars);
  if (!clean) return [];
  if (maxLines <= 1) return [safeTruncateToWidth(clean, width)];
  return wrapPlainText(clean, width, { maxLines }).filter(Boolean);
}

/**
 * The one notification shape:
 *
 *   ◇ notice  async task  1 settled                            background
 *   ├─ ✓ task_4  librarian  gen 1 · 11 turns · settled
 *   │  ## Findings ### Verdict: conditional pi-sticky-input@0.2.0 is …
 *   ╰─ task_status/task_wait for full results · task_send · task_close
 *
 * The `notice` root glyph and the right-rail `background` tag are what
 * separate this from a user turn; the rest is the same receipt vocabulary
 * used by every tool surface.
 */
export function noticeLines(
  theme: StatusTheme,
  width: number,
  options: NoticeOptions,
): string[] {
  const pad = Math.max(0, Math.min(options.pad ?? 0, 8));
  const inner = Math.max(8, width - pad);
  const inset = " ".repeat(pad);

  const rows = options.rows;
  // `killed` is a failure for the reader even though it is a distinct
  // lifecycle, so counts and tones agree with the per-row glyphs.
  const failed = rows.filter((row) => isFailureKind(row.kind)).length;
  const settled = rows.length - failed;
  const summary =
    metaText([
      settled ? `${settled} settled` : undefined,
      failed ? `${failed} failed` : undefined,
    ]) || "settled";

  // Below ~44 columns the channel word is what pushes the counts off the end,
  // and the row ids (`task_4`, `bg_1`) already name the subsystem, so it is the
  // first cell to go.
  const headerLeft = [
    theme.fg("dim", TREE.receipt),
    theme.fg("customMessageLabel", "notice"),
    inner >= 44 ? theme.fg("muted", safeLine(options.channel, 40)) : "",
    theme.fg(failed ? "error" : "text", summary),
  ]
    .filter(Boolean)
    .join(" ");
  // The `background` tag is the widest non-essential cell. It gives way first
  // so a narrow terminal keeps the counts instead of clipping them; the notice
  // glyph and label still distinguish this from a user turn.
  const header =
    inner >= 56
      ? fitLine(headerLeft, theme.fg("dim", "background"), inner)
      : safeTruncateToWidth(headerLeft, inner);

  const limit = options.expanded ? ROWS_EXPANDED : ROWS_COLLAPSED;
  const shown = rows.slice(0, limit);
  const hidden = rows.length - shown.length;

  // Continuation rows are inset by the rail prefix that buildTreeLines adds.
  const previewWidth = Math.max(8, inner - 3);
  const treeRows: TreeRow[] = [];
  for (const row of shown) {
    const preview = row.preview
      ? previewRows(
          row.preview,
          previewWidth,
          options.expanded ? PREVIEW_CHARS_EXPANDED : PREVIEW_CHARS_COLLAPSED,
          options.expanded ? PREVIEW_LINES_EXPANDED : 1,
        )
      : [];
    const built = detailRow(theme, inner, {
      kind: row.kind,
      id: row.id,
      text: row.subject,
      // The status word is repeated in the detail cell rather than the right
      // rail so the row stays readable when the terminal is narrow.
      detail: metaText([
        row.detail,
        isTerminalKind(row.kind) ? statusLabel(row.kind) : undefined,
      ]),
      token: isFailureKind(row.kind) ? "error" : "muted",
    });
    built.continuation = preview;
    built.continuationToken = isFailureKind(row.kind) ? "error" : "toolOutput";
    treeRows.push(built);
  }
  if (hidden > 0) {
    treeRows.push(noteRow(theme, inner, `${hidden} more not shown`, "muted"));
  }
  if (options.hint) {
    // The follow-up commands are the point of the notice, so the hint wraps
    // instead of clipping: a truncated `task_clo` is not actionable.
    const hintLines = wrapPlainText(safeLine(options.hint, 300), previewWidth, {
      maxLines: 3,
    }).filter(Boolean);
    const hintRow = noteRow(theme, inner, hintLines[0] ?? "", "muted");
    hintRow.continuation = hintLines.slice(1);
    hintRow.continuationToken = "muted";
    treeRows.push(hintRow);
  }

  return buildTreeLines(theme, inner, header, treeRows).map((line) =>
    inset ? safeTruncateToWidth(`${inset}${line}`, width) : line,
  );
}

/**
 * A message renderer body wrapped so any failure degrades to one bounded line
 * instead of taking down the transcript render.
 */
export function noticeComponent(
  theme: StatusTheme,
  options: NoticeOptions,
): Component {
  return new WidthText(
    (width) => noticeLines(theme, width, options),
    "[notification display unavailable]",
  );
}
