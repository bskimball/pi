import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  MCP_TOOL,
  compactMcpArgs,
  installMcpReceipts,
  mcpReceiptArg,
  mcpReceiptRenderers,
  mcpScriptReceiptArg,
  mcpScriptReceiptRenderers,
} from "../internal/presentation/mcp-receipt.ts";

const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
  inverse: (text: string) => text,
};

function context(args: any): any {
  return {
    args,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    invalidate() {},
  };
}

function withApexUi<T>(value: string, run: () => T): T {
  const previous = process.env.PI_APEX_UI;
  process.env.PI_APEX_UI = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.PI_APEX_UI;
    else process.env.PI_APEX_UI = previous;
  }
}

function stubUi() {
  return { requestRender() {} };
}

describe("apex mcp receipts", () => {
  it("formats compact header arguments per gateway mode", () => {
    assert.equal(mcpReceiptArg({}, 80), "status");
    assert.equal(
      mcpReceiptArg({ search: "snapshot", server: "chrome-devtools" }, 80),
      "search snapshot @ chrome-devtools",
    );
    assert.equal(
      mcpReceiptArg(
        { tool: "list_tabs", server: "chrome-devtools", args: { max: 5 } },
        80,
      ),
      'call list_tabs @ chrome-devtools {"max":5}',
    );
    assert.equal(mcpReceiptArg({ connect: "linear" }, 80), "connect linear");
    assert.equal(
      mcpReceiptArg({ describe: "chrome-devtools/list_tabs" }, 80),
      "describe chrome-devtools/list_tabs",
    );
    assert.equal(
      mcpReceiptArg({ action: "auth-start", server: "linear" }, 80),
      "auth-start linear",
    );
    assert.equal(mcpReceiptArg({ server: "chrome-devtools" }, 80), "list chrome-devtools");
  });

  it("compacts JSON-ish args without dumping multiline objects", () => {
    assert.equal(compactMcpArgs({ query: "pi" }, 80), '{"query":"pi"}');
    assert.equal(compactMcpArgs('{"query":"pi"}', 80), '{"query":"pi"}');
    assert.doesNotMatch(compactMcpArgs({ a: 1, b: 2 }, 80), /\n/);
  });

  it("formats mcpScript as the first statement plus extra line count", () => {
    assert.equal(
      mcpScriptReceiptArg({ code: "emit(await tools.search({ query: \"tabs\" }))" }, 80),
      'emit(await tools.search({ query: "tabs" }))',
    );
    assert.equal(
      mcpScriptReceiptArg(
        { code: "const a = 1;\nemit(a);", timeoutMs: 5000 },
        80,
      ),
      "const a = 1; +1 line 5000ms",
    );
  });

  it("renders an Apex receipt instead of boxed JSON args", () => {
    const args = { search: "snapshot" };
    const ctx = context(args);
    const call = mcpReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /mcp/);
    assert.match(call, /search snapshot/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"search"/);

    const rendered = mcpReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "1. chrome-devtools/take_snapshot" }],
          details: { mode: "search" },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /mcp/);
    assert.match(text, /search/);
    assert.match(text, /take_snapshot/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("overrides adapter-owned mcp presentation when Apex is on", () => {
    withApexUi("1", () => {
      installMcpReceipts();
      const proto = ToolExecutionComponent.prototype as any;
      const owned = {
        toolName: MCP_TOOL,
        toolDefinition: {
          name: MCP_TOOL,
          renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderResult: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderShell: "self",
        },
      };
      assert.equal(
        proto.getCallRenderer.call(owned),
        mcpReceiptRenderers.renderCall,
      );
      assert.equal(
        proto.getResultRenderer.call(owned),
        mcpReceiptRenderers.renderResult,
      );
      assert.equal(proto.getRenderShell.call(owned), "self");
    });
  });

  it("renders a real mcp ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installMcpReceipts();

      const args = { tool: "list_pages", server: "chrome-devtools" };
      const component = new ToolExecutionComponent(
        MCP_TOOL,
        "call-1",
        args,
        { showImages: false },
        {
          name: MCP_TOOL,
          renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderResult: () => ({ render: () => ["OWN"], invalidate() {} }),
        } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: "pages: Example" }],
        details: { mode: "call", server: "chrome-devtools", tool: "list_pages" },
        isError: false,
      });

      const lines = component.render(80);
      const text = lines.join("\n");
      assert.match(text, /mcp/);
      assert.match(text, /list_pages/);
      assert.match(text, /pages: Example/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.doesNotMatch(text, /^OWN$/m);
      assert.match(text, /mcp/);
      assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("renders mcpScript as an Apex receipt", () => {
    const args = { code: "emit(1)" };
    const ctx = context(args);
    const call = mcpScriptReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /mcpScript/);
    assert.match(call, /emit\(1\)/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previous = process.env.PI_APEX_UI;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    try {
      installMcpReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});
