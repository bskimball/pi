import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";

const {
  GRAPHIFY_RECEIPT_TOOL,
  graphifyOwnsPresentation,
  graphifyReceiptArg,
  graphifyReceiptRenderers,
  installGraphifyReceipts,
} = await import("../internal/presentation/graphify-receipt.ts");

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

describe("apex graphify receipts", () => {
  it("formats a compact header argument per operation", () => {
    assert.equal(
      graphifyReceiptArg(
        {
          operation: "query",
          question: "How does auth work?",
          mode: "dfs",
          scope: "runtime",
          budget: 1500,
        },
        80,
      ),
      "query How does auth work? dfs runtime 1500",
    );
    assert.equal(
      graphifyReceiptArg(
        {
          operation: "path",
          from: "AuthModule",
          to: "Database",
          scope: "runtime",
          budget: 1500,
        },
        80,
      ),
      "path AuthModule -> Database",
    );
    assert.equal(
      graphifyReceiptArg({ operation: "explain", concept: "SwinTransformer" }, 80),
      "explain SwinTransformer",
    );
  });

  it("renders an Apex receipt instead of boxed JSON args", () => {
    const args = { operation: "query", question: "How does auth work?" };
    const ctx = context(args);
    const call = graphifyReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /graphify/);
    assert.match(call, /query How does auth work\?/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"operation"/);

    const result = {
      content: [
        {
          type: "text",
          text: "AuthModule talks to Database via SessionStore.\nSecond line of answer.",
        },
      ],
    };
    const rendered = graphifyReceiptRenderers
      .renderResult(result, { expanded: false, isPartial: false }, theme, ctx)
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /graphify/);
    assert.match(text, /AuthModule talks to Database/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("blanks the call row once the result receipt exists", () => {
    const args = { operation: "explain", concept: "AuthModule" };
    const ctx = context(args);
    const callComponent = graphifyReceiptRenderers.renderCall(args, theme, ctx);
    assert.match(callComponent.render(80).join("\n"), /explain AuthModule/);

    graphifyReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "AuthModule owns session cookies." }] },
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );
    assert.deepEqual(callComponent.render(80), []);
  });

  it("wraps graphify ToolExecutionComponent getters and leaves others alone", () => {
    withApexUi("1", () => {
      installGraphifyReceipts();
    const proto = ToolExecutionComponent.prototype as any;

    const graphify = {
      toolName: GRAPHIFY_RECEIPT_TOOL,
      toolDefinition: { name: "graphify" },
    };
    assert.equal(graphifyOwnsPresentation(graphify), false);
    assert.equal(proto.getCallRenderer.call(graphify), graphifyReceiptRenderers.renderCall);
    assert.equal(
      proto.getResultRenderer.call(graphify),
      graphifyReceiptRenderers.renderResult,
    );
    assert.equal(proto.getRenderShell.call(graphify), "self");
    assert.equal(proto.hasRendererDefinition.call(graphify), true);

    const ownCall = () => ({ render: () => ["OWN-CALL"], invalidate() {} });
    const ownResult = () => ({ render: () => ["OWN-RESULT"], invalidate() {} });
    const ownedBoth = {
      toolName: GRAPHIFY_RECEIPT_TOOL,
      toolDefinition: {
        name: "graphify",
        renderCall: ownCall,
        renderResult: ownResult,
      },
    };
    assert.equal(proto.getCallRenderer.call(ownedBoth), ownCall);
    assert.equal(proto.getResultRenderer.call(ownedBoth), ownResult);
    assert.equal(proto.getRenderShell.call(ownedBoth), "default");

    const ownedCallOnly = {
      toolName: GRAPHIFY_RECEIPT_TOOL,
      toolDefinition: { name: "graphify", renderCall: ownCall },
    };
    assert.equal(proto.getCallRenderer.call(ownedCallOnly), ownCall);
    assert.equal(proto.getResultRenderer.call(ownedCallOnly), undefined);
    assert.equal(proto.getRenderShell.call(ownedCallOnly), "default");

    const ownedShell = {
      toolName: GRAPHIFY_RECEIPT_TOOL,
      toolDefinition: { name: "graphify", renderShell: "default" },
    };
    assert.equal(graphifyOwnsPresentation(ownedShell), false);
    assert.equal(proto.getRenderShell.call(ownedShell), "self");

    const explicitDefaultShell = {
      toolName: GRAPHIFY_RECEIPT_TOOL,
      toolDefinition: {
        name: "graphify",
        renderCall: ownCall,
        renderShell: "default",
      },
    };
    assert.equal(proto.getRenderShell.call(explicitDefaultShell), "default");

    const other = {
      toolName: "bg_start",
      toolDefinition: { name: "bg_start" },
    };
    assert.equal(proto.getCallRenderer.call(other), undefined);
    assert.equal(proto.getResultRenderer.call(other), undefined);
    assert.equal(proto.getRenderShell.call(other), "default");
    });
  });

  it("renders a real ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installGraphifyReceipts();

    const args = { operation: "query", question: "How does auth work?" };
    const component = new ToolExecutionComponent(
      "graphify",
      "call-1",
      args,
      { showImages: false },
      { name: "graphify" } as any,
      stubUi() as any,
      process.cwd(),
    );
    component.markExecutionStarted();
    component.updateResult({
      content: [
        {
          type: "text",
          text: "AuthModule talks to Database via SessionStore.",
        },
      ],
      isError: false,
    });

    const lines = component.render(80);
    const text = lines.join("\n");
    assert.match(text, /graphify/);
    assert.match(text, /query How does auth work\?/);
    assert.match(text, /AuthModule talks to Database/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.equal((text.match(/graphify/g) ?? []).length, 1);
    assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previous = process.env.PI_APEX_UI;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    try {
      installGraphifyReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});
