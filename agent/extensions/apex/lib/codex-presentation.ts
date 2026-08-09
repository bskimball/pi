// codex-presentation: Apex receipt chrome for the Codex conversion package's
// structured tools (exec_command, write_stdin, apply_patch, view_image,
// web_run, imagegen).
//
// Installed on the *same* ExtensionAPI the package boots on (see
// agent/extensions/codex-conversion.ts): Pi gives each extension its own
// API/tool map, so the registerTool patch must live on that instance. Lives
// in apex/lib so the shim does not load apex-ui's default-export side-effect
// graph.
//
// Rendering follows tool-receipt.ts: passive bounded strings only — no pi-tui
// Text/Markdown/Container, no timers, no requestRender.

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { cleanInline, type ToolRenderContext } from "./ui-common.ts";
import { safeTruncateToWidth } from "./safe-text-layout.ts";
import { toolRenderers, type ToolRenderState } from "./tool-receipt.ts";

/**
 * Exact tool names registered by @howaboua/pi-codex-conversion 3.0.12
 * (dist/extension/tools.js → dist/tools/*). `web_run` and `imagegen` are
 * config-optional but keep stable names. Code Mode's `exec`/`wait` are a
 * separate dormant surface (`beta.codeMode` is off in this setup) and stay
 * untouched, as does everything outside this allowlist.
 */
const CODEX_TOOL_NAMES = new Set([
  "exec_command",
  "write_stdin",
  "apply_patch",
  "view_image",
  "web_run",
  "imagegen",
]);

/** Whether a registered tool belongs to the Codex conversion package. */
export function isCodexToolDefinition(
  def: ToolDefinition<any, any, any>,
): boolean {
  return CODEX_TOOL_NAMES.has(def.name);
}

/** Receipt title: the tool name with underscores spaced (`exec command`). */
export function codexToolTitle(def: ToolDefinition<any, any, any>): string {
  return def.name.replace(/_/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

/** `*** Add/Update/Delete File: <path>` targets from an apply_patch input. */
function patchTargets(input: string): string[] {
  const targets: string[] = [];
  for (const match of input.matchAll(
    /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm,
  )) {
    targets.push(match[1].trim());
  }
  return targets;
}

function firstWebQuery(args: Record<string, unknown>): string {
  for (const key of ["search_query", "image_query"] as const) {
    const list = args[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const q = (entry as Record<string, unknown> | undefined)?.q;
      if (typeof q === "string" && q.trim()) return q.trim();
    }
  }
  return "";
}

/**
 * Compact one-line summary of Codex tool args for the receipt header. Mirrors
 * the package's arg shapes; never dumps the full patch text or stdin payload.
 */
export function formatCodexArgSummary(
  value: unknown,
  max = 120,
  toolName?: string,
): string {
  const args = asRecord(value);
  if (!args) {
    // A bare non-JSON string may be a raw command/prompt.
    return typeof value === "string" ? cleanInline(value, max) : "";
  }
  switch (toolName) {
    case "exec_command":
      return typeof args.cmd === "string"
        ? safeTruncateToWidth(cleanInline(args.cmd, max), max)
        : "";
    case "write_stdin": {
      const session =
        typeof args.session_id === "number" ? args.session_id : undefined;
      const chars =
        typeof args.chars === "string" && args.chars.trim()
          ? cleanInline(args.chars, 24)
          : "";
      const lead = session !== undefined ? `session ${session}` : "";
      return safeTruncateToWidth(
        [lead, chars].filter(Boolean).join(" "),
        max,
      );
    }
    case "apply_patch": {
      const input = typeof args.input === "string" ? args.input : "";
      const targets = patchTargets(input);
      if (!targets.length) {
        const lines = input.trim() ? input.split(/\r?\n/).length : 0;
        return lines ? `patch ${lines} ${lines === 1 ? "line" : "lines"}` : "";
      }
      const label =
        targets.length === 1
          ? targets[0]
          : `${targets.length} files (${targets[0]}, …)`;
      return safeTruncateToWidth(label, max);
    }
    case "view_image":
      return typeof args.path === "string"
        ? safeTruncateToWidth(cleanInline(args.path, max), max)
        : "";
    case "imagegen":
      return typeof args.prompt === "string"
        ? safeTruncateToWidth(cleanInline(args.prompt, max), max)
        : "";
    case "web_run": {
      const query = firstWebQuery(args);
      if (query) return safeTruncateToWidth(cleanInline(query, max), max);
      const open = args.open;
      if (Array.isArray(open) && open.length) {
        return `open ${open.length} ${open.length === 1 ? "ref" : "refs"}`;
      }
      return "";
    }
    default:
      return "";
  }
}

function wrapCodexTool(
  def: ToolDefinition<any, any, any>,
): ToolDefinition<any, any, any> {
  const ui = toolRenderers<any>({
    surface: "codex",
    title: () => codexToolTitle(def),
    arg: (args, budget) => formatCodexArgSummary(args, budget, def.name),
    // Default preview/body: the engine bounds the textContent body. The
    // package's hidden/grouped exec_command render state lives in its private
    // tracker; the Apex receipt deliberately always shows activity rather
    // than reaching into those internals to reproduce hiding.
    preview: (output) =>
      output
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .slice(0, 3),
  });

  return {
    ...def,
    renderShell: "self",
    renderCall(
      args,
      theme,
      context: ToolRenderContext<ToolRenderState, any>,
    ) {
      return ui.renderCall(args, theme, context);
    },
    renderResult(
      result,
      options,
      theme,
      context: ToolRenderContext<ToolRenderState, any>,
    ) {
      return ui.renderResult(result, options, theme, context);
    },
  };
}

/**
 * Monkey-patch `pi.registerTool` so Codex conversion tools get Apex's stable
 * receipt chrome even when the package ships custom Text/Container renderers
 * (`ui.toolRenaming`). Must run on the *same* ExtensionAPI instance the
 * package boots on — see agent/extensions/codex-conversion.ts. Definitions
 * outside the exact allowlist pass through untouched.
 */
export function installCodexPresentation(pi: ExtensionAPI): void {
  const originalRegisterTool = pi.registerTool.bind(pi);
  (pi as ExtensionAPI & {
    registerTool: typeof pi.registerTool;
  }).registerTool = ((def: ToolDefinition<any, any, any>) => {
    if (isCodexToolDefinition(def) && def.renderShell !== "self") {
      return originalRegisterTool(wrapCodexTool(def));
    }
    return originalRegisterTool(def);
  }) as typeof pi.registerTool;
}
