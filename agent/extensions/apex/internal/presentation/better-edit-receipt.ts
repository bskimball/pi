// better-edit-receipt: Apex chrome for package-loaded pi-better-edit tools.
//
// pi-better-edit owns execute (hash-anchored read/edit/undo). First
// registration wins the whole tool, so Apex cannot re-register them. This
// replaces stock Pi / package Markdown boxes with compact Apex receipts via
// the shared headless wrap when Apex presentation is enabled.
//
// PI_APEX_UI=0 skips the wrap, leaving pi-better-edit and builtin presentation
// intact.

import { homedir as osHomedir } from "node:os";
import {
  padStartToWidth,
  safeTruncateToWidth,
} from "./safe-text-layout.ts";
import {
  boundedOutput,
  toolRenderers,
} from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import {
  formatDiffStats,
  renderDiffLines,
  resultDiff,
} from "./edit-diff.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const BETTER_EDIT_READ_TOOL = "read";
export const BETTER_EDIT_EDIT_TOOL = "edit";
export const BETTER_EDIT_READ_SKILL_TOOL = "read_skill";
export const BETTER_EDIT_UNDO_TOOL = "undo_last_edit";

const HASH_SEP = "\u2502";
const HASHLINE_ROW = /^([A-Za-z0-9]{3}| {3})\u2502(.*)$/;
const HASHLINE_DIFF = /^([+\- ])([A-Za-z0-9]{3}| {3})\u2502(.*)$/;

const READ_NOTICE_RE =
  /^(?:\[Showing lines \d+-\d+ of \d+.*\]|\[\d+ more lines in file\. Use offset=\d+ to continue\.\]|\[Line \d+ is .*exceeds .*limit\..*\]|\[File is empty\. Use edit to insert content\.\]|Offset \d+ is beyond end of file.*|\.\.\. \d+ more lines|\.\.\. output truncated at \d+ characters)$/;

type PathArgs = {
  path?: string | null;
  offset?: number;
  limit?: number;
  edits?: unknown[];
};

type ReceiptTheme = {
  fg: (key: any, text: string) => string;
  inverse?: (text: string) => string;
};

function homedir(): string {
  try {
    return osHomedir();
  } catch {
    return "";
  }
}

function shortenPath(value: string, max: number): string {
  const home = homedir();
  let display = value;
  if (home) {
    const pathKey = process.platform === "win32" ? value.toLowerCase() : value;
    const homeKey = process.platform === "win32" ? home.toLowerCase() : home;
    if (
      pathKey === homeKey ||
      pathKey.startsWith(`${homeKey}/`) ||
      pathKey.startsWith(`${homeKey}\\`)
    ) {
      display = `~${value.slice(home.length)}`;
    }
  }
  if (display.length <= max) return display;
  const segments = display.split(/[\\/]+/).filter(Boolean);
  for (let start = 1; start < segments.length; start++) {
    const tail = `.../${segments.slice(start).join("/")}`;
    if (tail.length <= max) return tail;
  }
  const last = segments[segments.length - 1] ?? display;
  return last.length <= max ? last : `...${last.slice(-Math.max(1, max - 1))}`;
}

function finiteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

