// ui-common: rendering helpers shared by amp-task and apex-ui.

import type { Component } from "@earendil-works/pi-tui";
import {
  renderLinesSafely,
  safeTruncateToWidth,
  safeVisibleWidth,
  stripTerminalSequences,
} from "./safe-text-layout.ts";
import { skinGlyphs } from "./skin.ts";

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

/**
 * Shared tree glyphs and column widths for tool and task surfaces.
 *
 * Property reads consult the active skin on every access (same dynamic
 * contract as PI_APEX_UI), so a live /ui switch swaps glyphs without a
 * restart. Shape and keys are unchanged; the apex skin returns the exact
 * values this object used to hold statically.
 */
export const TREE = {
  /** Active root: filled circle, painted in the owning receipt's status tone. */
  get header(): string {
    return skinGlyphs().header;
  },
  get branch(): string {
    return skinGlyphs().branch;
  },
  get last(): string {
    return skinGlyphs().last;
  },
  get rail(): string {
    return skinGlyphs().rail;
  },
  /** Idle receipt root: open circle, painted in the owning receipt's status tone. */
  get receipt(): string {
    return skinGlyphs().receipt;
  },
  /** Detached continuation: aligns to the child column without a tree edge. */
  get hang(): string {
    return skinGlyphs().hang;
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
