// mcp-receipt: Apex chrome for the headless mcp gateway tools.
//
// mcp-adapter.ts / pi-mcp-adapter own execute and register their own
// renderCall/renderResult. Apex cannot import that extension. This replaces
// adapter presentation with compact Apex receipts via the shared headless wrap
// when Apex presentation is enabled. Covers the `mcp`/`mcpScript` gateway
// tools by exact name plus per-server `mcp__<server>` namespace proxies by
// prefix.
//
// PI_APEX_UI=0 skips the wrap or falls back dynamically, leaving the adapter's
// own presentation intact. Direct `<server>_<tool>` passthrough tools match no
// name rule and keep adapter chrome.

import { boundedOutput, toolRenderers, type ToolSpec } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  installHeadlessReceipts,
  registerHeadlessReceipt,
  registerHeadlessReceiptPrefix,
  type HeadlessRenderers,
} from "./headless-receipts.ts";

export const MCP_TOOL = "mcp";
export const MCP_SCRIPT_TOOL = "mcpScript";
/** Prefix of the adapter's per-server namespace-proxy tools (`mcp__<server>`). */
export const MCP_PROXY_PREFIX = "mcp__";
/** Sentinel the adapter appends before an input-schema dump on tool errors. */
export const MCP_SCHEMA_SENTINEL = "Expected parameters:";
/** Cap for the split-out schema section so a fat schema cannot blow out the receipt. */
const MCP_SCHEMA_BODY_LINES = 24;

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

/** Split adapter error text into message + `Expected parameters:` schema dump. */
function splitMcpSchema(output: string): { message: string; schema: string } {
  const index = output.indexOf(MCP_SCHEMA_SENTINEL);
  if (index === -1) return { message: output, schema: "" };
  return {
    message: output.slice(0, index).replace(/\s+$/, ""),
    schema: output.slice(index + MCP_SCHEMA_SENTINEL.length).replace(/^\s+/, ""),
  };
}

/** Prefer an explicit args server; proxies carry the server in the tool name. */
function withFallbackServer(
  args: McpArgs | undefined,
  fallback: string | undefined,
): McpArgs | undefined {
  if (!fallback || args?.server) return args;
  return { ...args, server: fallback };
}

export const mcpReceiptRenderers = toolRenderers<McpArgs>(mcpReceiptSpec());

/**
 * One receipt family for gateway and proxies. `fallbackServer` fills the
 * `@ <server>` header slot when args carry no explicit server — the
 * namespace-proxy case, where the server is baked into the tool name.
 */
function mcpReceiptSpec(fallbackServer?: string): ToolSpec<McpArgs> {
  return {
    surface: MCP_TOOL,
    title: MCP_TOOL,
    arg: (args, budget) =>
      mcpReceiptArg(withFallbackServer(args, fallbackServer), budget),
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
      if (!output) return [];
      const { message, schema } = splitMcpSchema(output);
      return boundedOutput(schema ? message : output, 4, 1200);
    },
    body(output) {
      if (!output) return [];
      const { message, schema } = splitMcpSchema(output);
      if (!schema) return boundedOutput(output, 80);
      const lines = message ? boundedOutput(message, 80) : [];
      return [
        lines,
        [MCP_SCHEMA_SENTINEL],
        boundedOutput(schema, MCP_SCHEMA_BODY_LINES),
      ].flat();
    },
    // Budget: message (80+1) + label (1) + schema (24+1) lines max.
    bodyLines: 107,
  };
}

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

const proxyRendererCache = new Map<string, HeadlessRenderers>();

/**
 * Per-proxy renderers: the server lives in the tool name (`mcp__<server>`),
 * not in the args, so each proxy gets a spec with its name-derived server as
 * the header fallback. Memoized per tool name for stable renderer identity.
 * Result stats still prefer the exact `details.server` when the adapter
 * provides one; the fallback only ever fills the call header.
 */
function mcpProxyRenderers(toolName: string): HeadlessRenderers {
  const cached = proxyRendererCache.get(toolName);
  if (cached) return cached;
  const server =
    cleanInline(toolName.slice(MCP_PROXY_PREFIX.length), 40) || undefined;
  const built = toolRenderers<McpArgs>(mcpReceiptSpec(server));
  proxyRendererCache.set(toolName, built);
  return built;
}

/** Attach Apex receipts to mcp, mcpScript, and per-server namespace proxies. */
export function installMcpReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceipt(MCP_TOOL, mcpReceiptRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(MCP_SCRIPT_TOOL, mcpScriptReceiptRenderers, {
    overrideOwned: true,
  });
  // Exact keys are consulted first, so this never shadows "mcp"/"mcpScript"
  // (neither starts with "mcp__"). Direct `<server>_<tool>` passthrough
  // tools match no name rule and keep adapter chrome.
  registerHeadlessReceiptPrefix(MCP_PROXY_PREFIX, mcpProxyRenderers, {
    overrideOwned: true,
  });
  installHeadlessReceipts();
}
