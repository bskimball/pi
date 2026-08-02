// Local MCP adapter entry: install Apex MCP presentation on this extension's
// ExtensionAPI, then boot pi-mcp-adapter on the same instance so registerTool
// wraps proxy/direct tools with stable Apex renderers.
//
// Pi gives each extension its own ExtensionAPI/tool map. Wrapping Apex UI's
// API cannot intercept tools registered by the npm package, so presentation
// and adapter must share this file's `pi`.
//
// Presentation is imported from apex/lib (not apex-ui.ts) so this entry does
// not load apex-ui's default-export side-effect graph.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";
import { installMcpPresentation } from "./apex/lib/mcp-presentation.ts";

export default function mcpAdapterExtension(pi: ExtensionAPI): void {
  installMcpPresentation(pi);
  createMcpAdapter()(pi);
}
