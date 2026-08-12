// unified-edit-adapter: Pi tool registration and optional Apex receipt for the
// deep EditPlanner in unified-edit.ts.

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeTruncateToWidth } from "./safe-text-layout.ts";
import { formatDiffStats, renderDiffLines, resultDiff } from "./edit-diff.ts";
import { toolRenderers, type ToolRenderState } from "./tool-receipt.ts";
import { withApexPresentation } from "./presentation.ts";
import { cleanInline, type ToolRenderContext } from "./ui-common.ts";
import {
  TOOL_DESCRIPTION,
  TOOL_PROMPT_GUIDELINES,
  TOOL_PROMPT_SNIPPET,
  applyPlan,
  buildPlan,
  formatSummary,
  preflightPlan,
  prepareUnifiedArguments,
  unifiedEditSchema,
  type UnifiedEditDetails,
  type UnifiedEditParams,
} from "./unified-edit.ts";

function shortenPath(path: unknown): string {
  if (typeof path !== "string") return "";
  const home = homedir();
  const pathKey = process.platform === "win32" ? path.toLowerCase() : path;
  const homeKey = process.platform === "win32" ? home.toLowerCase() : home;
  if (
    pathKey === homeKey ||
    pathKey.startsWith(`${homeKey}/`) ||
    pathKey.startsWith(`${homeKey}\\`)
  ) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function renderablePaths(text: string | undefined): string[] {
  if (!text) return [];
  const paths: string[] = [];
  const rowHeader = /^\[([^\]]+)]\s*$/;
  const patchHeader = /^\*\*\* (?:Add|Delete|Update) File:\s+(.+)$/;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const match = rowHeader.exec(raw.trim()) ?? patchHeader.exec(raw.trim());
    const path = match?.[1]?.trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function formatUnifiedEditArg(args: unknown, budget: number): string {
  const prepared = prepareUnifiedArguments(args);
  const paths = renderablePaths(prepared.text);
  if (!paths.length) return "...";
  if (paths.length > 1) return `${paths.length} files`;
  return safeTruncateToWidth(cleanInline(shortenPath(paths[0]), 240), budget);
}

export default function unifiedEditExtension(pi: ExtensionAPI): void {
  let lastTheme:
    | { fg: (key: any, text: string) => string; inverse?: (text: string) => string }
    | undefined;
  const ui = toolRenderers<UnifiedEditParams>({
    surface: "edit",
    title: "edit",
    expandVerb: "diff",
    expandWhen: (result, _args, isError) => !isError && !!resultDiff(result),
    arg: formatUnifiedEditArg,
    stats: (result, _args, theme) => formatDiffStats(theme, resultDiff(result)),
    preview: () => [],
    body: (_output, result, _args, innerWidth) => {
      const diff = resultDiff(result);
      return diff
        ? renderDiffLines(
            diff,
            lastTheme ?? { fg: (_key, text) => text },
            80,
            innerWidth,
          )
        : [];
    },
  });

  pi.registerTool<any, UnifiedEditDetails, ToolRenderState>({
    name: "edit",
    label: "edit",
    description: TOOL_DESCRIPTION,
    promptSnippet: TOOL_PROMPT_SNIPPET,
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: unifiedEditSchema,
    prepareArguments: prepareUnifiedArguments,
    async execute(_toolCallId, params: UnifiedEditParams, signal, _onUpdate, ctx) {
      const text = params.text;
      if (typeof text !== "string" || text.trim() === "") {
        throw new Error("edit requires a non-empty text payload.");
      }
      const plan = await buildPlan(text, ctx.cwd);
      try {
        await preflightPlan(plan, signal);
      } catch (error: any) {
        throw new Error(
          `Preflight failed before mutating files.\n${error?.message ?? String(error)}`,
        );
      }
      const details = await applyPlan(plan, signal);
      return {
        content: [{ type: "text" as const, text: formatSummary(details) }],
        details,
      };
    },
    ...withApexPresentation({
      renderShell: "self" as const,
      renderCall(
        args: any,
        theme: any,
        context: ToolRenderContext<ToolRenderState, any>,
      ) {
        return ui.renderCall(args, theme, context);
      },
      renderResult(
        result: any,
        options: { expanded: boolean; isPartial: boolean },
        theme: any,
        context: ToolRenderContext<ToolRenderState, any>,
      ) {
        lastTheme = theme;
        return ui.renderResult(result, options, theme, context);
      },
    }),
  });
}
