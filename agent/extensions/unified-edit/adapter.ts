// unified-edit adapter: standalone Pi tool registration for the deep EditPlanner.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
} from "./planner.ts";

export default function unifiedEditExtension(pi: ExtensionAPI): void {
  pi.registerTool<any, UnifiedEditDetails>({
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
  });
}
