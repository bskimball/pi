// tool-receipt: presentation primitives and the unified receipt engine shared
// by every Apex tool receipt (built-ins, MCP, and the local web tools).
//
// These deliberately avoid pi-tui `Text`/`Markdown`/`Container` and the
// Intl.Segmenter width path; everything clips through safe-text-layout.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import {
  fallbackTruncateToWidth,
  padStartToWidth,
  safeTruncateToWidth,
  safeVisibleWidth,
  stripTerminalSequences,
} from "./safe-text-layout.ts";
import {
  DURATION_COLUMN,
  TREE,
  cleanInline,
  fitLine,
  formatDuration,
  textContent,
  type ToolRenderContext,
} from "./ui-common.ts";

const reportedRenderFailures = new Set<string>();

/** Append a one-time render failure note to agent/pi-render.log. Never throws. */
export function reportRenderFailure(surface: string, error: unknown): void {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  const key = `${surface}:${message}`;
  if (reportedRenderFailures.has(key)) return;
  reportedRenderFailures.add(key);
  const entry = `\n=== apex-ui ${surface} render fallback at ${new Date().toISOString()} ===\n${message}\n`;
  void fs
    .appendFile(path.join(os.homedir(), ".pi", "agent", "pi-render.log"), entry)
    .catch(() => {});
}

/**
 * A component whose text can be replaced in place. Used so a tool's call row
 * can be blanked once its result row exists, instead of listing the tool twice.
 */
export class StableText implements Component {
  private value: string | ((width: number) => string) = "";

  /** Accepts a plain string or a width-aware builder for right-aligned columns. */
  setText(value: unknown): void {
    this.value =
      typeof value === "function"
        ? (value as (width: number) => string)
        : typeof value === "string"
          ? value
          : String(value ?? "");
  }

  render(width: number): string[] {
    try {
      // Keep ANSI theme styling while clipping through the dependency-free
      // layout path; no pi-tui Text/Segmenter code runs here.
      const resolved =
        typeof this.value === "function" ? this.value(width) : this.value;
      if (!resolved) return [];
      return resolved
        .replace(/\t/g, "   ")
        .split(/\r?\n/)
        .slice(0, 100)
        .map((line) => safeTruncateToWidth(line, width));
    } catch (error) {
      reportRenderFailure("tool", error);
      return [fallbackTruncateToWidth("[tool output unavailable]", width)];
    }
  }

  invalidate(): void {}
}

export function stableText(
  text: unknown | ((width: number) => string),
): StableText {
  const component = new StableText();
  component.setText(text);
  return component;
}

/** Header lines followed by a full-width background-padded body block, matching
 * Pi's default expanded tool box (ctrl+o). */
