// Standalone local MCP adapter. Execute lives here; Apex skins mcp/mcpScript
// receipts when PI_APEX_UI is on. Direct/namespace MCP tools keep adapter chrome.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";

export default function mcpAdapterExtension(pi: ExtensionAPI): void {
  createMcpAdapter()(pi);
}
