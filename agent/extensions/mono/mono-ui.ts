// mono-ui: compact built-in tool chrome and monochrome interactive layout.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import {
  fallbackTruncateToWidth,
  padStartToWidth,
  safeTruncateToWidth,
  safeVisibleWidth,
} from "./lib/safe-text-layout.ts";
import {
  DURATION_COLUMN,
  TREE,
  cleanInline,
  fitLine,
  formatDuration,
  formatTokens,
  stripAnsi,
  textContent,
  type ToolRenderContext,
} from "./lib/ui-common.ts";

type BuiltinName = "read" | "bash" | "edit" | "write";
interface BuiltinRenderState {
  startedAt?: number;
  endedAt?: number;
  hasResult?: boolean;
  callComponent?: StableText;
}

const reportedRenderFailures = new Set<string>();

function reportRenderFailure(surface: string, error: unknown): void {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  const key = `${surface}:${message}`;
  if (reportedRenderFailures.has(key)) return;
  reportedRenderFailures.add(key);
  const entry = `\n=== mono-ui ${surface} render fallback at ${new Date().toISOString()} ===\n${message}\n`;
  void fs
    .appendFile(path.join(os.homedir(), ".pi", "agent", "pi-render.log"), entry)
    .catch(() => {});
}

class StableText implements Component {
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

function stableText(text: unknown | ((width: number) => string)): StableText {
  const component = new StableText();
  component.setText(text);
  return component;
}

/** Header lines followed by a full-width background-padded body block, matching
 * Pi's default expanded tool box (ctrl+o). */
function paddedSection(
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
        const bodyLines =
          typeof body === "function" ? body(Math.max(0, width - 2)) : body;
        if (bodyLines.length && width > 2) {
          const innerWidth = width - 2;
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
            lines.push(bg(` ${clipped}${fill} `));
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

function primaryArg(name: BuiltinName, args: any): string {
  if (name === "bash") return cleanInline(args?.command, 120);
  const filePath = cleanInline(args?.path, 120);
  if (name === "read" && args?.offset)
    return `${filePath}:${args.offset}${args?.limit ? `+${args.limit}` : ""}`;
  return filePath;
}

function boundedOutput(
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

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Pi-style numbered contextual diff (local equivalent of edit-diff.generateDiffString). */
function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const lineNumWidth = String(
    Math.max(oldLines.length, newLines.length),
  ).length;
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      for (const line of raw) {
        if (part.added) {
          output.push(
            `+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`,
          );
          newLineNum++;
        } else {
          output.push(
            `-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
          );
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const nextPartIsChange =
      i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = nextPartIsChange;

    if (hasLeadingChange && hasTrailingChange) {
      if (raw.length <= contextLines * 2) {
        for (const line of raw) {
          output.push(
            ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
          );
          oldLineNum++;
          newLineNum++;
        }
      } else {
        const leading = raw.slice(0, contextLines);
        const trailing = raw.slice(raw.length - contextLines);
        const skipped = raw.length - leading.length - trailing.length;
        for (const line of leading) {
          output.push(
            ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
          );
          oldLineNum++;
          newLineNum++;
        }
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
        for (const line of trailing) {
          output.push(
            ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
          );
          oldLineNum++;
          newLineNum++;
        }
      }
    } else if (hasLeadingChange) {
      const shown = raw.slice(0, contextLines);
      const skipped = raw.length - shown.length;
      for (const line of shown) {
        output.push(
          ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
        );
        oldLineNum++;
        newLineNum++;
      }
      if (skipped > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      }
    } else if (hasTrailingChange) {
      const skipped = Math.max(0, raw.length - contextLines);
      if (skipped > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      }
      for (const line of raw.slice(skipped)) {
        output.push(
          ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`,
        );
        oldLineNum++;
        newLineNum++;
      }
    } else {
      oldLineNum += raw.length;
      newLineNum += raw.length;
    }
    lastWasChange = false;
  }

  return output.join("\n");
}

function parseDiffLine(
  line: string,
): { prefix: string; lineNum: string; content: string } | null {
  const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
  if (!match) return null;
  return { prefix: match[1], lineNum: match[2], content: match[3] };
}

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

function countDiffStats(diffText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split("\n")) {
    const parsed = parseDiffLine(line);
    if (!parsed) continue;
    if (parsed.prefix === "+") added++;
    else if (parsed.prefix === "-") removed++;
  }
  return { added, removed };
}

function formatDiffStats(
  theme: { fg: (key: any, text: string) => string },
  diffText: string | undefined,
): string {
  if (!diffText) return "";
  const { added, removed } = countDiffStats(diffText);
  if (added === 0 && removed === 0) return "";
  const parts: string[] = [];
  if (added > 0) parts.push(theme.fg("toolDiffAdded", `+${added}`));
  if (removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${removed}`));
  return parts.join(" ");
}

function renderIntraLineDiff(
  oldContent: string,
  newContent: string,
  inverse: (text: string) => string,
): { removedLine: string; addedLine: string } {
  const wordDiff = Diff.diffWords(oldContent, newContent);
  let removedLine = "";
  let addedLine = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of wordDiff) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        removedLine += leadingWs;
        isFirstRemoved = false;
      }
      if (value) removedLine += inverse(value);
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        addedLine += leadingWs;
        isFirstAdded = false;
      }
      if (value) addedLine += inverse(value);
    } else {
      removedLine += part.value;
      addedLine += part.value;
    }
  }

  return { removedLine, addedLine };
}

// The theme schema fixes the set of background tokens, so diff row backgrounds
// are emitted as raw truecolor. These match GitHub Dark's diff surfaces and are
// only ever applied to a full row, which keeps the padding math unchanged.
const DIFF_ADDED_BG = "\x1b[48;2;3;35;18m";
const DIFF_REMOVED_BG = "\x1b[48;2;51;13;16m";
const DIFF_RESET = "\x1b[49m";

/**
 * Paint a full-row background. The row is clipped and space-filled to rowWidth
 * first so every diff line paints an even block instead of a ragged one.
 */
function diffRow(bg: string, text: string, rowWidth: number): string {
  let row = text;
  if (rowWidth > 0) {
    row = safeTruncateToWidth(row, rowWidth);
    row += " ".repeat(Math.max(0, rowWidth - safeVisibleWidth(row)));
  }
  // Re-assert the row background after any inner reset so intra-line inverse
  // highlights cannot punch a hole in it.
  return `${bg}${row.replace(/\x1b\[0m/g, `\x1b[0m${bg}`)}${DIFF_RESET}`;
}

/** Pi-style colored numbered diff with single-line intra-line inverse highlights. */
function renderDiffLines(
  diffText: string,
  theme: {
    fg: (key: any, text: string) => string;
    inverse?: (text: string) => string;
  },
  maxLines = 80,
  rowWidth = 0,
): string[] {
  const lines = diffText.split("\n");
  const result: string[] = [];
  let i = 0;
  const inverse = theme.inverse?.bind(theme) ?? ((text: string) => text);
  const added = (text: string) => diffRow(DIFF_ADDED_BG, text, rowWidth);
  const removed = (text: string) => diffRow(DIFF_REMOVED_BG, text, rowWidth);

  while (i < lines.length) {
    const parsed = parseDiffLine(lines[i]);
    if (!parsed) {
      result.push(theme.fg("toolDiffContext", lines[i]));
      i++;
      continue;
    }

    if (parsed.prefix === "-") {
      const removedLines: { lineNum: string; content: string }[] = [];
      while (i < lines.length) {
        const p = parseDiffLine(lines[i]);
        if (!p || p.prefix !== "-") break;
        removedLines.push({ lineNum: p.lineNum, content: p.content });
        i++;
      }
      const addedLines: { lineNum: string; content: string }[] = [];
      while (i < lines.length) {
        const p = parseDiffLine(lines[i]);
        if (!p || p.prefix !== "+") break;
        addedLines.push({ lineNum: p.lineNum, content: p.content });
        i++;
      }

      if (removedLines.length === 1 && addedLines.length === 1) {
        const { removedLine, addedLine } = renderIntraLineDiff(
          replaceTabs(removedLines[0].content),
          replaceTabs(addedLines[0].content),
          inverse,
        );
        result.push(
          removed(
            theme.fg(
              "toolDiffRemoved",
              `-${removedLines[0].lineNum} ${removedLine}`,
            ),
          ),
        );
        result.push(
          added(
            theme.fg("toolDiffAdded", `+${addedLines[0].lineNum} ${addedLine}`),
          ),
        );
      } else {
        for (const row of removedLines) {
          result.push(
            removed(
              theme.fg(
                "toolDiffRemoved",
                `-${row.lineNum} ${replaceTabs(row.content)}`,
              ),
            ),
          );
        }
        for (const row of addedLines) {
          result.push(
            added(
              theme.fg(
                "toolDiffAdded",
                `+${row.lineNum} ${replaceTabs(row.content)}`,
              ),
            ),
          );
        }
      }
    } else if (parsed.prefix === "+") {
      result.push(
        added(
          theme.fg(
            "toolDiffAdded",
            `+${parsed.lineNum} ${replaceTabs(parsed.content)}`,
          ),
        ),
      );
      i++;
    } else {
      result.push(
        theme.fg(
          "toolDiffContext",
          ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`,
        ),
      );
      i++;
    }
  }

  if (result.length <= maxLines) return result;
  return [
    ...result.slice(0, maxLines),
    theme.fg("dim", `... ${result.length - maxLines} more lines`),
  ];
}

