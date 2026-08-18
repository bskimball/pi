// lsp-receipt: Apex chrome for the headless lsp tool.
//
// LSP owns execute and stays independently removable. Apex cannot import
// that extension. First registration wins the whole tool, so this skins
// receipts through the shared headless ToolExecutionComponent wrap.
//
// PI_APEX_UI=0 skips the wrap. Any existing lsp presentation
// (renderCall, renderResult, or a non-default renderShell) wins.

import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  componentOwnsPresentation,
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const LSP_RECEIPT_TOOL = "lsp";

const OPERATIONS = [
  "definition",
  "references",
  "hover",
  "document_symbols",
  "workspace_symbols",
  "diagnostics",
  "read_symbol",
] as const;

type LspOperation = (typeof OPERATIONS)[number];

type LspArgs = {
  operation?: string;
  path?: string;
  line?: number;
  column?: number;
  query?: string;
  includeDeclaration?: boolean;
  limit?: number;
  context?: number;
};

type LspComponent = {
  toolName?: string;
  toolDefinition?: {
    renderCall?: unknown;
    renderResult?: unknown;
    renderShell?: unknown;
    [key: string]: unknown;
  };
  builtInToolDefinition?: {
    renderCall?: unknown;
    renderResult?: unknown;
    renderShell?: unknown;
    [key: string]: unknown;
  };
};

function operationOf(args: LspArgs | undefined): LspOperation {
  const raw = String(args?.operation ?? "").trim().toLowerCase();
  return (OPERATIONS as readonly string[]).includes(raw)
    ? (raw as LspOperation)
    : "definition";
}

function finiteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

/** Last two path segments so a header stays compact. */
export function shortLspPath(raw: string | undefined): string {
  const cleaned = cleanInline(raw, 200).replace(/\\/g, "/");
  if (!cleaned) return "";
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length <= 2) return cleaned;
  return parts.slice(-2).join("/");
}

function locationOf(args: LspArgs | undefined): string {
  const file = shortLspPath(args?.path);
  const line = finiteInt(args?.line);
  const column = finiteInt(args?.column);
  if (file && line !== undefined && column !== undefined) {
    return `${file}:${line}:${column}`;
  }
  if (file && line !== undefined) return `${file}:${line}`;
  return file;
}

/** Compact header argument: `hover client.ts:12:3` / `read_symbol Foo`. */
export function lspReceiptArg(args: LspArgs | undefined, budget: number): string {
  const op = operationOf(args);
  const location = locationOf(args);
  const query = cleanInline(args?.query, 80);

  const extras: string[] = [];
  if (op === "references" && args?.includeDeclaration === false) {
    extras.push("no-decl");
  }
  // hover ignores limit; only operations that format lists consume it.
  if (op !== "hover") {
    const limit = finiteInt(args?.limit);
    if (limit !== undefined) extras.push(`limit ${limit}`);
  }
  if (op === "read_symbol") {
    const context = finiteInt(args?.context);
    if (context !== undefined) extras.push(`ctx ${context}`);
  }

  let subject = "";
  if (op === "workspace_symbols" || op === "read_symbol") {
    subject = [query, location].filter(Boolean).join(" ");
  } else if (op === "document_symbols" || op === "diagnostics") {
    subject = location;
  } else {
    subject = location;
  }

  const parts = [op, subject, extras.join(" ")].filter(Boolean);
  return cleanInline(parts.join(" "), Math.max(8, budget));
}

export const lspReceiptRenderers = toolRenderers<LspArgs>({
  surface: LSP_RECEIPT_TOOL,
  title: LSP_RECEIPT_TOOL,
  arg: lspReceiptArg,
  preview(output) {
    return output ? boundedOutput(output, 4, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

/** True when lsp already declared any presentation contract. */
export function lspOwnsPresentation(component: LspComponent): boolean {
  return componentOwnsPresentation(component);
}

/** Attach Apex receipts to lsp ToolExecutionComponent instances. */
export function installLspReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(LSP_RECEIPT_TOOL, lspReceiptRenderers);
  installHeadlessReceipts();
}
