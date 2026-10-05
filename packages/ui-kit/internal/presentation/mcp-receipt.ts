// mcp-receipt: kit chrome for Pi's native MCP tools.
//
// Pi's MCP extension owns execute. Per-server `mcp__<server>__<tool>` proxies
// carry Pi owner renderers; the three resource tools (`list_mcp_resources`,
// `list_mcp_resource_templates`, `read_mcp_resource`) have none (stock Pi
// fallback). All attach here through the shared headless wrap; the `mcp__`
// prefix factory opts into overrideOwned so long server/tool names and raw
// JSON args become compact `server/tool key=value` headers.
//
// renderResult receives only `{content, details}` (Pi strips
// structuredContent before rendering), so the list tools parse the JSON text
// payload. Inline images still render below the receipt: Pi's
// ToolExecutionComponent appends image blocks independently of renderShell.
//
// PI_UI_CHROME=0 skips the wrap and Pi's own presentation shows through.
// Preview hooks cannot color (their lines pass through cleanInline), so no
// ANSI is produced here.

import { apexPresentationEnabled } from "./presentation.ts";
import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";
import {
  registerHeadlessReceipt,
  registerHeadlessReceiptPrefix,
  type HeadlessRenderers,
} from "./headless-receipts.ts";

/** Prefix of Pi's per-server MCP proxy tools (`mcp__<server>__<tool>`). */
export const MCP_PROXY_PREFIX = "mcp__";
export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

/** Identifying args shown first in the compact header, in this order. */
const PREFERRED_ARG_KEYS = [
  "url",
  "uri",
  "query",
  "libraryName",
  "libraryId",
  "selector",
  "uid",
  "pageId",
  "path",
  "name",
];

function detailsOf(result: any): Record<string, unknown> {
  return result?.details && typeof result.details === "object"
    ? (result.details as Record<string, unknown>)
    : {};
}

function imageMimes(result: any): string[] {
  if (!Array.isArray(result?.content)) return [];
  return result.content
    .filter((item: any) => item?.type === "image")
    .map((item: any) =>
      typeof item.mimeType === "string" && item.mimeType
        ? item.mimeType
        : "image",
    )
    .slice(0, 12);
}

/** Split `mcp__server__tool` (tolerates missing/suffixed segments). */
export function parseMcpProxyName(toolName: string): {
  server: string;
  tool: string;
} {
  const rest = toolName.startsWith(MCP_PROXY_PREFIX)
    ? toolName.slice(MCP_PROXY_PREFIX.length)
    : toolName;
  const split = rest.indexOf("__");
  if (split <= 0) return { server: cleanInline(rest, 60), tool: "" };
  return {
    server: cleanInline(rest.slice(0, split), 60),
    tool: cleanInline(rest.slice(split + 2), 80),
  };
}

/** `server/tool` from result details when present, else from the tool name. */
export function mcpProxyTitle(
  toolName: string,
  details?: Record<string, unknown>,
): string {
  const server =
    typeof details?.server === "string" && details.server
      ? cleanInline(details.server, 60)
      : "";
  const tool =
    typeof details?.tool === "string" && details.tool
      ? cleanInline(details.tool, 80)
      : "";
  if (server && tool) return `${server}/${tool}`;
  const parsed = parseMcpProxyName(toolName);
  if (parsed.server && parsed.tool) return `${parsed.server}/${parsed.tool}`;
  return parsed.server || toolName;
}

function formatArgValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return cleanInline(value, 120) || undefined;
  if (typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return `{${keys.length} key${keys.length === 1 ? "" : "s"}}`;
  }
  return undefined;
}

/**
 * Compact `key=value` args: identifying keys first, strings unquoted,
 * objects/arrays summarized. Never a raw JSON dump.
 */
export function compactMcpProxyArgs(
  args: Record<string, unknown> | undefined,
  budget: number,
): string {
  const cap = Math.max(8, budget);
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const entries = Object.entries(args);
  if (!entries.length) return "";
  const rank = (key: string): number => {
    const index = PREFERRED_ARG_KEYS.indexOf(key);
    return index === -1 ? PREFERRED_ARG_KEYS.length + 1 : index;
  };
  const ordered = [...entries]
    .sort(([a], [b]) => rank(a) - rank(b))
    .slice(0, 8);
  const parts: string[] = [];
  for (const [key, value] of ordered) {
    const shown = formatArgValue(value);
    if (shown === undefined) continue;
    parts.push(`${cleanInline(key, 40)}=${shown}`);
  }
  return cleanInline(parts.join(" "), cap);
}

/** Build the renderers for one `mcp__<server>__<tool>` proxy tool. */
export function mcpProxyRenderers(toolName: string): HeadlessRenderers {
  const parsed = parseMcpProxyName(toolName);
  const surface = parsed.server
    ? `mcp:${parsed.server}/${parsed.tool || "*"}`
    : "mcp";
  return toolRenderers<Record<string, unknown>>({
    surface,
    title: (_args, details) => mcpProxyTitle(toolName, details),
    arg: (args, budget) => compactMcpProxyArgs(args, budget),
    stats(result) {
      const parts: string[] = [];
      const images = imageMimes(result);
      if (images.length) {
        parts.push(`${images.length} image${images.length === 1 ? "" : "s"}`);
      }
      if (typeof detailsOf(result).fullOutputPath === "string") {
        parts.push("truncated");
      }
      return parts.join(" · ");
    },
    preview(output, result) {
      if (output) return boundedOutput(output, 4, 1200);
      return imageMimes(result).map((mime) => `[${cleanInline(mime, 60)}]`);
    },
    body(output, result) {
      const lines = output ? boundedOutput(output, 72) : [];
      if (!output) {
        const images = imageMimes(result);
        if (images.length) lines.push(...images.map((mime) => `[${cleanInline(mime, 60)}]`));
      }
      const path = detailsOf(result).fullOutputPath;
      if (typeof path === "string" && path) {
        lines.push(`full output: ${cleanInline(path, 200)}`);
      }
      return lines.length ? boundedOutput(lines.join("\n"), 80) : [];
    },
    expandWhen: (result) =>
      typeof detailsOf(result).fullOutputPath === "string" ||
      imageMimes(result).length > 0,
  });
}

