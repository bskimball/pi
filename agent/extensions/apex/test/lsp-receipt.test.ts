import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";

const {
  LSP_RECEIPT_TOOL,
  installLspReceipts,
  lspOwnsPresentation,
  lspReceiptArg,
  lspReceiptRenderers,
  shortLspPath,
} = await import("../internal/presentation/lsp-receipt.ts");

const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
  inverse: (text: string) => text,
};

function context(args: any, overrides: Record<string, unknown> = {}): any {
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
    ...overrides,
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

describe("apex lsp receipts", () => {
  it("shortens long paths to the last two segments", () => {
    assert.equal(shortLspPath("agent/extensions/lsp/index.ts"), "lsp/index.ts");
    assert.equal(
      shortLspPath("C:\\Users\\bskim\\.pi\\agent\\extensions\\lsp\\index.ts"),
      "lsp/index.ts",
    );
    assert.equal(shortLspPath("index.ts"), "index.ts");
  });

  it("formats a compact header argument per operation", () => {
    assert.equal(
      lspReceiptArg(
        {
          operation: "hover",
          path: "agent/extensions/lsp/index.ts",
          line: 12,
          column: 3,
        },
        80,
      ),
      "hover lsp/index.ts:12:3",
    );
    assert.equal(
      lspReceiptArg(
        {
          operation: "references",
          path: "src/client.ts",
          line: 40,
          column: 1,
          includeDeclaration: false,
          limit: 20,
        },
        80,
      ),
      "references src/client.ts:40:1 no-decl limit 20",
    );
    assert.equal(
      lspReceiptArg(
        { operation: "workspace_symbols", query: "LspManager", path: "src/index.ts" },
        80,
      ),
      "workspace_symbols LspManager src/index.ts",
    );
    assert.equal(
      lspReceiptArg(
        {
          operation: "read_symbol",
          query: "formatHover",
          path: "agent/extensions/lsp/format.ts",
          context: 3,
        },
        80,
      ),
      "read_symbol formatHover lsp/format.ts ctx 3",
    );
    assert.equal(
      lspReceiptArg(
        {
          operation: "definition",
          path: "src/client.ts",
          line: 8,
          column: 2,
        },
        80,
      ),
      "definition src/client.ts:8:2",
    );
    assert.equal(
      lspReceiptArg(
        { operation: "document_symbols", path: "src/main.ts", limit: 40 },
        80,
      ),
      "document_symbols src/main.ts limit 40",
    );
    assert.equal(
      lspReceiptArg({ operation: "diagnostics", path: "src/main.ts" }, 80),
      "diagnostics src/main.ts",
    );
    assert.equal(
      lspReceiptArg(
        {
          operation: "hover",
          path: "src/a.ts",
          line: 4,
          column: 2,
          limit: 5,
        },
        80,
      ),
      "hover src/a.ts:4:2",
    );
  });

  it("renders an Apex receipt instead of boxed JSON args", () => {
    const args = {
      operation: "definition",
      path: "agent/extensions/lsp/index.ts",
      line: 20,
      column: 1,
    };
    const ctx = context(args);
    const call = lspReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /lsp/);
    assert.match(call, /definition lsp\/index\.ts:20:1/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"operation"/);

    const result = {
      content: [
        {
          type: "text",
          text: "1. C:\\Users\\bskim\\.pi\\agent\\extensions\\lsp\\index.ts:20:1\n2. C:\\Users\\bskim\\.pi\\agent\\extensions\\lsp\\manager.ts:10:3",
        },
      ],
    };
    const rendered = lspReceiptRenderers
      .renderResult(result, { expanded: false, isPartial: false }, theme, ctx)
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /lsp/);
    assert.match(text, /index\.ts:20:1/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("blanks the call row once the result receipt exists", () => {
    const args = { operation: "hover", path: "src/a.ts", line: 4, column: 2 };
    const ctx = context(args);
    const callComponent = lspReceiptRenderers.renderCall(args, theme, ctx);
    assert.match(callComponent.render(80).join("\n"), /hover src\/a\.ts:4:2/);

    lspReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "function foo(): void" }] },
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );
    assert.deepEqual(callComponent.render(80), []);
  });

  it("wraps lsp ToolExecutionComponent getters and leaves others alone", () => {
    withApexUi("1", () => installLspReceipts());
    const proto = ToolExecutionComponent.prototype as any;

    const lsp = {
      toolName: LSP_RECEIPT_TOOL,
      toolDefinition: { name: "lsp" },
    };
    assert.equal(lspOwnsPresentation(lsp), false);
    assert.equal(proto.getCallRenderer.call(lsp), lspReceiptRenderers.renderCall);
    assert.equal(
      proto.getResultRenderer.call(lsp),
      lspReceiptRenderers.renderResult,
    );
    assert.equal(proto.getRenderShell.call(lsp), "self");
    assert.equal(proto.hasRendererDefinition.call(lsp), true);

    const ownCall = () => ({ render: () => ["OWN-CALL"], invalidate() {} });
    const ownResult = () => ({ render: () => ["OWN-RESULT"], invalidate() {} });
    const ownedBoth = {
      toolName: LSP_RECEIPT_TOOL,
      toolDefinition: {
        name: "lsp",
        renderCall: ownCall,
        renderResult: ownResult,
      },
    };
    assert.equal(proto.getCallRenderer.call(ownedBoth), ownCall);
    assert.equal(proto.getResultRenderer.call(ownedBoth), ownResult);
    assert.equal(proto.getRenderShell.call(ownedBoth), "default");

    const ownedCallOnly = {
      toolName: LSP_RECEIPT_TOOL,
      toolDefinition: { name: "lsp", renderCall: ownCall },
    };
    assert.equal(proto.getCallRenderer.call(ownedCallOnly), ownCall);
    assert.equal(proto.getResultRenderer.call(ownedCallOnly), undefined);
    assert.equal(proto.getRenderShell.call(ownedCallOnly), "default");

    const ownedShell = {
      toolName: LSP_RECEIPT_TOOL,
      toolDefinition: { name: "lsp", renderShell: "default" },
    };
    assert.equal(lspOwnsPresentation(ownedShell), false);
    assert.equal(proto.getRenderShell.call(ownedShell), "self");

    const explicitDefaultShell = {
      toolName: LSP_RECEIPT_TOOL,
      toolDefinition: {
        name: "lsp",
        renderCall: ownCall,
        renderShell: "default",
      },
    };
    assert.equal(proto.getRenderShell.call(explicitDefaultShell), "default");

    const other = {
      toolName: "bash",
      toolDefinition: { name: "bash" },
    };
    assert.equal(proto.getCallRenderer.call(other), undefined);
    assert.equal(proto.getResultRenderer.call(other), undefined);
    assert.equal(proto.getRenderShell.call(other), "default");
  });

  it("renders a real ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => installLspReceipts());

    const args = {
      operation: "hover",
      path: "src/index.ts",
      line: 20,
      column: 1,
    };
    const component = new ToolExecutionComponent(
      "lsp",
      "call-1",
      args,
      { showImages: false },
      { name: "lsp" } as any,
      stubUi() as any,
      process.cwd(),
    );
    component.markExecutionStarted();
    component.updateResult({
      content: [
        {
          type: "text",
          text: "function LspManager(): void",
        },
      ],
      isError: false,
    });

    const lines = component.render(80);
    const text = lines.join("\n");
    assert.match(text, /lsp/);
    assert.match(text, /hover src\/index\.ts:20:1/);
    assert.match(text, /function LspManager/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.equal((text.match(/lsp/g) ?? []).length, 1);
    assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previous = process.env.PI_APEX_UI;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    try {
      installLspReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});
