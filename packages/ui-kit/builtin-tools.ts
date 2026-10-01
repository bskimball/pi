// builtin-tools: kit adapters for Pi's built-in bash/write tools, plus the
// kit-owned todo tools.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createBashToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type ToolRenderState } from "./internal/presentation/tool-receipt.ts";
import { withApexPresentation } from "./internal/presentation/presentation.ts";
import { generateDiffString, normalizeToLF } from "./internal/presentation/edit-diff.ts";
import { type ToolRenderContext } from "./internal/presentation/ui-common.ts";
import {
  createBuiltinToolRenderers,
  type BuiltinName,
} from "./internal/presentation/builtin-tool-renderers.ts";
import { installTodoTools } from "./internal/todo/todo-tools.ts";

type BuiltinRenderState = ToolRenderState;

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
  const ui = createBuiltinToolRenderers(name);

  // Renderer slots snapshot at registration, so re-register on every live
  // presentation switch. The execute closure, cwd cache, and theme capture
  // live in this scope and survive re-registration; the SDK refresh keeps
  // the current active set and only adds brand-new tool names, so hidden
  // tools stay hidden.
  function register(): void {
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
        return ui.renderResult(result, options, theme, context);
      },
    }),
  });
  }
  register();
  pi.events.on("pi:ui:changed", () => register());
}

export function installBuiltinTools(pi: ExtensionAPI): void {
  registerBuiltin(pi, "bash", createBashToolDefinition);
  registerBuiltin(pi, "write", createWriteToolDefinition);
}

/**
 * The session todo dock (tools, above-editor panel, alt+t / `/todos`, alt+a /
 * `/agents`) must be installed even under PI_UI_CHROME=0. The dock keeps an
 * unstyled plain todo widget mounted in that mode; styled chrome drops out
 * and the registered controls remain inactive until presentation is enabled.
 */
export function installKitOwnedTools(pi: ExtensionAPI): void {
  installTodoTools(pi);
}