function resultDiff(result: any): string | undefined {
  const diff = result?.details?.diff;
  return typeof diff === "string" && diff.length > 0 ? diff : undefined;
}

function resolveToolPath(filePath: string, cwd: string): string {
  const normalized = filePath
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/^@/, "");
  const expanded =
    normalized === "~"
      ? os.homedir()
      : normalized.startsWith("~/")
        ? os.homedir() + normalized.slice(1)
        : normalized;
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

async function readPriorContent(
  filePath: string,
  cwd: string,
): Promise<{ content: string | undefined; ok: boolean }> {
  const absolutePath = resolveToolPath(filePath, cwd);
  try {
    return { content: await fs.readFile(absolutePath, "utf-8"), ok: true };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { content: "", ok: true };
    return { content: undefined, ok: false };
  }
}

function registerBuiltin(
  pi: ExtensionAPI,
  name: BuiltinName,
  make: (cwd: string) => ToolDefinition<any, any, any>,
) {
  const cache = new Map<string, ToolDefinition<any, any, any>>();
  const get = (cwd: string) => {
    let definition = cache.get(cwd);
    if (!definition) {
      definition = make(cwd);
      cache.set(cwd, definition);
    }
    return definition;
  };
  const base = get(process.cwd());

  pi.registerTool({
    name,
    label: base.label,
    description: base.description,
    promptSnippet: base.promptSnippet,
    promptGuidelines: base.promptGuidelines,
    parameters: base.parameters,
    prepareArguments: base.prepareArguments,
    executionMode: base.executionMode,
    renderShell: "self",
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const definition = get(ctx.cwd);
      if (name !== "write") {
        return definition.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      // Capture prior contents so expanded write results can show a real diff.
      // ENOENT => new file (empty prior). Other pre-read failures omit the diff.
      const filePath = typeof params?.path === "string" ? params.path : "";
      const prior = filePath
        ? await readPriorContent(filePath, ctx.cwd)
        : { content: undefined, ok: false };
      const result = await definition.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
      if (!prior.ok || prior.content === undefined) return result;
      if (result?.details?.diff) return result;

      const newContent =
        typeof params?.content === "string" ? params.content : "";
      const diff = generateDiffString(
        normalizeToLF(prior.content),
        normalizeToLF(newContent),
      );
      return {
        ...result,
        details: {
          ...(result?.details && typeof result.details === "object"
            ? result.details
            : {}),
          diff,
        },
      };
    },
    renderCall(
      args,
      theme,
      context: ToolRenderContext<BuiltinRenderState, any>,
    ) {
      if (context.executionStarted && context.state.startedAt === undefined)
        context.state.startedAt = Date.now();
      const component = (context.state.callComponent ??= new StableText());
      if (context.state.hasResult) {
        component.setText("");
        return component;
      }

      const glyph = context.executionStarted
        ? theme.fg("warning", "●")
        : theme.fg("dim", "○");
      const startedAt = context.state.startedAt;
      component.setText((width: number) => {
        const elapsed = startedAt
          ? theme.fg(
              "dim",
              padStartToWidth(
                formatDuration(Date.now() - startedAt),
                DURATION_COLUMN,
              ),
            )
          : "";
        // Each tool call is its own transcript item, so the row is a compact
        // root: the status glyph is the only marker. No tree edges, which would
        // falsely imply that separate tool calls are siblings in one tree.
        const lead = `${glyph} ${theme.fg("toolTitle", name)}`;
        const budget = Math.max(
          8,
          width -
            safeVisibleWidth(lead) -
            (elapsed ? safeVisibleWidth(elapsed) + 2 : 0) -
            1,
        );
        const rawArg = primaryArg(name, args);
        const arg =
          name === "bash"
            ? safeTruncateToWidth(rawArg, budget)
            : shortenPath(rawArg, budget);
        const left = `${lead} ${theme.fg("muted", arg)}`;
        return elapsed ? fitLine(left, elapsed, width) : left;
      });
      return component;
    },
    renderResult(
      result,
      options,
      theme,
      context: ToolRenderContext<BuiltinRenderState, any>,
    ) {
      context.state.hasResult = true;
      // Blank the call header so the tool is never listed twice; the result
      // header below replaces it in place.
      context.state.callComponent?.setText("");
      const runningNow = options.isPartial && !context.isError;
      if (!runningNow) context.state.endedAt ??= Date.now();

      const glyph = runningNow
        ? theme.fg("warning", "●")
        : context.isError
          ? theme.fg("error", "×")
          : theme.fg("success", "✓");
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
      const isMutation = name === "edit" || name === "write";
      const diff =
        !runningNow && !context.isError ? resultDiff(result) : undefined;
      const stats = isMutation ? formatDiffStats(theme, diff) : "";
      const expandHint =
        isMutation && diff
          ? theme.fg(
              "dim",
              options.expanded ? "ctrl+o collapse" : "ctrl+o diff",
            )
          : "";
      const output = textContent(result).trim();
      // The row is a self-contained receipt: no tree edge is drawn for it.
      // Identity reads left to right (glyph, name, arg, stats, hint) and only
      // the duration is right-anchored. The primary arg is budgeted first so a
      // long path gives way to the stats instead of clipping them off the row.
      const header = (width: number) => {
        const tail = [stats, width >= 72 ? expandHint : ""].filter(Boolean);
        const lead = `${glyph} ${theme.fg("toolTitle", name)}`;
        const tailText = tail.join(" ");
        const reserved =
          safeVisibleWidth(lead) +
          (tailText ? safeVisibleWidth(tailText) + 1 : 0) +
          (elapsed ? safeVisibleWidth(elapsed) + 2 : 0) +
          1;
        const budget = Math.max(8, width - reserved);
        const rawArg = primaryArg(name, context.args);
        // Commands read from the front; paths carry their meaning in the tail,
        // so shrink them from the left and keep the file name visible.
        const arg =
          name === "bash"
            ? safeTruncateToWidth(rawArg, budget)
            : shortenPath(rawArg, budget);
        const left = [lead, theme.fg("muted", arg), tailText]
          .filter(Boolean)
          .join(" ");
        return elapsed ? fitLine(left, elapsed, width) : left;
      };
      // A continuation rail appears only when there is actual body output. It
      // hangs under the tool name rather than at the glyph column so the body
      // reads as subordinate to this row, not as a branch of a larger tree.
      const indent = (line: string) => `  ${theme.fg("dim", TREE.rail)} ${line}`;

      if (context.isError) {
        if (!output) return stableText(header);
        const body = indent(theme.fg("error", cleanInline(output, 800)));
        return stableText((width: number) => `${header(width)}\n${body}`);
      }
      if (runningNow) return stableText(header);

      // Expanded sections render inside a padded background container, like
      // Pi's default ctrl+o tool box.
      if (options.expanded) {
        const bg = (text: string) =>
          theme.bg(context.isError ? "toolErrorBg" : "toolSuccessBg", text);
        const body = (innerWidth: number): string[] => {
          if (isMutation)
            return diff ? renderDiffLines(diff, theme, 80, innerWidth) : [];
          if (output)
            return boundedOutput(output, 80).map((line) =>
              theme.fg("toolOutput", line),
            );
          return [];
        };
        return paddedSection(header, body, bg);
      }

      if (name === "bash" && output) {
        const body = boundedOutput(output, 3, 1200).map((line) =>
          indent(theme.fg("toolOutput", line)),
        );
        return stableText(
          (width: number) => `${header(width)}\n${body.join("\n")}`,
        );
      }
      return stableText(header);
    },
  });
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && cwd.toLowerCase().startsWith(home.toLowerCase())
    ? `~${cwd.slice(home.length)}`
    : cwd;
}

