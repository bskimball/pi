// builtin-receipts: Apex chrome for Pi-owned read and edit tools.
//
// Pi keeps execution ownership. Apex replaces only ToolExecutionComponent
// presentation while enabled and falls back to Pi's stock renderers when
// PI_APEX_UI=0.

import { homedir } from "node:os";
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
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const BUILTIN_READ_TOOL = "read";
export const BUILTIN_EDIT_TOOL = "edit";
export const BUILTIN_GREP_TOOL = "grep";
export const BUILTIN_LS_TOOL = "ls";

type PathArgs = {
  path?: string | null;
  offset?: number;
  limit?: number;
  edits?: unknown[];
};

type GrepArgs = {
  pattern?: string;
  path?: string | null;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
};

type LsArgs = {
  path?: string | null;
  limit?: number;
};

type ReceiptTheme = {
  fg: (key: any, text: string) => string;
  bg: (key: any, text: string) => string;
  inverse?: (text: string) => string;
};

const READ_NOTICE_RE =
  /^(?:\[Showing lines \d+-\d+ of \d+.*\]|\[\d+ more lines in file\. Use offset=\d+ to continue\.\]|\[Line \d+ is .*exceeds .*limit\..*\]|\[Image(?::| converted| omitted).*\]|\[Current model does not support images.*\]|Read image file \[.*\]|\.\.\. \d+ more lines|\.\.\. output truncated at \d+ characters)$/;

function shortenPath(value: string, max: number): string {
  let display = value.replace(/\\/g, "/");
  const home = homedir().replace(/\\/g, "/");
  const displayKey = process.platform === "win32" ? display.toLowerCase() : display;
  const homeKey = process.platform === "win32" ? home.toLowerCase() : home;
  if (home && (displayKey === homeKey || displayKey.startsWith(`${homeKey}/`))) {
    display = `~${display.slice(home.length)}`;
  }
  if (display.length <= max) return display;
  const segments = display.split("/").filter(Boolean);
  for (let start = 1; start < segments.length; start++) {
    const tail = `.../${segments.slice(start).join("/")}`;
    if (tail.length <= max) return tail;
  }
  const last = segments.at(-1) ?? display;
  return last.length <= max ? last : `...${last.slice(-Math.max(1, max - 3))}`;
}

export function builtinPathArg(args: PathArgs | undefined, budget: number): string {
  const rawPath = typeof args?.path === "string" ? cleanInline(args.path, 240) : "";
  const path = rawPath ? shortenPath(rawPath, Math.max(8, budget)) : "...";
  if (typeof args?.offset === "number" && Number.isFinite(args.offset)) {
    const offset = Math.max(1, Math.floor(args.offset));
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? `+${Math.max(0, Math.floor(args.limit))}`
        : "";
    return `${path}:${offset}${limit}`;
  }
  return path;
}

function formatReadLines(
  output: string,
  args: PathArgs | undefined,
  theme: ReceiptTheme | undefined,
  innerWidth: number,
  maxLines: number,
): string[] {
  const lines = boundedOutput(output, maxLines);
  const dim = (text: string) => theme?.fg("dim", text) ?? text;
  const body = (text: string) => theme?.fg("toolOutput", text) ?? text;
  const start =
    typeof args?.offset === "number" && Number.isFinite(args.offset)
      ? Math.max(1, Math.floor(args.offset))
      : 1;
  const gutter = Math.max(2, String(start + lines.length - 1).length);
  if (innerWidth <= gutter + 4) return lines;
  let lineNumber = start;
  return lines.map((line) => {
    if (READ_NOTICE_RE.test(line)) return dim(line);
    const numbered = `${padStartToWidth(String(lineNumber), gutter)} `;
    lineNumber++;
    return line.trim()
      ? `${dim(numbered)}${body(safeTruncateToWidth(line, innerWidth - gutter - 1))}`
      : dim(numbered);
  });
}

let readTheme: ReceiptTheme | undefined;
let editTheme: ReceiptTheme | undefined;

const readUi = toolRenderers<PathArgs>({
  surface: BUILTIN_READ_TOOL,
  title: BUILTIN_READ_TOOL,
  arg: builtinPathArg,
  preview(output, _result, args) {
    return output ? formatReadLines(output, args, readTheme, 120, 4) : [];
  },
  body(output, _result, args, innerWidth) {
    return output ? formatReadLines(output, args, readTheme, innerWidth, 80) : [];
  },
});

export const builtinReadReceiptRenderers = {
  renderCall: readUi.renderCall,
  renderResult(result: any, options: any, theme: ReceiptTheme, context: any) {
    readTheme = theme;
    return readUi.renderResult(result, options, theme, context);
  },
};

const editUi = toolRenderers<PathArgs>({
  surface: BUILTIN_EDIT_TOOL,
  title: BUILTIN_EDIT_TOOL,
  expandVerb: "diff",
  expandWhen: (result, _args, isError) => !isError && !!resultDiff(result),
  arg(args, budget) {
    const path = builtinPathArg(args, budget);
    const count = Array.isArray(args?.edits) ? args.edits.length : 0;
    return count > 1 ? cleanInline(`${path} (${count} edits)`, budget) : path;
  },
  stats(result, _args, theme) {
    const diff = resultDiff(result);
    return diff ? formatDiffStats(theme, diff) : "";
  },
  body(_output, result, _args, innerWidth) {
    const diff = resultDiff(result);
    return diff
      ? renderDiffLines(
          diff,
          editTheme ?? { fg: (_key, text) => text },
          80,
          innerWidth,
        )
      : [];
  },
});

