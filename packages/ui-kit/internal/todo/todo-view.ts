// todo-view: Apex chrome for the session todo dock (plan/checklist + agents tab).
//
// Pure data + string building, in the same shape as the other Apex receipts:
// a builder that normalizes untrusted input into a `TodoListView`, and a
// renderer that turns that view into bounded, width-safe lines.
//
// Deliberately dependency-free presentation: no pi-tui Text/Markdown/Container,
// no timers, no invalidate/requestRender, no rendering state. Callers wrap
// `renderTodoList` in a passive WidthText so a failure degrades to one row.

import {
  padStartToWidth,
  safeTruncateToWidth,
  wrapPlainText,
} from "../presentation/safe-text-layout.ts";
import { cleanInline, fitLine } from "../presentation/ui-common.ts";
import { skinGlyphs } from "../presentation/skin.ts";
import { metaText, type StatusTheme } from "../presentation/receipt-tree.ts";

/**
 * The whole surface is a pointer to a plan, never the plan's full text, so the
 * output is hard-bounded regardless of how large the underlying list is.
 */
export const TODO_LIST_MAX_LINES = 18;

/**
 * Flat checklist geometry. The status glyph is the only left anchor: rows are
 * inset by one small step so the header still reads as their owner, and every
 * wrapped title or note hangs at the title column instead of on a rail.
 */
const ROW_INSET = "  ";
/** Cells before the title column: inset + glyph + separator. */
const TITLE_INDENT = ROW_INSET.length + 2;
const HANG_INSET = " ".repeat(TITLE_INDENT);
/**
 * Elision / status marker for the windowed head/tail rows and the empty agent
 * pane; occupies the same single cell as a status glyph. U+22EE is East Asian
 * Width Neutral, so it measures exactly one cell everywhere — unlike `…`
 * (U+2026, EAW=Ambiguous), which can render double-width and shear the title
 * column. A vertical ellipsis also reads correctly here: the elided content is
 * rows above and below, not characters to the right.
 */
const MORE_GLYPH = "\u22ee"; // ⋮

/** Upper bound on rendered recent-activity rows in the peek overlay. */
const PEEK_ACTIVITY_ROWS = 4;
/** Transcript tail lines rendered in the peek overlay. */
const PEEK_TRANSCRIPT_LINES = 12;
/** The fleet bus hard cap; every retained worker must remain selectable. */
const AGENT_ROWS = 8;
/** Rows the list is allowed to spend on items, before/after notes excluded. */
const ROWS_COLLAPSED = 6;
const ROWS_EXPANDED = 10;
/** Only the in-progress row may wrap, and only this far. */
const ACTIVE_TITLE_LINES = 2;
/** Upper bound on the items the builder will even look at. */
const MAX_ITEMS = 200;
const TITLE_CHARS = 200;
const NOTE_CHARS = 200;

export const CANONICAL_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;

export type TodoStatus = (typeof CANONICAL_STATUSES)[number];

/**
 * Status gutter: idle when open, active otherwise; status reads from color.
 * Getter-based so a live /ui switch swaps glyphs without re-import
 * (squares under the claude skin, circles under apex).
 */
const TODO_GLYPHS: Record<TodoStatus, string> = {
  get pending() {
    return skinGlyphs().statusIdle; // ○ / □
  },
  get in_progress() {
    return skinGlyphs().statusActive; // ● / ■
  },
  get blocked() {
    return skinGlyphs().statusActive; // ● / ■
  },
  get completed() {
    return skinGlyphs().statusActive; // ● / ■
  },
  get cancelled() {
    return skinGlyphs().statusIdle; // ○ / □
  },
};

