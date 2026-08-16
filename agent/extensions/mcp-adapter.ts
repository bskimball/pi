// Standalone local MCP adapter. MCP tools use Pi's stock rendering.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";

export default function mcpAdapterExtension(pi: ExtensionAPI): void {
  createMcpAdapter()(pi);
}
