// Local type surface for pi-mcp-adapter.
// The published package exports raw .ts sources that fail under this repo's
// strict tsc settings (and are not skipLibCheck-eligible). Runtime still
// resolves the real package via Node; only the type checker uses this shim.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface McpAdapterOptions {
  config?: unknown;
  configPath?: string;
}

export function createMcpAdapter(
  options?: McpAdapterOptions,
): (pi: ExtensionAPI) => void;

declare const defaultExport: (pi: ExtensionAPI) => void;
export default defaultExport;
