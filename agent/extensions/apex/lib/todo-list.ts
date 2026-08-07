// todo-list: Apex chrome for an agent todo list (plan/checklist) surface.
//
// Pure data + string building, in the same shape as the other Apex receipts:
// a builder that normalizes untrusted input into a `TodoListView`, and a
// renderer that turns that view into bounded, width-safe lines.
//
// Deliberately dependency-free presentation: no pi-tui Text/Markdown/Container,
// no timers, no invalidate/requestRender, no rendering state. Callers wrap
// `renderTodoList` in a passive WidthText so a failure degrades to one row.

import { padStartToWidth, safeTruncateToWidth, wrapPlainText } from "./safe-text-layout.ts";
import { TREE, cleanInline, fitLine } from "./ui-common.ts";
import { buildTreeLines, type TreeRow } from "./task-card.ts";
import {
  emptyStateLines,
  metaText,
  noteRow,
  type StatusTheme,
} from "./status-view.ts";

/**
 * The whole surface is a pointer to a plan, never the plan's full text, so the
 * output is hard-bounded regardless of how large the underlying list is.
 */
export const TODO_LIST_MAX_LINES = 18;

/** Rows the list is allowed to spend on items, before/after notes excluded. */
const ROWS_COLLAPSED = 6;
const ROWS_EXPANDED = 10;
/** Only the in-progress row may wrap, and only this far. */
const ACTIVE_TITLE_LINES = 2;
/** Upper bound on the items the builder will even look at. */
const MAX_ITEMS = 200;
const TITLE_CHARS = 200;
const NOTE_CHARS = 200;

export type TodoStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled";

/** Narrow BMP glyphs only: every row is exactly one cell wide in the gutter. */
const TODO_GLYPHS: Record<TodoStatus, string> = {
  pending: "\u25cb", // ○
  in_progress: "\u25cf", // ●
  blocked: "\u2298", // ⊘
  completed: "\u2713", // ✓
  cancelled: "\u00d7", // ×
};

const TODO_TONES: Record<TodoStatus, string> = {
  pending: "muted",
  in_progress: "warning",
  blocked: "text",
  completed: "success",
  cancelled: "dim",
};

/** Text tone per status: settled work recedes, the active item reads first. */
const TITLE_TONES: Record<TodoStatus, string> = {
  pending: "muted",
  in_progress: "text",
  blocked: "muted",
  completed: "dim",
  cancelled: "dim",
};

export interface TodoItem {
  /** Stable identifier when the source has one; otherwise a positional id. */
  id: string;
  /** Single-line, bounded task text. */
  title: string;
  status: TodoStatus;
  /** Bounded dim detail: owner, blocker, follow-up. */
  note?: string;
}

export interface TodoListView {
  /** Optional plan/mission name shown in the header. */
  title: string;
  items: TodoItem[];
  counts: Record<TodoStatus, number>;
  total: number;
  /** completed + cancelled: work the reader no longer needs to track. */
  done: number;
  /** Index of the first in-progress item in `items`, or -1. */
  activeIndex: number;
  /**
   * Index used to center the collapsed window so open work stays visible.
   * Prefers first in_progress, else first blocked, else first pending, else -1.
   * Distinct from `activeIndex` so blocked/pending rows are not styled as active.
   */
  anchorIndex: number;
  /** Items dropped by the hard input cap, so the header can stay truthful. */
  dropped: number;
}

/**
 * Read one property from a hostile value. Getters, proxy traps, and revoked
 * proxies all throw on plain member access, so every read is guarded.
 */