export function paddedSection(
  header: string[] | ((width: number) => string),
  body: string[] | ((innerWidth: number) => string[]),
  bg: (text: string) => string,
): Component {
  return {
    render(width: number): string[] {
      try {
        const headerLines =
          typeof header === "function" ? [header(width)] : header;
        const lines = headerLines
          .flatMap((line) => line.split(/\r?\n/))
          .map((line) => safeTruncateToWidth(line.replace(/\t/g, "   "), width));
        const built =
          typeof body === "function" ? body(Math.max(0, width - 2)) : body;
        // Trailing blank rows read as dead bands at the bottom of the card.
        let end = built.length;
        while (end > 0 && !stripTerminalSequences(built[end - 1]).trim()) end--;
        const bodyLines = built.slice(0, end);
        if (bodyLines.length && width > 2) {
          const innerWidth = width - 2;
          // theme.bg() emits `<open>text<close>`; recover `<open>` so it can be
          // re-asserted after any interior reset.
          const open = bg("\u0000").split("\u0000")[0] ?? "";
          const blank = bg(" ".repeat(width));
          lines.push(blank);
          for (const raw of bodyLines.slice(0, 200)) {
            const clipped = safeTruncateToWidth(
              raw.replace(/\t/g, "   "),
              innerWidth,
            );
            const fill = " ".repeat(
              Math.max(0, innerWidth - safeVisibleWidth(clipped)),
            );
            // A styled body row ends in a full `\x1b[0m` (and diff rows carry
            // `\x1b[49m`), which clears the row background before the padding
            // is drawn. Re-open the background after every interior reset so
            // each row paints one even band instead of a ragged fragment.
            const painted = open
              ? `${clipped}${fill}`.replace(
                  /\x1b\[(?:0|49)m/g,
                  (reset) => `${reset}${open}`,
                )
              : `${clipped}${fill}`;
            lines.push(bg(` ${painted} `));
          }
          lines.push(blank);
        }
        return lines;
      } catch (error) {
        reportRenderFailure("tool", error);
        return [fallbackTruncateToWidth("[tool output unavailable]", width)];
      }
    },
    invalidate(): void {},
  };
}

/** Clip text to a hard line and character budget, reporting what was dropped. */
export function boundedOutput(
  text: string,
  maxLines: number,
  maxChars = 8000,
): string[] {
  const clean = text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    "",
  );
  const totalLines = clean.split(/\r?\n/).length;
  const lines = clean.slice(0, maxChars).split(/\r?\n/);
  if (totalLines <= maxLines && clean.length <= maxChars) return lines;
  const shown = lines.slice(0, maxLines);
  const hiddenLines = Math.max(0, totalLines - shown.length);
  const suffix = hiddenLines
    ? `... ${hiddenLines} more lines`
    : `... output truncated at ${maxChars} characters`;
  return [...shown, suffix];
}

/* ------------------------------------------------------------------ */
/* Unified receipt engine                                              */
/* ------------------------------------------------------------------ */

interface ReceiptTheme {
  fg: (key: any, text: string) => string;
  bg: (key: any, text: string) => string;
}

export interface ToolRenderState {
  startedAt?: number;
  endedAt?: number;
  hasResult?: boolean;
  callComponent?: StableText;
}

const PREVIEW_LINES = 4;
const BODY_LINES = 80;

/**
 * Spec for one tool receipt family. Callers supply identity/arg/preview/body
 * hooks; the engine owns call blanking, glyphs, duration, expand chrome, and
 * failure wrappers.
 */
export interface ToolSpec<TArgs> {
  /** Static title, or width-agnostic builder from args/result details. */
  title:
    | string
    | ((args: TArgs, details?: Record<string, unknown>) => string);
  /** Compact primary argument for the header. Never a JSON dump. */
  arg: (args: TArgs, budget: number) => string;
  /** Short right-of-arg stats built from result details, e.g. `5 results`. */
  stats?: (result: any, args: TArgs, theme: ReceiptTheme) => string;
  /** 2-4 rail-indented collapsed preview lines. */
  preview?: (output: string, result: any, args: TArgs) => string[];
  /** Expanded (ctrl+o) body lines. Defaults to the bounded raw output. */
  body?: (
    output: string,
    result: any,
    args: TArgs,
    innerWidth: number,
  ) => string[];
  /**
   * When true (and a body/preview exists), advertise expand even without
   * content from textContent — used by edit/write diffs.
   */
  expandWhen?: (result: any, args: TArgs, isError: boolean) => boolean;
  /** Optional expand-hint verb (default "expand"; mutations use "diff"). */
  expandVerb?: string;
  /** Optional scrub applied to args/output before display. Defaults to identity. */
  scrub?: (text: string) => string;
  /** Max expanded body lines (default 80). */
  bodyLines?: number;
  /** Max collapsed preview lines (default 4). */
  previewLines?: number;
  /** Surface tag for reportRenderFailure (defaults to string title). */
  surface?: string;
}

function asTitle<TArgs>(
  title: ToolSpec<TArgs>["title"],
  args: TArgs,
  details?: Record<string, unknown>,
): string {
  return typeof title === "function" ? title(args, details) : title;
}

function asDetails(result: any): Record<string, unknown> | undefined {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : undefined;
}

