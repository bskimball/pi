// builtin-tools: Apex adapters for Pi's built-in bash/write tools, plus the
// Apex-owned todo tools. pi-better-edit owns read/edit execute; Apex skins
// those tools through the headless receipt wrap in better-edit-receipt.ts.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createBashToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { padStartToWidth, safeTruncateToWidth } from "./internal/presentation/safe-text-layout.ts";
import {
  boundedOutput,
  toolRenderers,
  type ToolRenderState,
} from "./internal/presentation/tool-receipt.ts";
import { withApexPresentation } from "./internal/presentation/presentation.ts";
import {
  formatDiffStats,
  generateDiffString,
  normalizeToLF,
  renderDiffLines,
  resultDiff,
} from "./internal/presentation/edit-diff.ts";
import { cleanInline, type ToolRenderContext } from "./internal/presentation/ui-common.ts";
import { installTodoTools } from "./internal/todo/todo-tools.ts";

type BuiltinName = "read" | "bash" | "write";
type BuiltinRenderState = ToolRenderState;

function primaryArg(name: BuiltinName, args: any): string {
  if (name === "bash") return cleanInline(args?.command, 120);
  const filePath = cleanInline(args?.path, 120);
  if (name === "read" && args?.offset) {
    return `${filePath}:${args.offset}${args?.limit ? `+${args.limit}` : ""}`;
  }
  return filePath;
}

const READ_NOTICE_RE =
  /^(?:\[Showing lines \d+-\d+ of \d+.*\]|\[\d+ more lines in file\. Use offset=\d+ to continue\.\]|\[Line \d+ is .*exceeds .*limit\..*\]|\.\.\. \d+ more lines|\.\.\. output truncated at \d+ characters)$/;

function numberReadLines(
  lines: string[],
  offset: unknown,
  theme: { fg: (key: any, text: string) => string } | undefined,
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
    if (READ_NOTICE_RE.test(line)) return dim(line);
    const numbered = `${padStartToWidth(String(lineNumber), gutter)} `;
    lineNumber++;
    return `${dim(numbered)}${body(safeTruncateToWidth(line, innerWidth - gutter - 1))}`;
  });
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
  try {
    return {
      content: await fs.readFile(resolveToolPath(filePath, cwd), "utf-8"),
      ok: true,
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { content: "", ok: true };
    return { content: undefined, ok: false };
  }
}

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

function registerBuiltin(
  pi: ExtensionAPI,
  name: BuiltinName,
  make: (cwd: string) => ToolDefinition<any, any, any>,
): void {
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
  const isMutation = name === "write";
  let lastTheme:
    | { fg: (key: any, text: string) => string; inverse?: (text: string) => string }
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
      return isMutation ? formatDiffStats(theme, resultDiff(result)) : "";
    },
    preview(output) {
      return name === "bash" && output ? boundedOutput(output, 3, 1200) : [];
    },
    body(output, result, args, innerWidth) {
      if (isMutation) {
        const diff = resultDiff(result);
        return diff
          ? renderDiffLines(
              diff,
              lastTheme ?? { fg: (_key, text) => text },
              80,
              innerWidth,
            )
          : [];
      }
      if (!output) return [];
      const lines = boundedOutput(output, 80);
      return name === "read"
        ? numberReadLines(lines, args?.offset, lastTheme, innerWidth)
        : lines;
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
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const definition = get(ctx.cwd);
      if (name !== "write") {
        return definition.execute(toolCallId, params, signal, onUpdate, ctx);
      }
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
      if (!prior.ok || prior.content === undefined || result?.details?.diff) {
        return result;
      }
      const newContent = typeof params?.content === "string" ? params.content : "";
      return {
        ...result,
        details: {
          ...(result?.details && typeof result.details === "object"
            ? result.details
            : {}),
          diff: generateDiffString(
            normalizeToLF(prior.content),
            normalizeToLF(newContent),
          ),
        },
      };
    },
    ...withApexPresentation({
      renderShell: "self" as const,
      renderCall(
        args: any,
        theme: any,
        context: ToolRenderContext<BuiltinRenderState, any>,
      ) {
        return ui.renderCall(args, theme, context);
      },
      renderResult(
        result: any,
        options: { expanded: boolean; isPartial: boolean },
        theme: any,
        context: ToolRenderContext<BuiltinRenderState, any>,
      ) {
        lastTheme = theme;
        return ui.renderResult(result, options, theme, context);
      },
    }),
  });
}

export function installBuiltinTools(pi: ExtensionAPI): void {
  registerBuiltin(pi, "bash", createBashToolDefinition);
  registerBuiltin(pi, "write", createWriteToolDefinition);
}

/**
 * The session todo dock (tools, above-editor panel, alt+t / `/todos`, alt+a /
 * `/agents`) must be installed even under PI_APEX_UI=0. The dock keeps an
 * unstyled plain todo widget mounted in that mode; styled chrome and triggers
 * drop out. pi-better-edit owns read/edit execute; Apex attaches receipts.
 */
export function installApexOwnedTools(pi: ExtensionAPI): void {
  installTodoTools(pi);
}
