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
  safeTruncateToWidth,
  safeVisibleWidth,
} from "./lib/safe-text-layout.ts";
import {
  cleanInline,
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
  private value = "";

  setText(value: unknown): void {
    this.value = typeof value === "string" ? value : String(value ?? "");
  }

  render(width: number): string[] {
    try {
      // Keep ANSI theme styling while clipping through the dependency-free
      // layout path; no pi-tui Text/Segmenter code runs here.
      if (!this.value) return [];
      return this.value
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

function stableText(text: unknown): StableText {
  const component = new StableText();
  component.setText(text);
  return component;
}

/** Header lines followed by a full-width background-padded body block, matching
 * Pi's default expanded tool box (ctrl+o). */
function paddedSection(
  headerLines: string[],
  bodyLines: string[],
  bg: (text: string) => string,
): Component {
  return {
    render(width: number): string[] {
      try {
        const lines = headerLines
          .flatMap((line) => line.split(/\r?\n/))
          .map((line) => safeTruncateToWidth(line.replace(/\t/g, "   "), width));
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

/** Pi-style colored numbered diff with single-line intra-line inverse highlights. */
function renderDiffLines(
  diffText: string,
  theme: {
    fg: (key: any, text: string) => string;
    inverse?: (text: string) => string;
  },
  maxLines = 80,
): string[] {
  const lines = diffText.split("\n");
  const result: string[] = [];
  let i = 0;
  const inverse = theme.inverse?.bind(theme) ?? ((text: string) => text);

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
        const removed = removedLines[0];
        const added = addedLines[0];
        const { removedLine, addedLine } = renderIntraLineDiff(
          replaceTabs(removed.content),
          replaceTabs(added.content),
          inverse,
        );
        result.push(
          theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`),
        );
        result.push(
          theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`),
        );
      } else {
        for (const removed of removedLines) {
          result.push(
            theme.fg(
              "toolDiffRemoved",
              `-${removed.lineNum} ${replaceTabs(removed.content)}`,
            ),
          );
        }
        for (const added of addedLines) {
          result.push(
            theme.fg(
              "toolDiffAdded",
              `+${added.lineNum} ${replaceTabs(added.content)}`,
            ),
          );
        }
      }
    } else if (parsed.prefix === "+") {
      result.push(
        theme.fg(
          "toolDiffAdded",
          `+${parsed.lineNum} ${replaceTabs(parsed.content)}`,
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
      const elapsed = context.state.startedAt
        ? theme.fg("dim", formatDuration(Date.now() - context.state.startedAt))
        : "";
      component.setText(
        [
          theme.fg("dim", "├"),
          glyph,
          theme.fg("toolTitle", name),
          theme.fg("muted", primaryArg(name, args)),
          elapsed,
        ]
          .filter(Boolean)
          .join(" "),
      );
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
            formatDuration(
              (context.state.endedAt ?? Date.now()) - context.state.startedAt,
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
      const header = [
        theme.fg("dim", "├"),
        glyph,
        theme.fg("toolTitle", name),
        theme.fg("muted", primaryArg(name, context.args)),
        stats,
        expandHint,
        elapsed,
      ]
        .filter(Boolean)
        .join(" ");
      const lines = [header];
      const output = textContent(result).trim();
      // Indent collapsed result lines underneath the tool name, matching the
      // task activity indentation style. Outer tool rails and nested result
      // gutters share the lighter dim token so they read as one tree.
      const indent = (line: string) =>
        `${theme.fg("dim", "   │")} ${line}`;

      if (context.isError) {
        if (output)
          lines.push(indent(theme.fg("error", cleanInline(output, 800))));
        return stableText(lines.join("\n"));
      }
      if (runningNow) return stableText(lines.join("\n"));

      // Expanded sections render inside a padded background container, like
      // Pi's default ctrl+o tool box.
      if (options.expanded) {
        const bg = (text: string) => theme.bg("toolSuccessBg", text);
        let body: string[] = [];
        if (name === "bash") {
          body = boundedOutput(output, 80).map((line) =>
            theme.fg("toolOutput", line),
          );
        } else if (isMutation) {
          if (diff) body = renderDiffLines(diff, theme, 80);
        } else if (output) {
          body = boundedOutput(output, 80).map((line) =>
            theme.fg("toolOutput", line),
          );
        }
        return paddedSection(lines, body, bg);
      }

      if (name === "bash") {
        for (const line of boundedOutput(output, 3, 1200))
          lines.push(indent(theme.fg("toolOutput", line)));
      }
      return stableText(lines.join("\n"));
    },
  });
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && cwd.toLowerCase().startsWith(home.toLowerCase())
    ? `~${cwd.slice(home.length)}`
    : cwd;
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

const WORKING_MESSAGES = [
  "Thinking through it",
  "Tracing the next move",
  "Exploring the code",
  "Working the problem",
  "Following the signal",
];

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

function randomWorkingFrames(ctx: ExtensionContext): string[] {
  const frames: string[] = [];
  while (frames.length < RANDOM_INDICATOR_FRAME_COUNT) {
    for (const sourcePattern of shuffle(WORKING_PATTERNS)) {
      // Randomly reverse each motif so repeated cycles keep their rhythm without
      // always moving in the same direction or appearing in the same order.
      const pattern = Math.random() < 0.5 ? [...sourcePattern].reverse() : sourcePattern;
      for (let beat = 0; beat < pattern.length; beat++) {
        const tone = beat === 0 ? "accent" : beat % 2 === 0 ? "muted" : "dim";
        frames.push(ctx.ui.theme.fg(tone, renderWorkingDots(pattern[beat])));
        if (frames.length >= RANDOM_INDICATOR_FRAME_COUNT) return frames;
      }
    }
  }
  return frames;
}

function applyRandomWorkingIndicator(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWorkingVisible(true);
  ctx.ui.setWorkingMessage(
    ctx.ui.theme.fg(
      "dim",
      `${WORKING_MESSAGES[Math.floor(Math.random() * WORKING_MESSAGES.length)]}...`,
    ),
  );
  ctx.ui.setWorkingIndicator({
    frames: randomWorkingFrames(ctx),
    intervalMs: RANDOM_INDICATOR_INTERVAL_MS,
  });
}

export default function (pi: ExtensionAPI) {
  // PI_MONO_UI=0 remains an emergency opt-out. The extension stays enabled by
  // default and uses dependency-free tool/footer rendering plus Pi's built-in
  // editor and working indicator.
  if (process.env.PI_MONO_UI === "0") return;

  // Regenerate the sequence for every low-level run so retries and subsequent
  // turns do not reuse the same pseudo-random loop.
  pi.on("agent_start", (_event, ctx) => {
    applyRandomWorkingIndicator(ctx);
  });

  registerBuiltin(pi, "read", createReadToolDefinition);
  registerBuiltin(pi, "bash", createBashToolDefinition);
  registerBuiltin(pi, "edit", createEditToolDefinition);
  registerBuiltin(pi, "write", createWriteToolDefinition);

  pi.on("session_start", (_event, ctx) => installLayout(pi, ctx));

  function installLayout(piApi: ExtensionAPI, ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    applyRandomWorkingIndicator(ctx);

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
          const modelString = `${ctx.model?.id ?? "no-model"} · ${piApi.getThinkingLevel()}`;
          const label = safeTruncateToWidth(modelString, Math.max(0, width - 1));
          const labelWidth = safeVisibleWidth(label);
          const gap = labelWidth > 0 && width > labelWidth ? 1 : 0;
          const borderWidth = Math.max(0, width - labelWidth - gap);
          lines[0] = `${ctx.ui.theme.fg("borderMuted", "─".repeat(borderWidth))}${gap ? " " : ""}${ctx.ui.theme.fg("muted", label)}`;

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
            const { input, output, cacheRead, cacheWrite } = sessionUsage();
            const usage = ctx.getContextUsage();
            const window =
              usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
            const tokens = usage?.tokens;
            const cells =
              usage?.percent == null
                ? 0
                : Math.max(0, Math.min(10, Math.round(usage.percent / 10)));
            const gauge = `${theme.fg(cells >= 9 ? "error" : cells >= 7 ? "warning" : "accent", "■".repeat(cells))}${theme.fg("borderMuted", "□".repeat(10 - cells))}`;
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
            const cwd = `${formatCwd(ctx.cwd)}${branch ? `:${branch}` : ""}`;
            const context = `${gauge} ${tokens == null ? "?" : formatTokens(tokens)}/${formatTokens(window)}`;
            const stats = `↑${formatTokens(input)} ↓${formatTokens(output)} cache ${cacheHit}%`;
            const mainItems = [
              { text: cwd, min: 28 },
              { text: context, min: 48 },
              { text: stats, min: 64 },
              { text: tasks ? `T${tasks}` : undefined, min: 38 },
              {
                text: otherStatus ? cleanInline(otherStatus[1], 50) : undefined,
                min: 142,
              },
            ].filter(
              (item): item is { text: string; min: number } =>
                !!item.text && width >= item.min,
            );
            const separator = theme.fg("borderMuted", "  │  ");
            const main = mainItems.map((item) => item.text).join(separator);
            const secondaryItems = [
              mcpEntry ? cleanInline(mcpEntry[1], 50) : undefined,
              vs
                ? theme.fg("accent", width >= 105 ? vs.wide : vs.narrow)
                : undefined,
            ].filter((item): item is string => !!item);
            const secondary = secondaryItems.join(separator);
            const lines = [safeTruncateToWidth(main, width)];
            if (secondary) {
              lines.push(safeTruncateToWidth(secondary, width));
            }
            return lines;
          } catch (error) {
            reportRenderFailure("footer", error);
            return [fallbackTruncateToWidth("mono-ui", width)];
          }
        },
      };
    });
  }
}