function readProp(source: unknown, key: string): unknown {
  if (source === null || (typeof source !== "object" && typeof source !== "function")) {
    return undefined;
  }
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Single-line bounded text from an arbitrary value, or "" when the value
 * cannot be coerced at all (null-prototype objects, Symbols, throwing
 * `toString`/`Symbol.toPrimitive`). `cleanInline` itself calls `String(...)`,
 * which is exactly where those inputs throw, so the guard belongs here.
 */
function safeText(value: unknown, max: number): string {
  try {
    if (typeof value === "symbol") return cleanInline(value.toString(), max);
    return cleanInline(value, max);
  } catch {
    return "";
  }
}

/** Map an arbitrary status value onto the todo vocabulary. */
function toStatus(value: unknown): TodoStatus {
  const raw = safeText(value, 40)
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  switch (raw) {
    case "in_progress":
    case "active":
    case "doing":
    case "running":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "cancelled":
    case "canceled":
    case "skipped":
    case "dropped":
      return "cancelled";
    default:
      return "pending";
  }
}

/** Read a title from the several field names todo payloads use in practice. */
function toTitle(entry: unknown): string {
  for (const key of ["content", "title", "text"]) {
    const text = safeText(readProp(entry, key), TITLE_CHARS);
    if (text) return text;
  }
  // A bare scalar item is its own title; an object with no known field is not.
  if (entry !== null && typeof entry === "object") return "";
  return safeText(entry, TITLE_CHARS);
}

/**
 * Normalize an untrusted todo payload into a view. Never throws, never reads
 * the filesystem, and never keeps more than {@link MAX_ITEMS} entries.
 */
export function buildTodoList(
  raw: unknown,
  options: { title?: string } = {},
): TodoListView {
  // A hostile array-like (proxy, exotic length/slice) can throw on read, so the
  // whole intake is guarded; a payload that cannot be read is an empty list.
  // Capture a safe numeric source length inside the guard and never re-read
  // hostile raw/source properties afterward.
  let kept: unknown[] = [];
  let sourceLength = 0;
  try {
    if (Array.isArray(raw)) {
      const length = raw.length;
      sourceLength =
        typeof length === "number" && Number.isFinite(length)
          ? Math.max(0, Math.trunc(length))
          : 0;
      const sliced = raw.slice(0, MAX_ITEMS);
      kept = Array.isArray(sliced) ? sliced : [];
    }
  } catch {
    kept = [];
    sourceLength = 0;
  }
  const counts: Record<TodoStatus, number> = {
    pending: 0,
    in_progress: 0,
    blocked: 0,
    completed: 0,
    cancelled: 0,
  };
  const items: TodoItem[] = [];
  for (const entry of kept) {
    // Unrenderable entries are skipped rather than rendered as a blank row.
    const title = toTitle(entry);
    if (!title) continue;
    const status = toStatus(readProp(entry, "status") ?? readProp(entry, "state"));
    counts[status]++;
    items.push({
      id: safeText(readProp(entry, "id"), 40) || `todo_${items.length + 1}`,
      title,
      status,
      note:
        safeText(readProp(entry, "note") ?? readProp(entry, "detail"), NOTE_CHARS) ||
        undefined,
    });
  }
  const activeIndex = items.findIndex((item) => item.status === "in_progress");
  // Window on open work when nothing is in progress (e.g. all remaining is blocked).
  let anchorIndex = activeIndex;
  if (anchorIndex < 0) {
    anchorIndex = items.findIndex((item) => item.status === "blocked");
  }
  if (anchorIndex < 0) {
    anchorIndex = items.findIndex((item) => item.status === "pending");
  }
  return {
    title: safeText(readProp(options, "title"), 80),
    items,
    counts,
    total: items.length,
    done: counts.completed + counts.cancelled,
    activeIndex,
    anchorIndex,
    dropped: Math.max(0, sourceLength - kept.length),
  };
}

export interface TodoListOptions {
  /** Expanded surfaces get more rows and let the active item wrap. */
  expanded?: boolean;
  /** Left inset matching the transcript's configured outputPad. */
  pad?: number;
  /** Actionable follow-up shown only when the list is empty. */
  emptyHint?: string;
}

/**
 * A slice of `total` rows of size `limit`, centered on `anchor` so the item
 * actually being worked on stays visible in a long list.
 */
function windowFor(
  total: number,
  limit: number,
  anchor: number,
): { start: number; end: number } {
  if (total <= limit) return { start: 0, end: total };
  const half = Math.floor((limit - 1) / 2);
  const start = Math.max(0, Math.min(anchor < 0 ? 0 : anchor - half, total - limit));
  return { start, end: start + limit };
}

/** `━━━───` progress rail; sized to the terminal, omitted when it cannot fit. */
function progressRail(theme: StatusTheme, done: number, total: number, track: number): string {
  if (track <= 0 || total <= 0) return "";
  const cells = Math.max(0, Math.min(track, Math.round((done / total) * track)));
  return (
    theme.fg("success", "\u2501".repeat(cells)) +
    theme.fg("borderMuted", "\u2500".repeat(track - cells))
  );
}

/** Cells the tree rail and status glyph take before the title column. */
const TITLE_INDENT = 5;

/** One item row: `├─ ● Render bounded rows        · blocked on theme`. */
function todoRow(
  theme: StatusTheme,
  width: number,
  item: TodoItem,
  title: string,
  note: string | undefined,
): TreeRow {
  return {
    line: (rail) => {
      const cells = [
        theme.fg("dim", rail),
        theme.fg(TODO_TONES[item.status], TODO_GLYPHS[item.status]),
        theme.fg(TITLE_TONES[item.status], title),
      ];
      if (note) cells.push(theme.fg("dim", `\u00b7 ${note}`));
      return safeTruncateToWidth(cells.join(" "), width);
    },
  };
}

/**
 * The one todo shape:
 *
 *   ◆ todos  Ship the harness (1 in progress · 3 pending)  ━━━───  2/6
 *   ├─ 2 earlier
 *   ├─ ✓ Read the Observatory conventions
 *   ├─ ● Render bounded rows
 *   │  that keep working past the right edge of a narrow terminal
 *   ╰─ 3 more
 *
 * Everything after the tool name gives way left-to-right as the terminal
 * narrows, because `fitLine` clips the left side only.
 */
export function renderTodoList(
  theme: StatusTheme,
  width: number,
  view: TodoListView,
  options: TodoListOptions = {},
): string[] {
  if (width <= 0) return [];
  const pad = Math.max(0, Math.min(options.pad ?? 0, 8));
  const inner = Math.max(8, width - pad);
  const inset = " ".repeat(pad);
  const emit = (lines: readonly string[]): string[] =>
    lines
      .slice(0, TODO_LIST_MAX_LINES)
      .map((line) => safeTruncateToWidth(inset ? `${inset}${line}` : line, width));

  if (view.total === 0) {
    return emit(
      emptyStateLines(
        theme,
        inner,
        "todos",
        view.title || "no todos yet",
        options.emptyHint,
      ),
    );
  }

  const expanded = options.expanded === true;
  const meta = metaText([
    view.counts.in_progress ? `${view.counts.in_progress} in progress` : undefined,
    view.counts.blocked ? `${view.counts.blocked} blocked` : undefined,
    view.counts.pending ? `${view.counts.pending} pending` : undefined,
    view.counts.cancelled ? `${view.counts.cancelled} cancelled` : undefined,
    view.dropped ? `${view.dropped} not tracked` : undefined,
  ]);
  const headerLeft = [
    theme.fg("dim", TREE.header),
    theme.fg("toolTitle", "todos"),
    view.title ? theme.fg("text", view.title) : "",
    meta ? theme.fg("dim", `(${meta})`) : "",
  ]
    .filter(Boolean)
    .join(" ");
  const track = inner >= 72 ? 12 : inner >= 56 ? 8 : 0;
  // 5 is a minimum column, not a cap: `198/200` must never clip to `198/2`.
  const tallyText = `${view.done}/${view.total}`;
  const tally = padStartToWidth(tallyText, Math.max(5, tallyText.length));
  const right = [progressRail(theme, view.done, view.total, track), theme.fg("dim", tally)]
    .filter(Boolean)
    .join(" ");
  const header = fitLine(headerLeft, right, inner);

  const limit = expanded ? ROWS_EXPANDED : ROWS_COLLAPSED;
  const { start, end } = windowFor(view.total, limit, view.anchorIndex);
  const rows: TreeRow[] = [];
  // Truthful: the skipped head is whatever precedes the window, which is not
  // necessarily completed work.
  if (start > 0) rows.push(noteRow(theme, inner, `${start} earlier`, "muted"));
  // Only the active item is allowed to spend extra rows, and only when the
  // surface is expanded: that keeps the worst-case height flat.
  const titleWidth = Math.max(8, inner - TITLE_INDENT);
  for (let index = start; index < end; index++) {
    const item = view.items[index];
    const wrapped =
      expanded && index === view.activeIndex
        ? wrapPlainText(item.title, titleWidth, { maxLines: ACTIVE_TITLE_LINES })
        : [item.title];
    // A wrapped title owns the whole row, so the note moves to the last
    // continuation line rather than splitting the sentence in two.
    const wraps = wrapped.length > 1;
    const row = todoRow(
      theme,
      inner,
      item,
      wrapped[0] ?? item.title,
      wraps ? undefined : item.note,
    );
    if (wraps) {
      row.continuation = [
        ...wrapped.slice(1),
        ...(item.note ? [`\u00b7 ${item.note}`] : []),
      ];
      row.continuationToken = "muted";
    }
    rows.push(row);
  }
  const after = view.total - end;
  if (after > 0) rows.push(noteRow(theme, inner, `${after} more`, "muted"));

  return emit(buildTreeLines(theme, inner, header, rows));
}
