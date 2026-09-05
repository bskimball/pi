// status-view: one status vocabulary and flat, width-aware receipt chrome for
// background jobs (bg_*) and async tasks (task_*).
//
// Deliberately dependency-free presentation: no pi-tui Text/Markdown/Container,
// no visibleWidth/truncateToWidth, no timers. Every builder returns plain
// strings that the caller clips through safe-text-layout.

import { padStartToWidth, safeTruncateToWidth } from "./safe-text-layout.ts";
import {
  DURATION_COLUMN,
  TREE,
  cleanInline,
  fitLine,
  formatDuration,
} from "./ui-common.ts";
import type { TreeRow } from "./tree-view.ts";

export interface StatusTheme {
  fg(token: string, text: string): string;
}

/**
 * The single status vocabulary shared by all background-job and task surfaces.
 * specific words (lifecycle names, exit reasons) are mapped onto these so the
 * transcript reads the same regardless of which subsystem produced the row.
 */
export type StatusKind =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "succeeded"
  | "settled"
  | "failed"
  | "killed"
  | "closed"
  | "unknown";

const TONES: Record<StatusKind, string> = {
  queued: "muted",
  starting: "muted",
  running: "warning",
  waiting: "warning",
  succeeded: "success",
  settled: "success",
  failed: "error",
  killed: "error",
  closed: "muted",
  unknown: "muted",
};

/** Status is carried by color, not shape: open circle when idle, filled otherwise. */
const GLYPHS: Record<StatusKind, string> = {
  queued: "\u25cb",
  starting: "\u25cb",
  running: "\u25cf",
  waiting: "\u25cf",
  succeeded: "\u25cf",
  settled: "\u25cf",
  failed: "\u25cf",
  killed: "\u25cf",
  closed: "\u25cb",
  unknown: "\u25cb",
};

const LABELS: Record<StatusKind, string> = {
  queued: "queued",
  starting: "starting",
  running: "running",
  waiting: "waiting",
  succeeded: "succeeded",
  settled: "settled",
  failed: "failed",
  killed: "killed",
  closed: "closed",
  unknown: "unknown",
};

export function statusTone(kind: StatusKind): string {
  return TONES[kind] ?? "muted";
}

export function statusLabel(kind: StatusKind): string {
  return LABELS[kind] ?? "unknown";
}

export function statusGlyph(theme: StatusTheme, kind: StatusKind): string {
  return theme.fg(statusTone(kind), GLYPHS[kind] ?? "\u25cb");
}

export function isTerminalKind(kind: StatusKind): boolean {
  return (
    kind === "succeeded" ||
    kind === "settled" ||
    kind === "failed" ||
    kind === "killed" ||
    kind === "closed"
  );
}

/** Map a bg-process job status (possibly malformed) onto the shared vocabulary. */
export function bgStatusKind(status: unknown): StatusKind {
  switch (String(status ?? "")) {
    case "running":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "killed":
      return "killed";
    default:
      return "unknown";
  }
}

/** Map an async worker lifecycle (possibly malformed) onto the shared vocabulary. */
export function lifecycleKind(lifecycle: unknown): StatusKind {
  switch (String(lifecycle ?? "")) {
    case "starting":
      return "starting";
    case "running":
    case "retrying":
    case "compacting":
      return "running";
    case "aborting":
      return "killed";
    case "settled":
      return "settled";
    case "failed":
      return "failed";
    case "closed":
      return "closed";
    default:
      return "unknown";
  }
}

/* ------------------------------------------------------------------ */
/* Safe scalar coercion                                                */
/* ------------------------------------------------------------------ */

/** A finite number, or undefined for anything else (null, NaN, strings…). */
export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** A non-empty single-line string, or "" for anything else. */
export function safeLine(value: unknown, max = 120): string {
  return cleanInline(value, Math.max(1, max));
}

/** Elapsed/age text from an epoch pair, tolerating missing or bogus stamps. */
export function spanText(
  startedAt: unknown,
  endedAt: unknown,
  now: number,
): string {
  const start = finiteNumber(startedAt);
  if (start === undefined) return "";
  const end = finiteNumber(endedAt) ?? now;
  return formatDuration(Math.max(0, end - start));
}

/**
 * Last `maxLines` meaningful lines of a possibly huge / non-string blob.
 * Bounded twice: characters first (from the tail), then lines.
 */
export function tailLines(
  value: unknown,
  maxLines: number,
  maxChars = 160,
): string[] {
  const limit = Math.max(0, maxLines);
  if (limit === 0) return [];
  let text: string;
  try {
    text = typeof value === "string" ? value : String(value ?? "");
  } catch {
    return [];
  }
  if (!text) return [];
  // Read only the tail we could possibly display.
  const window = limit * (maxChars + 2) + 64;
  if (text.length > window) text = text.slice(text.length - window);
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = lines.length - 1; index >= 0 && kept.length < limit; index--) {
    const line = cleanInline(lines[index], maxChars);
    if (!line) continue;
    kept.push(line);
  }
  return kept.reverse();
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

/** ` (a · b · c)` metadata, or "" when nothing useful is known. */
export function metaText(parts: Array<string | false | undefined>): string {
  const kept = parts.filter((part): part is string => !!part);
  return kept.length ? kept.join(" \u00b7 ") : "";
}

