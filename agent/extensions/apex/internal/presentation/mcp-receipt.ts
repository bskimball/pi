// mcp-receipt: Apex chrome for the headless mcp gateway tools.
//
// mcp-adapter.ts / pi-mcp-adapter own execute and register their own
// renderCall/renderResult. Apex cannot import that extension. This replaces
// adapter presentation with compact Apex receipts via the shared headless wrap
// when Apex presentation is enabled.
//
// PI_APEX_UI=0 skips the wrap or falls back dynamically, leaving the adapter's
// own presentation intact. Direct/namespace MCP tools keep adapter chrome.

import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
} from "./headless-receipts.ts";

export const MCP_TOOL = "mcp";
export const MCP_SCRIPT_TOOL = "mcpScript";

type McpArgs = {
  tool?: string;
  args?: string | Record<string, unknown>;
  connect?: string;
  describe?: string;
  instructions?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  limit?: number;
  offset?: number;
  server?: string;
  action?: string;
};

type McpScriptArgs = {
  code?: string;
  timeoutMs?: number;
};

function detailsOf(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Compact JSON-ish args for a header; never a multi-line dump. */
export function compactMcpArgs(value: unknown, max: number): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return cleanInline(JSON.stringify(JSON.parse(trimmed)), max);
      } catch {
        return cleanInline(value, max);
      }
    }
    return cleanInline(value, max);
  }
  if (typeof value === "object") {
    try {
      return cleanInline(JSON.stringify(value), max);
    } catch {
      return "";
    }
  }
  return cleanInline(value, max);
}

/**
 * Compact header: `call list_tabs @ chrome-devtools {...}` /
 * `search snapshot` / `status`.
 */
export function mcpReceiptArg(args: McpArgs | undefined, budget: number): string {
  const cap = Math.max(8, budget);
  if (args?.tool) {
    const target = args.server
      ? `${cleanInline(args.tool, 80)} @ ${cleanInline(args.server, 40)}`
      : cleanInline(args.tool, 80);
    const payload = compactMcpArgs(args.args, 80);
    return cleanInline(
      ["call", target, payload].filter(Boolean).join(" "),
      cap,
    );
  }
  if (args?.connect) {
    return cleanInline(`connect ${args.connect}`, cap);
  }
  if (args?.describe) {
    return cleanInline(`describe ${args.describe}`, cap);
  }
  if (args?.instructions) {
    return cleanInline(`instructions ${args.instructions}`, cap);
  }
  if (args?.search) {
    const extras: string[] = [];
    if (args.server) extras.push(`@ ${cleanInline(args.server, 40)}`);
    if (args.regex === true) extras.push("regex");
    if (args.includeSchemas === false) extras.push("no-schema");
    const limit = finiteNumber(args.limit);
    if (limit !== undefined) extras.push(`${limit}`);
    return cleanInline(
      ["search", args.search, extras.join(" ")].filter(Boolean).join(" "),
      cap,
    );
  }
  if (args?.action) {
    const server = cleanInline(args.server, 40);
    return cleanInline(
      [args.action, server].filter(Boolean).join(" "),
      cap,
    );
  }
  if (args?.server) {
    return cleanInline(`list ${args.server}`, cap);
  }
  return "status";
}

/** Compact header: first statement of the script, optional `+N lines`. */
export function mcpScriptReceiptArg(
  args: McpScriptArgs | undefined,
  budget: number,
): string {
  const lines = String(args?.code ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const extra = Math.max(0, lines.length - 1);
  const extras: string[] = [];
  if (extra > 0) extras.push(`+${extra} ${extra === 1 ? "line" : "lines"}`);
  const timeout = finiteNumber(args?.timeoutMs);
  if (timeout !== undefined) extras.push(`${timeout}ms`);
  return cleanInline(
    [lines[0] || "script", extras.join(" ")].filter(Boolean).join(" "),
    Math.max(8, budget),
  );
}

export const mcpReceiptRenderers = toolRenderers<McpArgs>({
  surface: MCP_TOOL,
  title: MCP_TOOL,
  arg: mcpReceiptArg,
  stats(result) {
    const details = detailsOf(result);
    const parts: string[] = [];
    const mode = cleanInline(details.mode, 24);
    if (mode && mode !== "call") parts.push(mode);
    const server = cleanInline(details.server ?? details.hintServer, 32);
    const tool = cleanInline(details.tool ?? details.requestedTool, 40);
    if (server && tool) parts.push(`${server}/${tool}`);
    else if (server) parts.push(server);
    else if (tool) parts.push(tool);
    if (details.error) parts.push("error");
    return parts.join(" · ");
  },
  preview(output) {
    return output ? boundedOutput(output, 4, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

export const mcpScriptReceiptRenderers = toolRenderers<McpScriptArgs>({
  surface: MCP_SCRIPT_TOOL,
  title: MCP_SCRIPT_TOOL,
  arg: mcpScriptReceiptArg,
  stats(result) {
    const details = detailsOf(result);
    const parts: string[] = [];
    if (details.error) parts.push(cleanInline(details.error, 24) || "error");
    return parts.join(" · ");
  },
  preview(output) {
    return output ? boundedOutput(output, 4, 1200) : [];
  },
  body(output) {
    return output ? boundedOutput(output, 80) : [];
  },
});

/** Attach Apex receipts to mcp and mcpScript, overriding adapter chrome. */
export function installMcpReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(MCP_TOOL, mcpReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(MCP_SCRIPT_TOOL, mcpScriptReceiptRenderers, {
    overrideOwned: true,
  });
  installHeadlessReceipts();
}