/** Keep the tail segments of a path, which carry the identifying information. */
function shortenPath(value: string, max: number): string {
  if (value.length <= max) return value;
  const segments = value.split(/[\\/]+/).filter(Boolean);
  for (let start = 1; start < segments.length; start++) {
    const tail = `…/${segments.slice(start).join("/")}`;
    if (tail.length <= max) return tail;
  }
  const last = segments[segments.length - 1] ?? value;
  return last.length <= max ? last : `…${last.slice(-Math.max(1, max - 1))}`;
}

interface VsStatusParts {
  wide: string;
  narrow: string;
}

function parseVsCodeStatus(
  status: string | undefined,
): VsStatusParts | undefined {
  if (!status) return undefined;
  const body = cleanInline(status, 240).replace(/^VS Code:\s*/i, "");
  if (!body) return { wide: "VS connected", narrow: "VS●" };
  if (/bridge unavailable|no active editor/i.test(body)) {
    return {
      wide: `VS ${body}`,
      narrow: /unavailable/i.test(body) ? "VS!" : "VS○",
    };
  }
  const parts = body.split(/\s*(?:[•·]|\|)\s*/).filter(Boolean);
  const file = parts[0]
    ? path.basename(parts[0].replace(/^(?:●|\+)\s*/, ""))
    : "connected";
  const selection = parts.find((part) =>
    /\b(?:ln|col|sel)\b|@\s*\d/i.test(part),
  );
  const diagnostics = [...parts]
    .reverse()
    .find((part) => /^(?:[EWIH]\d+)(?:\s+[EWIH]\d+)*$|^(?:✓|OK)$/.test(part));
  const extras = [selection, diagnostics].filter(
    (part): part is string => !!part,
  );
  return {
    wide: `VS ${file}${extras.length ? ` | ${extras.join(" | ")}` : ""}`,
    narrow: `VS ${diagnostics ?? "●"}`,
  };
}

