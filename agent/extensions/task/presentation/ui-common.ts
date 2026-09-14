// ui-common: rendering helpers shared by amp-task and apex-ui.

import type { Component } from "@earendil-works/pi-tui";
import {
  renderLinesSafely,
  safeTruncateToWidth,
  safeVisibleWidth,
  stripTerminalSequences,
} from "./safe-text-layout.ts";

export function stripAnsi(text: string): string {
  return stripTerminalSequences(text);
}

export function cleanInline(value: unknown, max = 120): string {
  const text = stripAnsi(String(value ?? ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

/** Join text blocks, stopping once the optional character budget is filled. */
function takeText(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    return value.length > maxChars ? value.slice(0, maxChars) : value;
  }
  const text = String(value ?? "");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export function textContent(result: any, maxChars = 50_000): string {
  if (!Array.isArray(result?.content)) return "";
  let text = "";
  for (const item of result.content) {
    if (item?.type !== "text") continue;
    const remaining = maxChars - text.length - (text ? 1 : 0);
    if (remaining <= 0) break;
    const piece = takeText(item.text, remaining);
    if (!piece) continue;
    text = text ? `${text}\n${piece}` : piece;
  }
  return text;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Skin name for task gutters. Mirrors the ui-kit skin contract so
 * sub-agent cards use the same tree geometry and status marks as tool
 * receipts: apex keeps the rounded continuation rail while claude/hal use
 * the square corner rail, and claude/hal square the terminal tree edge too.
 * Read at call time so a live /ui switch applies without a restart; unset
 * or unrecognized values fall back to apex. */
type TaskSkinName = "apex" | "claude" | "hal";

function activeTaskSkin(): TaskSkinName {
  const skin = process.env.PI_UI_SKIN;
  return skin === "claude" || skin === "hal" ? skin : "apex";
}

interface TaskSkinGlyphs {
  header: string;
  branch: string;
  last: string;
  rail: string;
  receipt: string;
  hang: string;
  /** Idle status mark: queued/starting/closed/unknown worker rows. */
  statusIdle: string;
  /** Active status mark: running/waiting/settled/failed worker rows. */
  statusActive: string;
}

const TASK_APEX_SKIN: TaskSkinGlyphs = {
  header: "\u25cf",
  branch: "\u251c\u2500",
  last: "\u2570\u2500",
  rail: "\u2502",
  receipt: "\u25cb",
  hang: "   ",
  statusIdle: "\u25cb",
  statusActive: "\u25cf",
};

const TASK_CLAUDE_SKIN: TaskSkinGlyphs = {
  header: "\u25cf",
  branch: "\u251c\u2500",
  // 90-degree terminal edge, matching the ui-kit Claude skin so task cards
  // and tool receipts agree glyph for glyph.
  last: "\u2514\u2500",
  rail: "\u23bf",
  receipt: "\u25cf",
  hang: "   ",
  // Claude's status marks are square in the ui-kit skin (todo, notice, and
  // intercom all render □/■), so task rows match them rather than the
  // round receipt root above.
  statusIdle: "\u25a1",
  statusActive: "\u25a0",
};

const TASK_HAL_SKIN: TaskSkinGlyphs = {
  ...TASK_CLAUDE_SKIN,
  header: "\u25a0",
  receipt: "\u25a1",
  // 90-degree terminal edge and square status marks, matching the ui-kit
  // HAL skin so task cards and tool receipts agree glyph for glyph.
  last: "\u2514\u2500",
  statusIdle: "\u25a1",
  statusActive: "\u25a0",
};

function taskSkinGlyphs(): TaskSkinGlyphs {
  const skin = activeTaskSkin();
  if (skin === "hal") return TASK_HAL_SKIN;
  return skin === "claude" ? TASK_CLAUDE_SKIN : TASK_APEX_SKIN;
}

/**
 * Shared tree glyphs and column widths for task surfaces.
 *
 * Values intentionally mirror the ui-kit TREE skin contract so sub-agent
 * activity cards render the same gutters as tool receipts on every UI.
 * Property reads consult PI_UI_SKIN on every access (same dynamic contract
 * as the kit), so a live /ui switch swaps gutters without a restart.
 * Shape and keys are unchanged; the apex skin returns the exact values this
 * object used to hold statically.
 */
export const TREE = {
  /** Active root: filled circle, painted in the owning receipt's status tone. */
  get header(): string {
    return taskSkinGlyphs().header;
  },
  get branch(): string {
    return taskSkinGlyphs().branch;
  },
  get last(): string {
    return taskSkinGlyphs().last;
  },
  get rail(): string {
    return taskSkinGlyphs().rail;
  },
  /** Idle receipt root: open circle, painted in the owning receipt's status tone. */
  get receipt(): string {
    return taskSkinGlyphs().receipt;
  },
  /** Detached continuation: aligns to the child column without a tree edge. */
  get hang(): string {
    return taskSkinGlyphs().hang;
  },
  /** Idle status mark, painted in the owning row's status tone. */
  get statusIdle(): string {
    return taskSkinGlyphs().statusIdle;
  },
  /** Active status mark, painted in the owning row's status tone. */
  get statusActive(): string {
    return taskSkinGlyphs().statusActive;
  },
};

export const DURATION_COLUMN = 6;

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000)
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function fitLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightWidth = safeVisibleWidth(right);
  if (!right || rightWidth + 1 >= width)
    return safeTruncateToWidth(left, width);
  const fittedLeft = safeTruncateToWidth(
    left,
    Math.max(0, width - rightWidth - 1),
  );
  const gap = " ".repeat(
    Math.max(1, width - safeVisibleWidth(fittedLeft) - rightWidth),
  );
  return safeTruncateToWidth(fittedLeft + gap + right, width);
}

export class WidthText implements Component {
  constructor(
    private build: (width: number) => string[],
    private fallback = "[display unavailable]",
  ) {}
  render(width: number): string[] {
    return renderLinesSafely(this.build, width, this.fallback);
  }
  invalidate() {}
}

export interface ToolRenderContext<TState, TArgs> {
  args: TArgs;
  invalidate: () => void;
  lastComponent?: Component;
  state: TState;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}