const TODO_TONES: Record<TodoStatus, string> = {
  pending: "muted",
  in_progress: "warning",
  blocked: "error",
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

/** Map an untrusted status value onto the canonical vocabulary. */
export function toStatus(value: unknown): TodoStatus {
  const raw = safeText(value, 40).toLowerCase().trim();
  if (CANONICAL_STATUSES.includes(raw as TodoStatus)) {
    return raw as TodoStatus;
  }
  return "pending";
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
  /** Render only the header, for a docked panel that has been collapsed. */
  collapsed?: boolean;
  /** Optional key/command hint appended to the header's right side. */
  toggleHint?: string;
  /** Left inset matching the transcript's configured outputPad. */
  pad?: number;
  /** Actionable follow-up shown only when the list is empty. */
  emptyHint?: string;
  /** Tab strip when live agents share this dock. */
  tabs?: DockTabOptions;
}

export type DockPane = "todos" | "agents";

export interface DockTabOptions {
  pane: DockPane;
  agentCount: number;
  switchHint?: string;
  /** Right-side detail, typically the todo tally. */
  detail?: string;
}

export interface DockAgentActivity {
  /** Bounded tool name. */
  tool: string;
  /** Bounded primary argument: file, command, query, or prompt. */
  summary?: string;
  /** Activity status: "running" | "completed" | "error". */
  status: string;
}

export interface DockAgentItem {
  id: string;
  agent: string;
  lifecycle: string;
  createdAt: number;
  lastEventAt?: number;
  /** Live execution phase ("model" | "tool" | "retry" | "compacting" | "none"). */
  phase?: string;
  /** Name of the most recently started running tool, if any. */
  tool?: string;
  turns?: number;
  maxTurns?: number;
  generation?: number;
  /** Pending UI requests: the "blocked on a question" signal. */
  waitingUi?: number;
  /** Bounded short mission label tracking the current generation. */
  mission?: string;
  /** True for Fusion's single persistent sidekick. */
  fusion?: boolean;
  /** Worker session file path, when reported by the task extension. */
  sessionFile?: string;
  /** Recent tool activity, oldest first; at most 4 entries. */
  activity?: DockAgentActivity[];
}

const AGENT_GLYPHS: Record<string, string> = {
  get starting() {
    return skinGlyphs().statusIdle;
  },
  get running() {
    return skinGlyphs().statusActive;
  },
  get retrying() {
    return skinGlyphs().statusActive;
  },
  get compacting() {
    return skinGlyphs().statusActive;
  },
  get aborting() {
    return skinGlyphs().statusActive;
  },
};

const AGENT_TONES: Record<string, string> = {
  starting: "muted",
  running: "warning",
  retrying: "warning",
  compacting: "warning",
  aborting: "error",
};

const AGENT_LABELS: Record<string, string> = {
  starting: "starting",
  running: "running",
  retrying: "running",
  compacting: "running",
  aborting: "killed",
};

function agentAge(item: DockAgentItem, now: number): string {
  const stamp = item.lastEventAt ?? item.createdAt;
  const ms = Math.max(0, now - stamp);
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

function tabChip(
  theme: StatusTheme,
  label: string,
  count: number | undefined,
  active: boolean,
): string {
  const text = count === undefined ? label : `${label} ${count}`;
  return active
    ? theme.fg("accent", `[${text}]`)
    : theme.fg("muted", text);
}

export function renderDockTabs(
  theme: StatusTheme,
  width: number,
  tabs: DockTabOptions,
): string {
  const left = [
    tabChip(theme, "todos", undefined, tabs.pane === "todos"),
    theme.fg("dim", "/"),
    tabChip(theme, "agents", tabs.agentCount, tabs.pane === "agents"),
  ].join(" ");
  const right = [tabs.detail, tabs.switchHint]
    .filter(Boolean)
    .map((part) => theme.fg("dim", part as string))
    .join(" ");
  return fitLine(left, right, width);
}

export function renderAgentList(
  theme: StatusTheme,
  width: number,
  items: readonly DockAgentItem[],
  options: {
    collapsed?: boolean;
    tabs?: DockTabOptions;
    now?: number;
    selectedIndex?: number;
  } = {},
): string[] {
  if (width <= 0) return [];
  const now = options.now ?? Date.now();
  const header =
    options.tabs
      ? renderDockTabs(theme, width, options.tabs)
      : fitLine(
          theme.fg("toolTitle", "agents"),
          theme.fg("dim", `${items.length} agents`),
          width,
        );
  if (options.collapsed) return [safeTruncateToWidth(header, width)];
  if (!items.length) {
    return [
      header,
      safeTruncateToWidth(
        `${ROW_INSET}${theme.fg("dim", MORE_GLYPH)} ${theme.fg("muted", "no agents")}`,
        width,
      ),
    ].slice(0, TODO_LIST_MAX_LINES);
  }
  const liveCount = items.filter((item) => !canSwitchToSession(item.lifecycle)).length;
  const settledCount = items.length - liveCount;
  const truthfulHeader = options.tabs
    ? renderDockTabs(theme, width, {
        ...options.tabs,
        detail: metaText([
          liveCount ? `${liveCount} running` : undefined,
          settledCount ? `${settledCount} settled` : undefined,
        ]),
      })
    : header;
  const rows = items.slice(0, AGENT_ROWS).map((item, rowIndex) => {
    const glyph = AGENT_GLYPHS[item.lifecycle] ?? skinGlyphs().statusIdle;
    const tone = AGENT_TONES[item.lifecycle] ?? "muted";
    const title = cleanInline(item.agent, 40) || "agent";
    const state = workerStateText(item);
    const selected = options.selectedIndex === rowIndex;
    const marker = selected ? "\u25b8" : glyph;
    const markerTone = selected ? "accent" : tone;
    return safeTruncateToWidth(
      ROW_INSET +
        [
          theme.fg(markerTone, marker),
          theme.fg(selected ? "accent" : "text", title),
          theme.fg("dim", cleanInline(item.id, 40)),
          theme.fg("muted", state),
          theme.fg("dim", agentAge(item, now)),
        ].join(" "),
      width,
    );
  });
  return [safeTruncateToWidth(truthfulHeader, width), ...rows].slice(0, TODO_LIST_MAX_LINES);
}

/**
 * Map a box-local click y to a rendered agent-row index. The agents pane
 * renders header at row 0 and one row per worker after it, so y - 1 is the
 * index; anything outside the visible rows is not a row. Pure function so
 * tests exercise the mapping without a synthetic TUI.
 */
export function agentRowAtY(
  y: number,
  rowCount: number,
  visibleRows = AGENT_ROWS,
): number | undefined {
  if (!Number.isInteger(y) || y < 1) return undefined;
  const index = y - 1;
  if (index < 0 || index >= rowCount || index >= visibleRows) return undefined;
  return index;
}

/** Finite number from an untrusted value, or undefined. */
function finiteNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Guarded turn counter shared by the agents pane and the peek overlay. */
export function turnCountText(turns: unknown, maxTurns: unknown): string | undefined {
  if (typeof turns !== "number" || !Number.isFinite(turns)) return undefined;
  const capped =
    typeof maxTurns === "number" &&
    Number.isFinite(maxTurns) &&
    maxTurns > 0 &&
    maxTurns <= 100_000
      ? `/${Math.trunc(maxTurns)}`
      : "";
  return `${Math.trunc(turns)}${capped} turns`;
}

/** True when the worker session may be opened: settled or failed only. */
export function canSwitchToSession(lifecycle: unknown): boolean {
  return lifecycle === "settled" || lifecycle === "failed";
}

/** Live worker state line shared by the agents rows and the peek overlay. */
export function workerStateText(item: DockAgentItem): string {
  const waiting = (finiteNum(item.waitingUi) ?? 0) > 0;
  const label =
    (AGENT_LABELS[item.lifecycle] ?? safeText(item.lifecycle, 16)) || "agent";
  const tool = safeText(item.tool, 24);
  if (waiting) return "waiting for reply";
  if (tool) return `${label} ${tool}`;
  if (item.lifecycle === "running" && item.phase === "model") return "thinking";
  return label;
}

/**
 * Read-only peek overlay body for one worker: mission plus live state plus
 * the bounded recent-activity list plus the newest transcript lines that fit.
 * Never opens a SessionManager; the transcript tail is injected by the
 * caller (bounded read + tolerant parse live in todo-tools).
 */
export function renderPeekBody(
  theme: StatusTheme,
  width: number,
  item: DockAgentItem,
  options: {
    now?: number;
    transcript?: string[];
    canOpenHere?: boolean;
    maxLines?: number;
  } = {},
): string[] {
  if (width <= 0) return [];
  const now = options.now ?? Date.now();
  const waiting = (finiteNum(item.waitingUi) ?? 0) > 0;
  const state = workerStateText(item);
  const generation = finiteNum(item.generation);
  const detail = metaText([
    generation === undefined ? undefined : `gen ${Math.trunc(generation)}`,
    state,
    turnCountText(item.turns, item.maxTurns),
    agentAge(item, now),
  ]);
  const maxLines = Math.max(3, Math.min(TODO_LIST_MAX_LINES, options.maxLines ?? TODO_LIST_MAX_LINES));
  const lines = [
    safeTruncateToWidth(
      `${theme.fg("accent", safeText(item.agent, 40) || "agent")} ${theme.fg("dim", safeText(item.id, 40))} ${theme.fg("muted", safeText(item.mission, 80) || item.id)}`,
      width,
    ),
    safeTruncateToWidth(
      `${theme.fg("dim", MORE_GLYPH)} ${theme.fg(waiting ? "warning" : "muted", detail)}`,
      width,
    ),
  ];
  const activityBudget = Math.max(0, Math.min(PEEK_ACTIVITY_ROWS, maxLines - 3));
  const entries = activityBudget > 0
    ? (item.activity ?? []).slice(-activityBudget)
    : [];
  for (const entry of entries) {
    const name = safeText(readProp(entry, "tool"), 24) || "tool";
    const summary = safeText(readProp(entry, "summary"), 120);
    const status = safeText(readProp(entry, "status"), 16);
    const tone = status === "error" ? "error" : status === "running" ? "warning" : "dim";
    lines.push(
      safeTruncateToWidth(
        `${ROW_INSET}${theme.fg(tone, "\u25aa")} ${theme.fg("text", name)}${summary ? ` ${theme.fg("muted", summary)}` : ""}${status ? ` ${theme.fg("dim", status)}` : ""}`,
        width,
      ),
    );
  }
  if (!entries.length && maxLines >= 4) {
    lines.push(
      safeTruncateToWidth(
        `${ROW_INSET}${theme.fg("dim", "\u25aa")} ${theme.fg("muted", "no recent activity")}`,
        width,
      ),
    );
  }
  // Keep controls above the optional transcript so a short terminal never
  // clips the only way out of the overlay.
  let controls = "session still writing · esc/q: close";
  if (canSwitchToSession(item.lifecycle)) {
    controls = options.canOpenHere
      ? "o: open session · esc/q: close"
      : "o: prepare /agents open · esc/q: close";
  }
  lines.push(safeTruncateToWidth(theme.fg("dim", controls), width));

  const remaining = Math.max(0, maxLines - lines.length);
  if (remaining > 0) {
    const transcript = (options.transcript ?? []).slice(-PEEK_TRANSCRIPT_LINES);
    if (transcript.length) {
      if (remaining === 1) {
        lines.push(safeTruncateToWidth(theme.fg("muted", transcript.at(-1) ?? ""), width));
      } else {
        const newest = transcript.slice(-(remaining - 1));
        lines.push(
          safeTruncateToWidth(
            theme.fg("dim", "\u2500".repeat(Math.max(1, Math.min(width, 24)))),
            width,
          ),
        );
        for (const entry of newest) {
          lines.push(safeTruncateToWidth(theme.fg("muted", entry), width));
        }
      }
    } else {
      lines.push(safeTruncateToWidth(theme.fg("dim", "transcript unavailable"), width));
    }
  }
  return lines.slice(0, maxLines);
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

/** One item row: `  ● Render bounded rows   · blocked on theme`. */
function todoRow(
  theme: StatusTheme,
  width: number,
  item: TodoItem,
  title: string,
  note: string | undefined,
): string {
  const cells = [
    theme.fg(TODO_TONES[item.status], TODO_GLYPHS[item.status]),
    theme.fg(TITLE_TONES[item.status], title),
  ];
  if (note) cells.push(theme.fg("dim", `\u00b7 ${note}`));
  return safeTruncateToWidth(ROW_INSET + cells.join(" "), width);
}

/**
 * The one todo shape:
 *
 *   todos  Ship the harness (1 in progress · 3 pending)  ━━━───  2/6
 *     ⋮ 2 earlier
 *     ● Read the Observatory conventions
 *     ● Render bounded rows
 *       that keep working past the right edge of a narrow terminal
 *     ⋮ 3 more
 *
 * A flat checklist, not a task tree: the status glyph is the only left anchor,
 * and wrapped titles and notes hang at the title column. Everything after the
 * tool name gives way left-to-right as the terminal narrows, because `fitLine`
 * clips the left side only.
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
    if (options.tabs) {
      const header = renderDockTabs(theme, inner, options.tabs);
      if (options.collapsed) return emit([header]);
      return emit([
        header,
        safeTruncateToWidth(
          `${ROW_INSET}${theme.fg("muted", options.emptyHint || "no todos yet")}`,
          inner,
        ),
      ]);
    }
    const emptyHeader = fitLine(
      theme.fg("toolTitle", "todos"),
      theme.fg("muted", cleanInline(view.title || "no todos yet", 200)),
      inner,
    );
    if (!options.emptyHint) return emit([emptyHeader]);
    return emit([
      emptyHeader,
      safeTruncateToWidth(
        `${ROW_INSET}${theme.fg("dim", cleanInline(options.emptyHint, 200))}`,
        inner,
      ),
    ]);
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
  const toggleHint = options.toggleHint
    ? theme.fg("dim", `${options.collapsed ? "\u25b8" : "\u25be"} ${options.toggleHint}`)
    : "";
  const right = [
    progressRail(theme, view.done, view.total, track),
    theme.fg("dim", tally),
    toggleHint,
  ]
    .filter(Boolean)
    .join(" ");
  const header = options.tabs
    ? renderDockTabs(theme, inner, {
        ...options.tabs,
        detail: options.tabs.detail ?? tallyText,
      })
    : fitLine(headerLeft, right, inner);
  if (options.collapsed) return emit([header]);

  const limit = expanded ? ROWS_EXPANDED : ROWS_COLLAPSED;
  const { start, end } = windowFor(view.total, limit, view.anchorIndex);
  const rows: string[] = [];
  const elision = (text: string): string =>
    safeTruncateToWidth(
      `${ROW_INSET}${theme.fg("dim", MORE_GLYPH)} ${theme.fg("muted", text)}`,
      inner,
    );
  // Truthful: the skipped head is whatever precedes the window, which is not
  // necessarily completed work.
  if (start > 0) rows.push(elision(`${start} earlier`));
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
    rows.push(
      todoRow(
        theme,
        inner,
        item,
        wrapped[0] ?? item.title,
        wraps ? undefined : item.note,
      ),
    );
    if (wraps) {
      const hangs = [
        ...wrapped.slice(1),
        ...(item.note ? [`\u00b7 ${item.note}`] : []),
      ];
      for (const line of hangs) {
        rows.push(
          safeTruncateToWidth(`${HANG_INSET}${theme.fg("muted", line)}`, inner),
        );
      }
    }
  }
  const after = view.total - end;
  if (after > 0) rows.push(elision(`${after} more`));

  return emit([safeTruncateToWidth(header, inner), ...rows]);
}

export const PLAIN_STATUS_GLYPHS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  blocked: "[!]",
  completed: "[x]",
  cancelled: "[-]",
};

export function renderPlainTodoList(view: TodoListView, width: number): string[] {
  if (width <= 0) return [];
  if (view.total === 0) {
    const emptyHeader = view.title ? `Todos: ${view.title} (empty)` : "Todos (empty)";
    return [safeTruncateToWidth(emptyHeader, width)];
  }
  const titlePart = view.title ? `: ${view.title}` : "";
  const lines = [`Todos${titlePart} (${view.done}/${view.total} done)`];
  const { start, end } = windowFor(view.total, 9, view.anchorIndex);
  if (start > 0) lines.push(`... ${start} earlier`);
  for (let index = start; index < end; index++) {
    const item = view.items[index];
    const note = item.note ? ` · ${item.note}` : "";
    lines.push(`${PLAIN_STATUS_GLYPHS[item.status]} ${item.title}${note}`);
  }
  const after = view.total - end;
  if (after > 0) lines.push(`... ${after} more`);
  return lines
    .slice(0, TODO_LIST_MAX_LINES)
    .map((line) => safeTruncateToWidth(line, width));
}