function taskCount(status: string | undefined): number {
  const match = stripAnsi(status ?? "").match(/tasks:(\d+)/i);
  return match ? Number(match[1]) : 0;
}

const RANDOM_INDICATOR_FRAME_COUNT = 256;
const RANDOM_INDICATOR_INTERVAL_MS = 120;

// One message is picked at random per run. The indicator is event-driven only:
// no extension-owned timer rewrites it mid-run.
const WORKING_MESSAGES = [
  "Thinking through it",
  "Tracing the next move",
  "Exploring the code",
  "Working the problem",
  "Following the signal",
  "Chasing the details",
  "Piecing it together",
];

function workingMessage(): string {
  return WORKING_MESSAGES[Math.floor(Math.random() * WORKING_MESSAGES.length)];
}

/** Thinking level drives the indicator hue, making the animation informative. */
const THINKING_TONES: Record<string, string> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

const WORKING_PATTERNS = [
  // Pulse from the center, then settle back on the beat.
  ["000010000", "010111010", "111111111", "010111010", "000010000"],
  // Horizontal and vertical sweeps.
  ["111000000", "000111000", "000000111", "000111000"],
  ["100100100", "010010010", "001001001", "010010010"],
  // Alternating checkerboard rhythm.
  ["101010101", "010101010", "101010101", "010101010"],
  // Expanding corners and contracting diagonals.
  ["100000001", "101010101", "111111111", "010101010"],
  ["001010100", "010101010", "100010001", "010101010"],
  // A dot walking around the perimeter.
  [
    "100000000",
    "010000000",
    "001000000",
    "000001000",
    "000000001",
    "000000010",
    "000000100",
    "000100000",
  ],
  // Two dots orbiting 180 degrees apart.
  [
    "100000001",
    "010000010",
    "001000100",
    "000101000",
    "001000100",
    "010000010",
  ],
  // Rain: columns falling on a stagger.
  [
    "100000000",
    "100100000",
    "010100100",
    "010010100",
    "001010010",
    "001001010",
    "000001001",
    "000000001",
  ],
  // Breathe: density ramps up from the center and releases.
  ["000010000", "010101010", "111111111", "010101010", "000010000"],
  // Scanline with a trailing dimmer column.
  ["100100100", "110110110", "011011011", "001001001", "000000000"],
] as const;

function shuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}

function renderWorkingDots(mask: string): string {
  let firstTwoColumns = 0;
  let thirdColumn = 0;
  for (let cell = 0; cell < 9; cell++) {
    if (mask[cell] !== "1") continue;
    const row = Math.floor(cell / 3);
    const column = cell % 3;
    if (column < 2) firstTwoColumns |= 1 << (row + column * 3);
    else thirdColumn |= 1 << row;
  }
  return `${String.fromCodePoint(0x2800 + firstTwoColumns)}${String.fromCodePoint(0x2800 + thirdColumn)}`;
}

function randomWorkingFrames(ctx: ExtensionContext, leadTone: string): string[] {
  const frames: string[] = [];
  while (frames.length < RANDOM_INDICATOR_FRAME_COUNT) {
    for (const sourcePattern of shuffle(WORKING_PATTERNS)) {
      // Randomly reverse each motif so repeated cycles keep their rhythm without
      // always moving in the same direction or appearing in the same order.
      const pattern =
        Math.random() < 0.5 ? [...sourcePattern].reverse() : sourcePattern;
      for (let beat = 0; beat < pattern.length; beat++) {
        // The leading beat carries the thinking-level hue; the rest decay so the
        // motion still reads as a trail.
        const tone = beat === 0 ? leadTone : beat % 2 === 0 ? "muted" : "dim";
        frames.push(ctx.ui.theme.fg(tone as any, renderWorkingDots(pattern[beat])));
        if (frames.length >= RANDOM_INDICATOR_FRAME_COUNT) return frames;
      }
    }
  }
  return frames;
}