export const builtinEditReceiptRenderers = {
  renderCall: editUi.renderCall,
  renderResult(result: any, options: any, theme: ReceiptTheme, context: any) {
    editTheme = theme;
    return editUi.renderResult(result, options, theme, context);
  },
};

function finiteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

function resultDetails(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

/** Counts above ~9 digits stay bounded: fall back to a plain token. */
function boundedCount(value: number | undefined): number | undefined {
  if (value === undefined || value < 0 || value > 999_999_999) return undefined;
  return value;
}

/**
 * Terse stats signal for Pi's TruncationResult details object. Returns ""
 * when truncation is absent, malformed, or did not occur. Never throws on
 * unexpected shapes: details is `any` at runtime.
 */
function truncationToken(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const info = raw as Record<string, unknown>;
  if (info.truncated !== true) return "";
  if (info.truncatedBy === "lines") {
    const total = boundedCount(finiteInt(info.totalLines));
    return total !== undefined ? `truncated ${total} lines` : "truncated";
  }
  if (info.truncatedBy === "bytes") {
    const total = boundedCount(finiteInt(info.totalBytes));
    return total !== undefined ? `truncated ${total} bytes` : "truncated";
  }
  return "truncated";
}

/**
 * Compact header for content greps:
 * `pattern [path] [glob] [ignore-case] [literal] [ctx N] [limit N]`
 */
export function builtinGrepReceiptArg(
  args: GrepArgs | undefined,
  budget: number,
): string {
  const pattern = cleanInline(args?.pattern, 80);
  const path = cleanInline(args?.path ?? "", 80).replace(/\\/g, "/");
  const glob = cleanInline(args?.glob ?? "", 80);

  const extras: string[] = [];
  if (args?.ignoreCase === true) extras.push("ignore-case");
  if (args?.literal === true) extras.push("literal");
  const context = finiteInt(args?.context);
  if (context !== undefined && context > 0) extras.push(`ctx ${context}`);
  const limit = finiteInt(args?.limit);
  if (limit !== undefined) extras.push(`limit ${limit}`);

  const parts = [pattern || "grep", path, glob, extras.join(" ")].filter(
    Boolean,
  );
  return cleanInline(parts.join(" "), Math.max(8, budget));
}

/** Compact header for directory listings: `path [limit N]`. */
export function builtinLsReceiptArg(
  args: LsArgs | undefined,
  budget: number,
): string {
  const rawPath =
    typeof args?.path === "string" ? cleanInline(args.path, 240) : "";
  const path = rawPath ? shortenPath(rawPath, Math.max(8, budget)) : ".";
  const limit = finiteInt(args?.limit);
  const text = limit !== undefined ? `${path} limit ${limit}` : path;
  return cleanInline(text, Math.max(8, budget));
}

export const builtinGrepReceiptRenderers = toolRenderers<GrepArgs>({
  surface: BUILTIN_GREP_TOOL,
  title: BUILTIN_GREP_TOOL,
  arg: builtinGrepReceiptArg,
  stats(result) {
    const details = resultDetails(result);
    const parts: string[] = [];
    const matchLimit = finiteInt(details.matchLimitReached);
    if (matchLimit !== undefined) parts.push(`limit ${matchLimit}`);
    if (details.linesTruncated === true) parts.push("truncated");
    const signal = truncationToken(details.truncation);
    if (signal && !parts.includes(signal)) {
      // A specific signal supersedes the generic flag; never repeat it.
      const generic = signal === "truncated" ? -1 : parts.indexOf("truncated");
      if (generic >= 0) parts.splice(generic, 1);
      parts.push(signal);
    }
    return parts.join(" · ");
  },
  preview(output) {
    return output ? boundedOutput(output, 3, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

export const builtinLsReceiptRenderers = toolRenderers<LsArgs>({
  surface: BUILTIN_LS_TOOL,
  title: BUILTIN_LS_TOOL,
  arg: builtinLsReceiptArg,
  stats(result) {
    const details = resultDetails(result);
    const parts: string[] = [];
    const entryLimit = finiteInt(details.entryLimitReached);
    if (entryLimit !== undefined) parts.push(`limit ${entryLimit}`);
    const signal = truncationToken(details.truncation);
    if (signal && !parts.includes(signal)) parts.push(signal);
    return parts.join(" · ");
  },
  preview(output) {
    return output ? boundedOutput(output, 3, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

export function installBuiltinReceipts(): void {
  registerHeadlessReceipt(BUILTIN_READ_TOOL, builtinReadReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(BUILTIN_EDIT_TOOL, builtinEditReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(BUILTIN_GREP_TOOL, builtinGrepReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(BUILTIN_LS_TOOL, builtinLsReceiptRenderers, {
    overrideOwned: true,
  });
  installHeadlessReceipts();
}
