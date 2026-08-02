// mcp-presentation: Apex receipt chrome for MCP proxy/direct tools.
//
// Installed on the *same* ExtensionAPI as pi-mcp-adapter (see
// agent/extensions/mcp-adapter.ts). Lives in apex/lib so the adapter entry
// does not load apex-ui's default-export side-effect graph.

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { cleanInline, type ToolRenderContext } from "./ui-common.ts";
import {
  toolRenderers,
  type ToolRenderState,
} from "./tool-receipt.ts";

/** Whether a registered tool is the MCP proxy or an MCP-adapter direct tool. */
export function isMcpToolDefinition(
  def: ToolDefinition<any, any, any>,
): boolean {
  if (def.name === "mcp") return true;
  if (typeof def.label === "string" && def.label.startsWith("MCP:"))
    return true;
  if (def.name.startsWith("mcp__") || def.name.startsWith("mcp_")) return true;
  return false;
}

/** Compact one-line summary of MCP args; never dumps full JSON on the header. */
export function formatMcpArgSummary(value: unknown, max = 120): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return formatMcpArgSummary(JSON.parse(trimmed), max);
    } catch {
      return cleanInline(trimmed, max);
    }
  }
  if (typeof value !== "object") return cleanInline(value, max);
  if (Array.isArray(value)) return cleanInline(`[${value.length}]`, max);

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key]) => key !== "server" && key !== "tool" && key !== "connect",
  );
  if (!entries.length) return "";

  // Prefer nested call args when the proxy tool wraps them under `args`.
  const nestedArgs = (value as Record<string, unknown>).args;
  if (
    nestedArgs !== undefined &&
    (typeof nestedArgs === "object" || typeof nestedArgs === "string")
  ) {
    const nested = formatMcpArgSummary(nestedArgs, max);
    if (nested) return nested;
  }

  const parts: string[] = [];
  for (const [key, raw] of entries.slice(0, 3)) {
    if (key === "args") continue;
    if (Array.isArray(raw)) {
      parts.push(`${key}[${raw.length}]`);
    } else if (raw && typeof raw === "object") {
      parts.push(`${key}={…}`);
    } else if (typeof raw === "string") {
      parts.push(`${key}=${cleanInline(raw, 28)}`);
    } else if (raw !== undefined) {
      parts.push(`${key}=${cleanInline(raw, 24)}`);
    }
  }
  if (entries.length > 3) parts.push("…");
  return cleanInline(parts.join(", "), max);
}

/** Prefer `mcp server/tool` identity; fall back to the registered name. */
export function mcpToolTitle(
  def: ToolDefinition<any, any, any>,
  args: any,
  details?: Record<string, unknown>,
): string {
  const detailServer =
    typeof details?.server === "string"
      ? details.server
      : typeof details?.hintServer === "string"
        ? details.hintServer
        : undefined;
  const detailTool =
    typeof details?.tool === "string"
      ? details.tool
      : typeof details?.requestedTool === "string"
        ? details.requestedTool
        : typeof details?.resourceUri === "string"
          ? `resource ${details.resourceUri}`
          : undefined;
  if (detailServer && detailTool) return `mcp ${detailServer}/${detailTool}`;

  if (def.name === "mcp") {
    if (typeof args?.action === "string" && args.action) {
      return `mcp ${args.action}`;
    }
    if (typeof args?.connect === "string" && args.connect) {
      return `mcp connect ${args.connect}`;
    }
    if (typeof args?.describe === "string" && args.describe) {
      return `mcp describe ${args.describe}`;
    }
    if (typeof args?.search === "string" && args.search) {
      return `mcp search`;
    }
    if (typeof args?.tool === "string" && args.tool) {
      return typeof args.server === "string" && args.server
        ? `mcp ${args.server}/${args.tool}`
        : `mcp ${args.tool}`;
    }
    if (typeof args?.server === "string" && args.server) {
      return `mcp ${args.server}`;
    }
    return "mcp";
  }

  // Direct tools are usually `{server}_{tool}` with server hyphens → underscores.
  const knownServers = ["chrome-devtools", "context7"];
  for (const server of knownServers) {
    const prefix = `${server.replace(/-/g, "_")}_`;
    if (def.name.startsWith(prefix)) {
      return `mcp ${server}/${def.name.slice(prefix.length)}`;
    }
  }

  if (typeof def.label === "string" && def.label.startsWith("MCP:")) {
    const original = def.label.slice(4).trim();
    if (original) return `mcp ${original}`;
  }

  if (def.name.startsWith("mcp__")) {
    const rest = def.name.slice("mcp__".length);
    const split = rest.indexOf("_");
    if (split > 0) {
      return `mcp ${rest.slice(0, split).replace(/_/g, "-")}/${rest.slice(split + 1)}`;
    }
  }

  const generic = def.name.match(/^([a-z0-9]+(?:_[a-z0-9]+)*)_(.+)$/i);
  if (generic) {
    return `mcp ${generic[1].replace(/_/g, "-")}/${generic[2]}`;
  }

  return `mcp ${def.name}`;
}

function wrapMcpTool(
  def: ToolDefinition<any, any, any>,
): ToolDefinition<any, any, any> {
  const ui = toolRenderers<any>({
    surface: "mcp",
    title: (args, details) => mcpToolTitle(def, args, details),
    arg: (args, budget) => formatMcpArgSummary(args, budget),
    // Default preview/body: engine bounds the textContent body.
    preview: (output) =>
      output
        .split(/\r?\n/)
        .map((line) => line)
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
 * Monkey-patch `pi.registerTool` so MCP proxy/direct tools get Apex's stable
 * renderer. Must run on the *same* ExtensionAPI instance that `pi-mcp-adapter`
 * uses — each Pi extension gets its own API/tool map, so calling this from
 * apex-ui itself cannot intercept tools registered by another extension.
 *
 * Prefer `agent/extensions/mcp-adapter.ts`, which installs this wrapper then
 * boots the adapter on that API.
 */
export function installMcpPresentation(pi: ExtensionAPI): void {
  const originalRegisterTool = pi.registerTool.bind(pi);
  (pi as ExtensionAPI & {
    registerTool: typeof pi.registerTool;
  }).registerTool = ((def: ToolDefinition<any, any, any>) => {
    // Built-ins already use apex renderers (`renderShell: "self"`). Only restyle
    // MCP proxy/direct tools that still ship the package's Text-based chrome.
    if (isMcpToolDefinition(def) && def.renderShell !== "self") {
      return originalRegisterTool(wrapMcpTool(def));
    }
    return originalRegisterTool(def);
  }) as typeof pi.registerTool;
}