export interface ReceiptHeaderOptions {
  /** Tool identity, e.g. `bg_status`. Always shown. */
  tool: string;
  /** Stable identifier, e.g. `bg_1` / `task_2`. */
  id?: string;
  /** Primary human subject: command, mission, agent. */
  subject?: string;
  /** Parenthesised metadata (model, turns, pid…). */
  meta?: string;
  /** Shared-vocabulary state for the right rail. */
  kind?: StatusKind;
  /** Overrides the default label for `kind`. */
  label?: string;
  /** Right-aligned duration/age text. */
  duration?: string;
  /** Root glyph override for headers without a status kind; defaults to an idle circle. */
  rootGlyph?: string;
}

/**
 * The one receipt header shape used by every background-job and task surface:
 *
 *   ● bg_status  bg_1  npm run dev (pid 4821)      running   2m10s
 *
 * The root is always a circle: open when idle, filled otherwise, painted in
 * the receipt's status tone. Everything after `tool` is optional and gives
 * way left-to-right as the terminal narrows, because `fitLine` clips the
 * left side only.
 */
export function receiptHeader(
  theme: StatusTheme,
  width: number,
  options: ReceiptHeaderOptions,
): string {
  const glyph = options.kind
    ? statusGlyph(theme, options.kind)
    : theme.fg("dim", options.rootGlyph ?? TREE.receipt);
  const parts = [glyph, theme.fg("toolTitle", safeLine(options.tool, 40))];
  const id = safeLine(options.id, 40);
  if (id) parts.push(theme.fg("dim", id));
  const subject = safeLine(options.subject, 400);
  if (subject) parts.push(theme.fg("text", subject));
  const meta = safeLine(options.meta, 200);
  if (meta) parts.push(theme.fg("dim", `(${meta})`));
  const left = parts.join(" ");

  const kind = options.kind;
  const state = kind
    ? theme.fg(statusTone(kind), safeLine(options.label ?? statusLabel(kind), 40))
    : "";
  const duration = options.duration
    ? theme.fg("dim", padStartToWidth(safeLine(options.duration, 12), DURATION_COLUMN))
    : "";
  const right = [state, duration].filter(Boolean).join(" ");
  return right ? fitLine(left, right, width) : safeTruncateToWidth(left, width);
}

export interface DetailRowOptions {
  /** Shared-vocabulary state; renders as the row's leading glyph. */
  kind?: StatusKind;
  /** Bright identifier for the row (job id, request id…). */
  id?: string;
  /** The row's readable content. */
  text?: string;
  /** Dim trailing detail appended to `text`. */
  detail?: string;
  /** Right-aligned duration/age. */
  duration?: string;
  /** Theme token for `text`. Defaults to `muted`. */
  token?: string;
}

/** One scannable child row: `├─ ● bg_1  npm run dev            2m10s`. */
export function detailRow(
  theme: StatusTheme,
  width: number,
  options: DetailRowOptions,
): TreeRow {
  return {
    line: (rail) => {
      const cells = [theme.fg("dim", rail)];
      if (options.kind) cells.push(statusGlyph(theme, options.kind));
      const id = safeLine(options.id, 40);
      if (id) cells.push(theme.fg("accent", id));
      const text = safeLine(options.text, 400);
      if (text) cells.push(theme.fg(options.token ?? "muted", text));
      const detail = safeLine(options.detail, 300);
      if (detail) cells.push(theme.fg("dim", detail));
      const left = cells.join(" ");
      const duration = safeLine(options.duration, 12);
      return duration
        ? fitLine(
            left,
            theme.fg("dim", padStartToWidth(duration, DURATION_COLUMN)),
            width,
          )
        : safeTruncateToWidth(left, width);
    },
  };
}

/** A dim `key: value` note row. */
export function noteRow(
  theme: StatusTheme,
  width: number,
  text: unknown,
  token = "dim",
): TreeRow {
  return {
    line: (rail) =>
      safeTruncateToWidth(
        `${theme.fg("dim", rail)} ${theme.fg(token, safeLine(text, 400))}`,
        width,
      ),
  };
}

/**
 * An elegant empty state: a quiet receipt root plus a single actionable hint,
 * instead of a bare "No background jobs." sentence.
 */
export function emptyStateLines(
  theme: StatusTheme,
  width: number,
  tool: string,
  headline: string,
  hint?: string,
): string[] {
  const header = fitLine(
    `${theme.fg("dim", TREE.receipt)} ${theme.fg("toolTitle", safeLine(tool, 40))}`,
    theme.fg("muted", safeLine(headline, 200)),
    width,
  );
  if (!hint) return [header];
  return [
    header,
    safeTruncateToWidth(
      `${theme.fg("dim", TREE.last)} ${theme.fg("dim", safeLine(hint, 200))}`,
      width,
    ),
  ];
}

/**
 * Bounded output preview rows hanging under a card, one per line.
 * `token` lets stderr render in the error tone without a second helper.
 */
export function previewLines(
  theme: StatusTheme,
  width: number,
  lines: readonly string[],
  token = "toolOutput",
): string[] {
  return lines.map((line) =>
    safeTruncateToWidth(
      `${theme.fg("dim", TREE.rail)}  ${theme.fg(token, safeLine(line, 400))}`,
      width,
    ),
  );
}
