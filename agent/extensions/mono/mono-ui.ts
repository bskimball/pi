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
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  fallbackTruncateToWidth,
  padStartToWidth,
  safeTruncateToWidth,
  safeVisibleWidth,
} from "./lib/safe-text-layout.ts";
import {
  boundedOutput,
  reportRenderFailure,
  toolRenderers,
  type ToolRenderState,
} from "./lib/tool-receipt.ts";
import {
  formatDiffStats,
  generateDiffString,
  normalizeToLF,
  renderDiffLines,
  resultDiff,
} from "./lib/edit-diff.ts";
// Re-export so callers that still look for installMcpPresentation on mono-ui
// keep working; preferred import is ./lib/mcp-presentation.ts.
export { installMcpPresentation } from "./lib/mcp-presentation.ts";
import {
  cleanInline,
  fitLine,
  formatTokens,
  stripAnsi,
  type ToolRenderContext,
} from "./lib/ui-common.ts";

type BuiltinName = "read" | "bash" | "edit" | "write";
type BuiltinRenderState = ToolRenderState;

function primaryArg(name: BuiltinName, args: any): string {
  if (name === "bash") return cleanInline(args?.command, 120);
  const filePath = cleanInline(args?.path, 120);
  if (name === "read" && args?.offset)
    return `${filePath}:${args.offset}${args?.limit ? `+${args.limit}` : ""}`;
  return filePath;
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
  const isMutation = name === "edit" || name === "write";
  // Theme for expanded mutation diffs is captured on each renderResult call.
  let lastTheme:
    | {
        fg: (key: any, text: string) => string;
        inverse?: (text: string) => string;
      }
    | undefined;

  const ui = toolRenderers<any>({
    surface: name,
    title: name,
    expandVerb: isMutation ? "diff" : "expand",
    expandWhen: (result, _args, isError) =>
      isMutation && !isError && !!resultDiff(result),
    arg(args, budget) {
      const rawArg = primaryArg(name, args);
      return name === "bash"
        ? safeTruncateToWidth(rawArg, budget)
        : shortenPath(rawArg, budget);
    },
    stats(result, _args, theme) {
      if (!isMutation) return "";
      return formatDiffStats(theme, resultDiff(result));
    },
    preview(output) {
      // Collapsed preview is bash-only; mutations show +/− stats, read is header-only.
      if (name === "bash" && output) return boundedOutput(output, 3, 1200);
      return [];
    },
    body(output, result, _args, innerWidth) {
      if (isMutation) {
        const diff = resultDiff(result);
        // Pre-styled rows; the engine leaves ESC-bearing lines unpainted.
        return diff
          ? renderDiffLines(
              diff,
              lastTheme ?? { fg: (_k, t) => t },
              80,
              innerWidth,
            )
          : [];
      }
      return output ? boundedOutput(output, 80) : [];
    },
  });

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
    renderCall(args, theme, context: ToolRenderContext<BuiltinRenderState, any>) {
      return ui.renderCall(args, theme, context);
    },
    renderResult(
      result,
      options,
      theme,
      context: ToolRenderContext<BuiltinRenderState, any>,
    ) {
      lastTheme = theme;
      // Preserve prior mutation error handling: single-line error rail (not full expand).
      // The engine already supports error expand; keep behavior equivalent for bash/read.
      return ui.renderResult(result, options, theme, context);
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

  // MCP presentation is installed by agent/extensions/mcp-adapter.ts on the
  // adapter's own ExtensionAPI — not here (per-extension tool maps).

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