type McpResourceItem = {
  name?: unknown;
  uri?: unknown;
  uriTemplate?: unknown;
};

function parseListingPayload(output: string): Record<string, unknown> | undefined {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(0, 12_000));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the raw-text preview below.
  }
  return undefined;
}

function listingItems(
  payload: Record<string, unknown> | undefined,
  key: "resources" | "resourceTemplates",
): McpResourceItem[] {
  const items = payload?.[key];
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is McpResourceItem => !!item && typeof item === "object")
    .slice(0, 100);
}

function listingErrors(payload: Record<string, unknown> | undefined): string[] {
  const errors = payload?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .slice(0, 10)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const record = entry as Record<string, unknown>;
      const server = cleanInline(record.server, 40);
      const error = cleanInline(record.error, 120);
      return [server, error].filter(Boolean).join(": ") || "";
    })
    .filter(Boolean);
}

function itemLine(item: McpResourceItem): string {
  const name = cleanInline(item.name, 60);
  const uri = cleanInline(item.uri ?? item.uriTemplate, 160);
  return [name || "resource", uri].filter(Boolean).join(" ");
}

function serverArg(
  args: { server?: unknown } | undefined,
  budget: number,
): string {
  const server = typeof args?.server === "string" ? cleanInline(args.server, 60) : "";
  return cleanInline(server || "all", Math.max(8, budget));
}

function listingStats(
  output: string,
  key: "resources" | "resourceTemplates",
  noun: string,
): string {
  const payload = parseListingPayload(output);
  if (!payload) return "";
  const parts = [`${listingItems(payload, key).length} ${noun}`];
  const errors = listingErrors(payload).length;
  if (errors) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function listingPreview(
  output: string,
  key: "resources" | "resourceTemplates",
): string[] {
  const payload = parseListingPayload(output);
  if (!payload) return output ? boundedOutput(output, 4, 1200) : [];
  return listingItems(payload, key).slice(0, 4).map(itemLine);
}

function listingBody(
  output: string,
  key: "resources" | "resourceTemplates",
): string[] {
  const payload = parseListingPayload(output);
  if (!payload) return output ? boundedOutput(output, 80) : [];
  const lines = listingItems(payload, key).map(itemLine);
  for (const error of listingErrors(payload)) lines.push(`error: ${error}`);
  const cursor = payload.nextCursor;
  if (typeof cursor === "string" && cursor) {
    lines.push(`next page: ${cleanInline(cursor, 80)}`);
  }
  return lines.length ? boundedOutput(lines.join("\n"), 80) : [];
}

export const listMcpResourcesRenderers = toolRenderers<{ server?: unknown }>({
  surface: LIST_MCP_RESOURCES_TOOL,
  title: LIST_MCP_RESOURCES_TOOL,
  arg: serverArg,
  stats: (result) => listingStats(resultText(result), "resources", "resources"),
  preview: (output) => listingPreview(output, "resources"),
  body: (output) => listingBody(output, "resources"),
});

export const listMcpResourceTemplatesRenderers = toolRenderers<{
  server?: unknown;
}>({
  surface: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
  title: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
  arg: serverArg,
  stats: (result) => listingStats(resultText(result), "resourceTemplates", "templates"),
  preview: (output) => listingPreview(output, "resourceTemplates"),
  body: (output) => listingBody(output, "resourceTemplates"),
});

/** Text intake for listings: stats hooks receive the result, not the output. */
function resultText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text ?? ""))
    .join("\n")
    .slice(0, 12_000);
}

export const readMcpResourceRenderers = toolRenderers<{
  server?: unknown;
  uri?: unknown;
}>({
  surface: READ_MCP_RESOURCE_TOOL,
  title: READ_MCP_RESOURCE_TOOL,
  arg(args, budget) {
    const cap = Math.max(8, budget);
    const server = typeof args?.server === "string" ? cleanInline(args.server, 40) : "";
    const uri = typeof args?.uri === "string" ? cleanInline(args.uri, 160) : "";
    return cleanInline([server, uri].filter(Boolean).join(" ") || "resource", cap);
  },
  stats(result) {
    const parts: string[] = [];
    const images = imageMimes(result);
    if (images.length) {
      parts.push(`${images.length} image${images.length === 1 ? "" : "s"}`);
    }
    if (typeof detailsOf(result).fullOutputPath === "string") {
      parts.push("truncated");
    }
    return parts.join(" · ");
  },
  preview(output, result) {
    if (output) return boundedOutput(output, 4, 1200);
    return imageMimes(result).map((mime) => `[${cleanInline(mime, 60)}]`);
  },
});

/** Attach kit receipts to `mcp__*` proxies (replacing owner chrome) and resource tools. */
export function installMcpReceipts(): void {
  if (!apexPresentationEnabled()) return;
  registerHeadlessReceiptPrefix(MCP_PROXY_PREFIX, mcpProxyRenderers, {
    overrideOwned: true,
  });
  registerHeadlessReceipt(LIST_MCP_RESOURCES_TOOL, listMcpResourcesRenderers);
  registerHeadlessReceipt(
    LIST_MCP_RESOURCE_TEMPLATES_TOOL,
    listMcpResourceTemplatesRenderers,
  );
  registerHeadlessReceipt(READ_MCP_RESOURCE_TOOL, readMcpResourceRenderers);
}
