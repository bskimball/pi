// ui-common: rendering helpers shared by amp-task and mono-ui.

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

export function textContent(result: any): string {
  return Array.isArray(result?.content)
    ? result.content
        .filter((item: any) => item?.type === "text")
        .map((item: any) => String(item.text ?? ""))
        .join("\n")
    : "";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

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
