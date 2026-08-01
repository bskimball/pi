/**
 * Thin on-demand LSP navigation for TypeScript, Python, Go, and PHP.
 * No always-on analysis, auto-install, formatting, or TUI chrome.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LspManager } from "./manager.ts";

const OPERATIONS = [
  "definition",
  "references",
  "hover",
  "document_symbols",
  "workspace_symbols",
  "diagnostics",
  "read_symbol",
] as const;

export default function (pi: ExtensionAPI): void {
  const manager = new LspManager();

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
  });
}
