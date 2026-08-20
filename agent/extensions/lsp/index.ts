/**
 * Standalone on-demand LSP navigation for TypeScript, Python, Go, PHP, Rust, and Zig.
 * No always-on analysis, auto-install, custom rendering, or formatting.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { Type } from "typebox";
import { LspManager } from "./manager.ts";
import { languageForPath } from "./paths.ts";
import { collectEditPaths, shouldDiagnosePostEdit } from "./post-edit.ts";

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
    manager.rearm(ctx.cwd);
  });

  pi.on("session_shutdown", async () => {
    await manager.dispose();
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!shouldDiagnosePostEdit(event)) return;
    const cwd = ctx.cwd;
    if (!cwd) return;
    manager.setCwd(cwd);

    const diagnostics: string[] = [];
    let remaining = 8_000;
    for (const path of collectEditPaths(event.input, cwd).slice(0, 4)) {
      try {
        if (statSync(path).isDirectory() || !languageForPath(path)) continue;
      } catch {
        continue;
      }
      const result = await manager.execute(
        { operation: "diagnostics", path, limit: 20 },
        undefined,
      );
      if (result.isError) {
        continue;
      }
      const text = result.content.map((part) => part.text).join("\n");
      if (!text) continue;
      const bounded = text.slice(0, remaining);
      diagnostics.push(bounded);
      remaining -= bounded.length;
      if (remaining <= 0) break;
    }
    if (!diagnostics.length) return;
    const existing = Array.isArray(event.content) ? event.content : [];
    return {
      content: [...existing, { type: "text" as const, text: `[lsp] ${diagnostics.join("\n")}` }],
    };
  });

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: [
      "On-demand semantic navigation via language servers already on PATH.",
      "Languages: TypeScript/JavaScript (typescript-language-server), Python (pyright-langserver), Go (gopls), PHP (phpactor or intelephense), Rust (rust-analyzer), Zig (zls).",
      "Operations:",
      "- definition: go to definition at path/line/column (1-based).",
      "- references: find references at path/line/column; includeDeclaration defaults true.",
      "- hover: hover info at path/line/column.",
      "- document_symbols: outline symbols for path.",
      "- workspace_symbols: search symbols by query (optional path anchors language).",
      "- diagnostics: diagnostics for path (pull if supported; otherwise bounded push wait; may report status unknown).",
      "- read_symbol: resolve query to a symbol and return its source range with line numbers (optional path; reports ambiguity).",
      "Uses servers only when they are already on PATH; does not install servers, format code, or run always-on analysis.",
      "Optional config: ~/.pi/agent/lsp.json or trusted .pi/lsp.json (servers.*, timeoutMs).",
      "Bare server commands resolve on PATH only; explicit relative commands resolve against the config file directory.",
    ].join(" "),
    parameters: Type.Object({
      operation: Type.Union(OPERATIONS.map((value) => Type.Literal(value))),
      path: Type.Optional(Type.String()),
      line: Type.Optional(Type.Number()),
      column: Type.Optional(Type.Number()),
      query: Type.Optional(Type.String()),
      includeDeclaration: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number()),
      context: Type.Optional(Type.Number()),
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