function detailsOf(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

function metricsOf(result: any): Record<string, unknown> {
  const details = detailsOf(result);
  return details.metrics && typeof details.metrics === "object"
    ? (details.metrics as Record<string, unknown>)
    : {};
}

/** Compact path header, with optional read window (`file.ts:12+40`). */
export function betterEditPathArg(
  args: PathArgs | undefined,
  budget: number,
): string {
  const rawPath =
    typeof args?.path === "string" && args.path.trim() ? args.path : "";
  const path = rawPath
    ? shortenPath(cleanInline(rawPath.replace(/\\/g, "/"), 240), Math.max(8, budget))
    : "";
  const offset = finiteInt(args?.offset);
  const limit = finiteInt(args?.limit);
  if (path && offset !== undefined) {
    return `${path}:${offset}${limit !== undefined ? `+${limit}` : ""}`;
  }
  if (path) return path;
  const edits = Array.isArray(args?.edits) ? args.edits.length : 0;
  if (edits > 1) return `${edits} edits`;
  return path || "...";
}

function looksHashline(text: string): boolean {
  const sample = text.split(/\r?\n/, 8);
  return sample.some((line) => HASHLINE_ROW.test(line) || HASHLINE_DIFF.test(line));
}

function numberPlainReadLines(
  lines: string[],
  offset: unknown,
  theme: ReceiptTheme | undefined,
  innerWidth: number,
): string[] {
  const dim = (text: string) => theme?.fg("dim", text) ?? text;
  const body = (text: string) => theme?.fg("toolOutput", text) ?? text;
  const start = Number.isFinite(Number(offset))
    ? Math.max(1, Math.floor(Number(offset)))
    : 1;
  const gutter = Math.max(2, String(start + lines.length - 1).length);
  if (innerWidth <= gutter + 4) return lines;
  let lineNumber = start;
  return lines.map((line) => {
    if (READ_NOTICE_RE.test(line) || !line.trim()) return dim(line);
    const numbered = `${padStartToWidth(String(lineNumber), gutter)} `;
    lineNumber++;
    return `${dim(numbered)}${body(safeTruncateToWidth(line, innerWidth - gutter - 1))}`;
  });
}

function formatHashlineRows(
  lines: string[],
  theme: ReceiptTheme | undefined,
  innerWidth: number,
): string[] {
  const dim = (text: string) => theme?.fg("dim", text) ?? text;
  const body = (text: string) => theme?.fg("toolOutput", text) ?? text;
  if (innerWidth <= 6) {
    return lines.map((line) => safeTruncateToWidth(line, innerWidth));
  }
  return lines.map((line) => {
    if (READ_NOTICE_RE.test(line)) return dim(line);
    const match = HASHLINE_ROW.exec(line);
    if (!match) return dim(line);
    const hash = match[1] ?? "";
    const content = match[2] ?? "";
    const gutter = `${hash}${HASH_SEP}`;
    return `${dim(gutter)}${body(safeTruncateToWidth(content, innerWidth - gutter.length))}`;
  });
}

function formatReadLines(
  output: string,
  args: PathArgs | undefined,
  theme: ReceiptTheme | undefined,
  innerWidth: number,
  maxLines: number,
): string[] {
  const lines = boundedOutput(output, maxLines);
  if (looksHashline(output)) return formatHashlineRows(lines, theme, innerWidth);
  return numberPlainReadLines(lines, args?.offset, theme, innerWidth);
}

function hashlineDiffStats(diffText: string, theme: ReceiptTheme): string {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split("\n")) {
    const match = HASHLINE_DIFF.exec(line);
    if (!match) continue;
    if (match[1] === "+") added++;
    else if (match[1] === "-") removed++;
  }
  if (added === 0 && removed === 0) return formatDiffStats(theme, diffText);
  const parts: string[] = [];
  if (added > 0) parts.push(theme.fg("toolDiffAdded", `+${added}`));
  if (removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${removed}`));
  return parts.join(" ");
}

function renderHashlineDiffLines(
  diffText: string,
  theme: ReceiptTheme,
  maxLines: number,
  innerWidth: number,
): string[] {
  const dim = (text: string) => theme.fg("dim", text);
  const added = (text: string) => theme.fg("toolDiffAdded", text);
  const removed = (text: string) => theme.fg("toolDiffRemoved", text);
  const context = (text: string) => theme.fg("toolDiffContext", text);
  const rows: string[] = [];
  for (const line of diffText.split("\n")) {
    if (rows.length >= maxLines) break;
    const match = HASHLINE_DIFF.exec(line);
    if (!match) {
      rows.push(dim(safeTruncateToWidth(line, innerWidth)));
      continue;
    }
    const prefix = match[1] ?? " ";
    const hash = match[2] ?? "";
    const content = match[3] ?? "";
    const gutter = `${prefix}${hash}${HASH_SEP}`;
    const rest = safeTruncateToWidth(content, Math.max(0, innerWidth - gutter.length));
    const painted =
      prefix === "+"
        ? added(`${gutter}${rest}`)
        : prefix === "-"
          ? removed(`${gutter}${rest}`)
          : context(`${gutter}${rest}`);
    rows.push(painted);
  }
  const total = diffText.split("\n").length;
  if (total > rows.length) {
    rows.push(dim(`... ${total - rows.length} more diff lines`));
  }
  return rows;
}

function editDiffText(result: any): string | undefined {
  const hashline = resultDiff(result);
  return hashline;
}

function formatEditStats(result: any, theme: ReceiptTheme): string {
  const metrics = metricsOf(result);
  const added = finiteInt(metrics.added_lines);
  const removed = finiteInt(metrics.removed_lines);
  if (added !== undefined || removed !== undefined) {
    const parts: string[] = [];
    if ((added ?? 0) > 0) parts.push(theme.fg("toolDiffAdded", `+${added}`));
    if ((removed ?? 0) > 0) parts.push(theme.fg("toolDiffRemoved", `-${removed}`));
    if (parts.length) return parts.join(" ");
  }
  const diff = editDiffText(result);
  if (!diff) return "";
  return looksHashline(diff)
    ? hashlineDiffStats(diff, theme)
    : formatDiffStats(theme, diff);
}

function formatReadStats(result: any): string {
  const details = detailsOf(result);
  const metrics = metricsOf(result);
  const parts: string[] = [];
  const nextOffset =
    finiteInt(details.nextOffset) ?? finiteInt(metrics.next_offset);
  if (details.truncation || metrics.truncated) parts.push("truncated");
  if (nextOffset !== undefined) parts.push(`next ${nextOffset}`);
  return parts.join(" · ");
}

let lastReadTheme: ReceiptTheme | undefined;
let lastEditTheme: ReceiptTheme | undefined;

function wrapResult<TArgs>(
  renderers: ReturnType<typeof toolRenderers<TArgs>>,
  kind: "read" | "edit",
) {
  return {
    renderCall: renderers.renderCall,
    renderResult(
      result: any,
      options: { expanded: boolean; isPartial: boolean },
      theme: any,
      context: any,
    ) {
      if (kind === "read") lastReadTheme = theme;
      else lastEditTheme = theme;
      return renderers.renderResult(result, options, theme, context);
    },
  };
}

export const betterEditReadReceiptRenderers = wrapResult(
  toolRenderers<PathArgs>({
    surface: BETTER_EDIT_READ_TOOL,
    title: BETTER_EDIT_READ_TOOL,
    arg: betterEditPathArg,
    stats(result) {
      return formatReadStats(result);
    },
    preview(output, _result, args) {
      if (!output) return [];
      return formatReadLines(output, args, lastReadTheme, 120, 4);
    },
    body(output, _result, args, innerWidth) {
      if (!output) return [];
      return formatReadLines(output, args, lastReadTheme, innerWidth, 80);
    },
  }),
  "read",
);

export const betterEditReadSkillReceiptRenderers = wrapResult(
  toolRenderers<PathArgs>({
    surface: BETTER_EDIT_READ_SKILL_TOOL,
    title: BETTER_EDIT_READ_SKILL_TOOL,
    arg: betterEditPathArg,
    preview(output, _result, args) {
      if (!output) return [];
      return formatReadLines(output, args, lastReadTheme, 120, 4);
    },
    body(output, _result, args, innerWidth) {
      if (!output) return [];
      return formatReadLines(output, args, lastReadTheme, innerWidth, 80);
    },
  }),
  "read",
);

export const betterEditEditReceiptRenderers = wrapResult(
  toolRenderers<PathArgs>({
    surface: BETTER_EDIT_EDIT_TOOL,
    title: BETTER_EDIT_EDIT_TOOL,
    expandVerb: "diff",
    expandWhen: (result, _args, isError) => !isError && !!editDiffText(result),
    arg(args, budget) {
      const path = betterEditPathArg(args, budget);
      const edits = Array.isArray(args?.edits) ? args.edits.length : 0;
      if (edits > 1 && args?.path) {
        return cleanInline(`${path} (${edits} edits)`, Math.max(8, budget));
      }
      return path;
    },
    stats(result, _args, theme) {
      return formatEditStats(result, theme);
    },
    preview() {
      return [];
    },
    body(_output, result, _args, innerWidth) {
      const diff = editDiffText(result);
      if (!diff) return [];
      if (looksHashline(diff)) {
        return renderHashlineDiffLines(
          diff,
          lastEditTheme ?? { fg: (_key, text) => text },
          80,
          innerWidth,
        );
      }
      return renderDiffLines(
        diff,
        lastEditTheme ?? { fg: (_key, text) => text },
        80,
        innerWidth,
      );
    },
  }),
  "edit",
);

export const betterEditUndoReceiptRenderers = wrapResult(
  toolRenderers<PathArgs>({
    surface: BETTER_EDIT_UNDO_TOOL,
    title: BETTER_EDIT_UNDO_TOOL,
    expandVerb: "diff",
    expandWhen: (result, _args, isError) => !isError && !!editDiffText(result),
    arg: betterEditPathArg,
    stats(result, _args, theme) {
      return formatEditStats(result, theme);
    },
    preview(output) {
      return output ? boundedOutput(output, 3, 800) : [];
    },
    body(output, result, _args, innerWidth) {
      const diff = editDiffText(result);
      if (diff) {
        if (looksHashline(diff)) {
          return renderHashlineDiffLines(
            diff,
            lastEditTheme ?? { fg: (_key, text) => text },
            80,
            innerWidth,
          );
        }
        return renderDiffLines(
          diff,
          lastEditTheme ?? { fg: (_key, text) => text },
          80,
          innerWidth,
        );
      }
      return output ? boundedOutput(output, 80) : [];
    },
  }),
  "edit",
);

/** Attach Apex receipts to pi-better-edit ToolExecutionComponent instances. */
export function installBetterEditReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(BETTER_EDIT_READ_TOOL, betterEditReadReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(BETTER_EDIT_READ_SKILL_TOOL, betterEditReadSkillReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(BETTER_EDIT_EDIT_TOOL, betterEditEditReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(BETTER_EDIT_UNDO_TOOL, betterEditUndoReceiptRenderers, {
    overrideOwned: true,
  });
  installHeadlessReceipts();
}
