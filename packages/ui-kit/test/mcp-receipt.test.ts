import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSharedPresentation, resetUiKitInstallForTests } from "../install.ts";
import { shouldAttachApexReceipts } from "@pi/ui-kit/internal/presentation/headless-receipts.ts";

// Native MCP owns its renderers. Installing any custom skin must leave them,
// codemode, and tool discovery untouched while other kit receipts remain active.
describe("native MCP rendering", () => {
  it("does not attach adapter receipts after shared presentation installation", () => {
    const previousChrome = process.env.PI_UI_CHROME;
    const previousApex = process.env.PI_APEX_UI;
    process.env.PI_UI_CHROME = "1";
    process.env.PI_APEX_UI = "1";
    resetUiKitInstallForTests();
    try {
      const pi = { registerMessageRenderer() {} } as unknown as ExtensionAPI;
      installSharedPresentation(pi);
      for (const toolName of [
        "mcp__chrome-devtools__list_pages",
        "mcp__context7__resolve-library-id",
        "codemode",
        "tool_search",
        "list_mcp_resources",
        "read_mcp_resource",
        "mcp",
        "mcpScript",
      ]) {
        assert.equal(shouldAttachApexReceipts({ toolName }), undefined, toolName);
        assert.equal(
          shouldAttachApexReceipts({
            toolName,
            toolDefinition: { renderCall() {}, renderResult() {} },
          }),
          undefined,
          `${toolName} must preserve its owner renderer`,
        );
      }
      assert.ok(shouldAttachApexReceipts({ toolName: "web_search" }));
      assert.ok(shouldAttachApexReceipts({ toolName: "memory_list" }));
    } finally {
      resetUiKitInstallForTests();
      if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
      else process.env.PI_UI_CHROME = previousChrome;
      if (previousApex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previousApex;
    }
  });
});
