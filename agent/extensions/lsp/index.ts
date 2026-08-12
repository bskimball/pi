/**
 * Thin on-demand LSP navigation for TypeScript, Python, Go, and PHP.
 * No always-on analysis, auto-install, or formatting. Presentation reuses
 * Apex's shared tool receipt; no bespoke chrome.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LspManager } from "./manager.ts";
import {
  boundedOutput,
  toolRenderers,
  type ToolRenderState,
} from "../apex/lib/tool-receipt.ts";
import { withApexPresentation } from "../apex/lib/presentation.ts";
import { cleanInline, type ToolRenderContext } from "../apex/lib/ui-common.ts";
import { safeTruncateToWidth } from "../apex/lib/safe-text-layout.ts";

const OPERATIONS = [
  "definition",
  "references",
  "hover",
  "document_symbols",
  "workspace_symbols",
  "diagnostics",
  "read_symbol",
] as const;

type LspArgs = {
  operation?: string;
  path?: string;
  line?: number;
  column?: number;
  query?: string;
  limit?: number;
};

/** Keep the identifying tail segments of a path within the header budget. */
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

/** Receipt title: `lsp <operation>`, so the arg never repeats the operation. */
export function lspTitle(args: LspArgs | undefined): string {
  const operation =
    typeof args?.operation === "string" ? args.operation.trim() : "";
  return operation ? `lsp ${cleanInline(operation, 24)}` : "lsp";
}

/**
 * Compact header argument: the location or query the operation acts on —
 * `path:line:col`, `path`, `"query"`, or `"query" in path`. Never JSON.
 */
export function lspArgSummary(args: LspArgs | undefined, budget = 120): string {
  const max = Math.max(0, Math.floor(budget));
  if (max === 0) return "";
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  const rawPath = typeof args?.path === "string" ? args.path.trim() : "";
  const line =
    typeof args?.line === "number" && Number.isFinite(args.line)
      ? Math.floor(args.line)
      : undefined;
  const column =
    typeof args?.column === "number" && Number.isFinite(args.column)
      ? Math.floor(args.column)
      : undefined;

  if (query) {
    const quoted = `"${cleanInline(query, 48)}"`;
    if (!rawPath) return safeTruncateToWidth(cleanInline(quoted, max), max);
    const suffix = " in ";
    const room = max - quoted.length - suffix.length;
    if (room < 6) return safeTruncateToWidth(cleanInline(quoted, max), max);
    const path = cleanInline(rawPath, Math.max(240, rawPath.length));
    return safeTruncateToWidth(
      `${quoted}${suffix}${shortenPath(path, room)}`,
      max,
    );
  }

  if (!rawPath) return "";
  const position =
    line !== undefined
      ? column !== undefined
        ? `:${line}:${column}`
        : `:${line}`
      : "";
  const room = Math.max(6, max - position.length);
  const path = cleanInline(rawPath, Math.max(240, rawPath.length));
  return safeTruncateToWidth(`${shortenPath(path, room)}${position}`, max);
}

export default function (pi: ExtensionAPI): void {
  const manager = new LspManager();

  // Shared Apex receipt chrome, identical to read/bash/edit/write and MCP.
  const ui = toolRenderers<LspArgs>({
    surface: "lsp",
    title: (args) => lspTitle(args),
    arg: (args, budget) => lspArgSummary(args, budget),
    preview: (output) => (output ? boundedOutput(output, 3, 1200) : []),
  });

  pi.on("session_start", async (_event, ctx) => {
    // Dispose leaves the manager shut down; rearm for the new/resumed session.
    manager.rearm(ctx.cwd);
  });

  pi.on("session_shutdown", async () => {
    await manager.dispose();
  });

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: [
      "On-demand semantic navigation via language servers already on PATH.",
      "Languages: TypeScript/JavaScript (typescript-language-server), Python (pyright-langserver), Go (gopls), PHP (phpactor or intelephense).",
      "Operations:",
      "- definition: go to definition at path/line/column (1-based).",
      "- references: find references at path/line/column; includeDeclaration defaults true.",
      "- hover: hover info at path/line/column.",
      "- document_symbols: outline symbols for path.",
      "- workspace_symbols: search symbols by query (optional path anchors language).",
      "- diagnostics: diagnostics for path (pull if supported; otherwise bounded push wait; may report status unknown).",
      "- read_symbol: resolve query to a symbol and return its source range with line numbers (optional path; reports ambiguity).",
      "Does not install servers, format code, or run always-on analysis.",
      "Optional config: ~/.pi/agent/lsp.json or trusted .pi/lsp.json (servers.*, timeoutMs).",
      "Bare server commands (e.g. gopls) resolve on PATH only — never from the project directory.",
      "Explicit relative commands (./bin/server) resolve against the config file directory; absolute paths as given.",
    ].join(" "),
    parameters: Type.Object({
      operation: Type.Union(
        OPERATIONS.map((value) => Type.Literal(value)),
        {
          description:
            "LSP operation: definition | references | hover | document_symbols | workspace_symbols | diagnostics | read_symbol",
        },
      ),
      path: Type.Optional(
        Type.String({
          description:
            "File path (absolute or cwd-relative). Required for definition, references, hover, document_symbols, diagnostics. Optional anchor for workspace_symbols/read_symbol.",
        }),
      ),
      line: Type.Optional(
        Type.Number({
          description: "1-based line number (definition, references, hover).",
        }),
      ),
      column: Type.Optional(
        Type.Number({
          description: "1-based column / character (definition, references, hover). UTF-16 code units as in typical editors.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description: "Symbol query for workspace_symbols and read_symbol.",
        }),
      ),
      includeDeclaration: Type.Optional(
        Type.Boolean({
          description: "For references: include the declaration (default true).",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max results to return (bounded; default depends on operation).",
        }),
      ),
      context: Type.Optional(
        Type.Number({
          description: "For read_symbol: extra context lines above/below the symbol range (default 2, max 10).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx?.cwd) manager.setCwd(ctx.cwd);
      return manager.execute(
        {
          operation: params.operation,
          path: params.path,
          line: params.line,
          column: params.column,
          query: params.query,
          includeDeclaration: params.includeDeclaration,
          limit: params.limit,
          context: params.context,
        },
        signal,
      );
    },
    ...withApexPresentation({
      renderShell: "self" as const,
      renderCall(
        args: LspArgs,
        theme: any,
        context: ToolRenderContext<ToolRenderState, LspArgs>,
      ) {
        return ui.renderCall(args, theme, context);
      },
      renderResult(
        result: any,
        options: { expanded: boolean; isPartial: boolean },
        theme: any,
        context: ToolRenderContext<ToolRenderState, LspArgs>,
      ) {
        return ui.renderResult(result, options, theme, context);
      },
    }),
  });
}