function applyRandomWorkingIndicator(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (!ctx.hasUI) return;
  let leadTone = "accent";
  try {
    leadTone = THINKING_TONES[String(pi.getThinkingLevel())] ?? "accent";
  } catch {
    // Keep the default accent hue.
  }
  ctx.ui.setWorkingVisible(true);
  ctx.ui.setWorkingMessage(ctx.ui.theme.fg("dim", `${workingMessage()}...`));
  ctx.ui.setWorkingIndicator({
    frames: randomWorkingFrames(ctx, leadTone),
    intervalMs: RANDOM_INDICATOR_INTERVAL_MS,
  });
}

export default function (pi: ExtensionAPI) {
  // PI_MONO_UI=0 remains an emergency opt-out. The extension stays enabled by
  // default and uses dependency-free tool/footer rendering plus Pi's built-in
  // editor and working indicator.
  if (process.env.PI_MONO_UI === "0") return;

  // Regenerate the sequence for every run so retries and subsequent turns do
  // not reuse the same pseudo-random loop. This is event-driven only; Pi owns
  // the animation clock.
  pi.on("agent_start", (_event, ctx) => applyRandomWorkingIndicator(pi, ctx));

  registerBuiltin(pi, "read", createReadToolDefinition);
  registerBuiltin(pi, "bash", createBashToolDefinition);
  registerBuiltin(pi, "edit", createEditToolDefinition);
  registerBuiltin(pi, "write", createWriteToolDefinition);

  pi.on("session_start", (_event, ctx) => installLayout(pi, ctx));

  function installLayout(piApi: ExtensionAPI, ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    applyRandomWorkingIndicator(piApi, ctx);

    class MonoEditor extends CustomEditor {
      constructor(
        tui: TUI,
        theme: EditorTheme,
        keybindings: KeybindingsManager,
      ) {
        super(tui, theme, keybindings, { paddingX: 2 });
      }

      render(width: number): string[] {
        try {
          const lines = super.render(width);
          if (!lines.length) return lines;

          // Keep every upstream editor row and cursor calculation intact. Only
          // repaint the existing top border and replace its two leading padding
          // cells with a prompt glyph; no rows or terminal columns are added.
          // Model/thinking now lives in the footer information system instead
          // of floating alone above the input's right edge.
          lines[0] = ctx.ui.theme.fg(
            "borderMuted",
            "─".repeat(Math.max(0, width)),
          );

          if (lines.length > 1) {
            const inputLine = stripAnsi(lines[1]);
            if (inputLine.startsWith("  ")) {
              lines[1] = `${ctx.ui.theme.fg("accent", "❯")} ${lines[1].slice(2)}`;
            }
          }
          // The editor itself uses Pi's authoritative width/cursor layout.
          // Do not post-process its rows; clipping here can remove the hidden
          // hardware-cursor marker that anchors IME placement.
          return lines;
        } catch (error) {
          reportRenderFailure("editor", error);
          return [
            fallbackTruncateToWidth("─".repeat(Math.max(0, width)), width),
          ];
        }
      }
    }

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new MonoEditor(tui, theme, keybindings),
    );

    // Token totals are O(session length) to compute; cache them and only
    // rescan when the entry count changes rather than on every render tick.
    let usageCache = {
      entryCount: -1,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const sessionUsage = () => {
      const entries = ctx.sessionManager.getEntries();
      if (entries.length === usageCache.entryCount) return usageCache;
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      for (const entry of entries) {
        if (entry.type === "message" && entry.message.role === "assistant") {
          const message = entry.message as AssistantMessage;
          input += message.usage.input || 0;
          output += message.usage.output || 0;
          cacheRead += message.usage.cacheRead || 0;
          cacheWrite += message.usage.cacheWrite || 0;
        }
      }
      usageCache = {
        entryCount: entries.length,
        input,
        output,
        cacheRead,
        cacheWrite,
      };
      return usageCache;
    };

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          try {
            if (width <= 0) return [];
            const { input, output, cacheRead, cacheWrite } = sessionUsage();
            const usage = ctx.getContextUsage();
            const window =
              usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
            const tokens = usage?.tokens;
            const percent = usage?.percent;
            // A continuous rule reads quieter than outlined boxes: the empty
            // track recedes instead of competing with the filled portion.
            const gauge = (track: number) => {
              const cells =
                percent == null
                  ? 0
                  : Math.max(
                      0,
                      Math.min(track, Math.round((percent / 100) * track)),
                    );
              const tone =
                percent == null
                  ? "borderMuted"
                  : percent >= 90
                    ? "error"
                    : percent >= 70
                      ? "warning"
                      : "accent";
              return `${theme.fg(tone, "━".repeat(cells))}${theme.fg("borderMuted", "─".repeat(track - cells))}`;
            };
            const promptTokens = input + cacheRead + cacheWrite;
            const cacheHit = promptTokens
              ? Math.round((cacheRead / promptTokens) * 100)
              : 0;
            const statuses = footerData.getExtensionStatuses();
            const vs = parseVsCodeStatus(statuses.get("pi-vscode"));
            const mcpEntry = [...statuses.entries()].find(([key]) =>
              key.toLowerCase().includes("mcp"),
            );
            const otherStatus = [...statuses.entries()].find(
              ([key]) =>
                key !== "pi-vscode" &&
                key !== "tasks" &&
                !key.toLowerCase().includes("mcp"),
            );
            const tasks = taskCount(statuses.get("tasks"));
            const branch = footerData.getGitBranch();
            const cwd = formatCwd(ctx.cwd);

            // Dynamic counters are padded to a fixed cell so the footer does
            // not jitter column-by-column as numbers grow during a turn.
            const used = padStartToWidth(
              tokens == null ? "?" : formatTokens(tokens),
              5,
            );
            const total = window > 0 ? formatTokens(window) : "?";
            const pct =
              percent == null
                ? "   ?"
                : padStartToWidth(`${Math.round(percent)}%`, 4);
            const place = (text: string) => theme.fg("muted", text);
            const value = (text: string) => theme.fg("dim", text);

            const placeItem = [
              place(`${cwd}${branch ? `:${branch}` : ""}`),
              place(`${shortenPath(cwd, 22)}${branch ? `:${branch}` : ""}`),
              place(
                `${shortenPath(cwd, 14)}${branch ? `:${shortenPath(branch, 14)}` : ""}`,
              ),
              place(
                `${shortenPath(cwd, 8)}${branch ? `:${shortenPath(branch, 10)}` : ""}`,
              ),
            ];
            const contextItem = [
              `${gauge(10)} ${value(`${used}/${total}`)}`,
              `${gauge(8)} ${value(`${used}/${total}`)}`,
              `${gauge(6)} ${value(pct)}`,
            ];
            const inputText = formatTokens(input);
            const outputText = formatTokens(output);
            const trafficItem = [
              value(
                `↑${padStartToWidth(inputText, 5)} ↓${padStartToWidth(outputText, 5)} cache ${padStartToWidth(`${cacheHit}%`, 4)}`,
              ),
              value(`↑${inputText} ↓${outputText}`),
            ];
            const thinking = String(piApi.getThinkingLevel());
            const modelId = ctx.model?.id ?? "no-model";
            const modelItem = [
              `${value(modelId)} ${theme.fg((THINKING_TONES[thinking] ?? "muted") as any, thinking)}`,
              `${value(shortenPath(modelId, 16))} ${theme.fg((THINKING_TONES[thinking] ?? "muted") as any, thinking.slice(0, 3))}`,
            ];
            const mcpText = mcpEntry
              ? cleanInline(mcpEntry[1], 40)
                  .replace(/^MCP:\s*/i, "")
                  .replace(/\s*servers?$/i, "")
              : "";
            const mcpItem = mcpText
              ? [value(`mcp ${mcpText}`), value(`mcp ${mcpText}`)]
              : undefined;
            const taskItem = tasks
              ? [
                  theme.fg("accent", `${tasks} task${tasks === 1 ? "" : "s"}`),
                  theme.fg("accent", `T${tasks}`),
                ]
              : undefined;
            const vsItem = vs
              ? [theme.fg("muted", vs.wide), theme.fg("muted", vs.narrow)]
              : undefined;
            const otherItem = otherStatus
              ? [value(cleanInline(otherStatus[1], 40))]
              : undefined;

            const separator = theme.fg("borderMuted", "  ·  ");
            const has = (item?: string[]): item is string[] => !!item;
            const narrowest = (item: string[]) => item[item.length - 1];

            /**
             * Fit a row by shrinking individual cells in a fixed give-way order
             * rather than degrading every cell in lockstep, so a wide terminal
             * never abbreviates a field it had room to show in full.
             * Cell arrays are stable per-render objects, so they are used
             * directly as identity keys for the per-row level map.
             * Returns undefined when even the narrowest form overflows, so a
             * caller never emits a row that was silently clipped.
             */
            const pack = (
              cells: string[][],
              right: string[] | undefined,
              giveWay: string[][],
            ): string[] | undefined => {
              const levels = new Map<string[], number>();
              const at = (cell: string[]) =>
                cell[Math.min(levels.get(cell) ?? 0, cell.length - 1)];
              const measure = () => {
                // Separators carry ANSI styling; widths are measured on the
                // joined string so the escape sequences are never counted.
                const left = cells.map(at).join(separator);
                const tail = right ? at(right) : "";
                return {
                  left,
                  tail,
                  total:
                    safeVisibleWidth(left) +
                    (tail ? 2 + safeVisibleWidth(tail) : 0),
                };
              };
              // Only cells actually on this row can give way; otherwise the
              // budget is spent degrading a field the row does not render.
              const present = new Set<string[]>([
                ...cells,
                ...(right ? [right] : []),
              ]);
              let state = measure();
              for (const cell of giveWay) {
                if (!present.has(cell)) continue;
                while (
                  state.total > width &&
                  (levels.get(cell) ?? 0) < cell.length - 1
                ) {
                  levels.set(cell, (levels.get(cell) ?? 0) + 1);
                  state = measure();
                }
                if (state.total <= width) break;
              }
              if (state.total > width) return undefined;
              return [
                state.tail
                  ? fitLine(state.left, state.tail, width)
                  : safeTruncateToWidth(state.left, width),
              ];
            };

            // Place and context anchor the left; session identity
            // (model/thinking) anchors the right so it belongs to the footer
            // information system instead of floating above the input border.
            const detail = [
              trafficItem,
              taskItem,
              vsItem,
              mcpItem,
              otherItem,
            ].filter(has);
            // Give-way order: identity/location abbreviate before the numbers
            // the user reads, and the context gauge yields last.
            const giveWay = [
              placeItem,
              vsItem,
              modelItem,
              trafficItem,
              taskItem,
              contextItem,
            ].filter(has);

            // Wide: one balanced line carrying everything.
            const single = pack(
              [placeItem, contextItem, ...detail],
              modelItem,
              giveWay,
            );
            if (single) return single;

            // Medium: identity, context and model hold the primary line and the
            // tail of the detail group moves down as a block. The split is
            // taken as late as possible so the second line is a coherent group;
            // a single leftover item is never stranded on its own line, so a
            // solitary MCP status is either carried on the primary line or
            // dropped with the rest of the overflow.
            for (let split = detail.length - 1; split >= 0; split--) {
              const tail = detail.slice(split);
              // A single status (mcp, vs, task count) never earns a line of its
              // own; only the multi-field traffic group reads as a coherent
              // second line by itself.
              if (tail.length === 1 && tail[0] !== trafficItem) continue;
              const primary = pack(
                [placeItem, contextItem, ...detail.slice(0, split)],
                modelItem,
                giveWay,
              );
              if (!primary) continue;
              const secondary = pack(tail, undefined, giveWay);
              if (secondary) return [primary[0], secondary[0]];
            }

            // Narrow: the context bar stays visible and everything else yields.
            return (
              pack([placeItem, contextItem], undefined, giveWay) ??
              pack([contextItem], undefined, giveWay) ?? [
                safeTruncateToWidth(narrowest(contextItem), width),
              ]
            );
          } catch (error) {
            reportRenderFailure("footer", error);
            return [fallbackTruncateToWidth("mono-ui", width)];
          }
        },
      };
    });
  }
}