/** Build `renderCall`/`renderResult` for one tool receipt family. */
export function toolRenderers<TArgs>(spec: ToolSpec<TArgs>) {
  const scrub = spec.scrub ?? ((text: string) => text);
  const surface =
    spec.surface ??
    (typeof spec.title === "string" ? spec.title : "tool");
  const bodyLimit = spec.bodyLines ?? BODY_LINES;
  const previewLimit = spec.previewLines ?? PREVIEW_LINES;
  const expandVerb = spec.expandVerb ?? "expand";

  const renderCall = (
    args: TArgs,
    theme: ReceiptTheme,
    context: ToolRenderContext<ToolRenderState, TArgs>,
  ): Component => {
    try {
      if (context.executionStarted && context.state.startedAt === undefined) {
        context.state.startedAt = Date.now();
      }
      const component = (context.state.callComponent ??= new StableText());
      // Once a result row exists the call row is blanked, so a single receipt
      // represents the call instead of a call/result pair.
      if (context.state.hasResult) {
        component.setText("");
        return component;
      }

      const glyph = context.executionStarted
        ? theme.fg("warning", "\u25cf")
        : theme.fg("dim", "\u25cb");
      const startedAt = context.state.startedAt;
      const title = asTitle(spec.title, args);

      component.setText((width: number) => {
        try {
          const elapsed = startedAt
            ? theme.fg(
                "dim",
                padStartToWidth(
                  formatDuration(Date.now() - startedAt),
                  DURATION_COLUMN,
                ),
              )
            : "";
          const lead = `${glyph} ${theme.fg("toolTitle", title)}`;
          const budget = Math.max(
            8,
            width -
              safeVisibleWidth(lead) -
              (elapsed ? safeVisibleWidth(elapsed) + 2 : 0) -
              1,
          );
          const arg = safeTruncateToWidth(
            scrub(spec.arg(args, budget)),
            budget,
          );
          const left = arg ? `${lead} ${theme.fg("muted", arg)}` : lead;
          return elapsed ? fitLine(left, elapsed, width) : left;
        } catch (error) {
          reportRenderFailure(`${surface}-call`, error);
          return fallbackTruncateToWidth(
            `[${surface} call unavailable]`,
            width,
          );
        }
      });
      return component;
    } catch (error) {
      reportRenderFailure(`${surface}-call`, error);
      return stableText(`[${surface} call unavailable]`);
    }
  };

  const renderResult = (
    result: any,
    options: { expanded: boolean; isPartial: boolean },
    theme: ReceiptTheme,
    context: ToolRenderContext<ToolRenderState, TArgs>,
  ): Component => {
    try {
      context.state.hasResult = true;
      context.state.callComponent?.setText("");

      const runningNow = options.isPartial && !context.isError;
      if (!runningNow) context.state.endedAt ??= Date.now();

      const glyph = runningNow
        ? theme.fg("warning", "\u25cf")
        : context.isError
          ? theme.fg("error", "\u00d7")
          : theme.fg("success", "\u2713");
      const elapsed = context.state.startedAt
        ? theme.fg(
            "dim",
            padStartToWidth(
              formatDuration(
                (context.state.endedAt ?? Date.now()) - context.state.startedAt,
              ),
              DURATION_COLUMN,
            ),
          )
        : "";

      const title = asTitle(spec.title, context.args, asDetails(result));
      const rawOutput = textContent(result);
      const output = scrub(rawOutput.slice(0, 200_000)).trim();
      const hasBody = output.length > 0;
      const expandExtra =
        !runningNow &&
        (spec.expandWhen?.(result, context.args, context.isError) ?? false);
      const canExpand = (hasBody || expandExtra) && !runningNow;
      // Do not strip ANSI from stats — mutation diffs color +/− counts.
      // Only collapse whitespace / hard-cap length on the plain text.
      const stats = (() => {
        if (runningNow || context.isError || !spec.stats) return "";
        const raw = spec.stats(result, context.args, theme);
        if (!raw) return "";
        if (raw.includes("\x1b")) {
          return raw.length > 80 ? `${raw.slice(0, 80)}...` : raw;
        }
        return cleanInline(raw, 40);
      })();
      // Expand stays functional for errors too, so a failed fetch can still be
      // opened for the full message.
      const expandHint = canExpand
        ? theme.fg(
            "dim",
            options.expanded
              ? `ctrl+o collapse`
              : `ctrl+o ${expandVerb}`,
          )
        : "";

      const header = (width: number) => {
        const lead = `${glyph} ${theme.fg("toolTitle", title)}`;
        // Stats may already carry ANSI (diff +/−); avoid double-wrapping when
        // the hook returns theme-colored text.
        const statsStyled = stats
          ? stats.includes("\x1b")
            ? stats
            : theme.fg("muted", stats)
          : "";
        const tailStyled = [
          statsStyled,
          width >= 72 ? expandHint : "",
        ]
          .filter(Boolean)
          .join(" ");
        const reserved =
          safeVisibleWidth(lead) +
          (tailStyled ? safeVisibleWidth(tailStyled) + 1 : 0) +
          (elapsed ? safeVisibleWidth(elapsed) + 2 : 0) +
          1;
        const budget = Math.max(8, width - reserved);
        const arg = safeTruncateToWidth(
          scrub(spec.arg(context.args, budget)),
          budget,
        );
        const left = [lead, arg ? theme.fg("muted", arg) : "", tailStyled]
          .filter(Boolean)
          .join(" ");
        return elapsed ? fitLine(left, elapsed, width) : left;
      };

      if (runningNow) return stableText(header);
      if (!hasBody && !expandExtra) return stableText(header);

      if (options.expanded) {
        const bg = (text: string) =>
          theme.bg(context.isError ? "toolErrorBg" : "toolSuccessBg", text);
        const paintBody = (lines: string[], tone: "error" | "toolOutput") =>
          lines.slice(0, bodyLimit + 1).map((line) =>
            // Diff / pre-styled rows already carry ANSI; leave them alone.
            line.includes("\x1b") ? line : theme.fg(tone, line),
          );
        const body = (innerWidth: number): string[] => {
          try {
            if (context.isError && hasBody) {
              return paintBody(boundedOutput(output, bodyLimit), "error");
            }
            if (spec.body) {
              return paintBody(
                spec.body(output, result, context.args, innerWidth),
                "toolOutput",
              );
            }
            if (!hasBody) return [];
            return paintBody(boundedOutput(output, bodyLimit), "toolOutput");
          } catch (error) {
            reportRenderFailure(`${surface}-body`, error);
            return [theme.fg("error", "[body unavailable]")];
          }
        };
        return paddedSection(header, body, bg);
      }

      if (!hasBody && !spec.preview) return stableText(header);

      const indent = (line: string) => `  ${theme.fg("dim", TREE.rail)} ${line}`;
      let previewLines: string[];
      try {
        if (context.isError && hasBody) {
          previewLines = boundedOutput(output, 2, 800);
        } else if (spec.preview) {
          previewLines = spec.preview(output, result, context.args);
        } else if (hasBody) {
          previewLines = boundedOutput(output, 3, 1200);
        } else {
          previewLines = [];
        }
      } catch (error) {
        reportRenderFailure(`${surface}-preview`, error);
        previewLines = hasBody ? boundedOutput(output, 2, 400) : [];
      }
      const preview = previewLines
        .slice(0, previewLimit)
        .map((line) => cleanInline(line, 400))
        .filter(Boolean);
      if (!preview.length) return stableText(header);

      const rendered = preview.map((line) =>
        indent(theme.fg(context.isError ? "error" : "toolOutput", line)),
      );
      return stableText(
        (width: number) => `${header(width)}\n${rendered.join("\n")}`,
      );
    } catch (error) {
      reportRenderFailure(`${surface}-result`, error);
      return stableText(`[${surface} result unavailable]`);
    }
  };

  return { renderCall, renderResult };
}

/** Back-compat alias used by web-search-ui callers. */
export const webToolRenderers = toolRenderers;
export type WebToolSpec<TArgs> = ToolSpec<TArgs>;
export type WebToolRenderState = ToolRenderState;
