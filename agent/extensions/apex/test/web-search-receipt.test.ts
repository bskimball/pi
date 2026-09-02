import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  fetchContentReceiptRenderers,
  installWebSearchReceipts,
  webSearchReceiptRenderers,
} from "../internal/presentation/web-search-receipt.ts";

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

describe("apex web-search receipts", () => {
  it("renders an Apex receipt instead of boxed JSON args", () => {
    const args = { query: "pi coding agent" };
    const ctx = context(args);
    const call = webSearchReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /web_search/);
    assert.match(call, /pi coding agent/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"query"/);

    const rendered = webSearchReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "1. Result title\nhttps://example.com" }],
          details: { resultCount: 1, queryCount: 1 },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /web_search/);
    assert.match(text, /1 result/);
    assert.match(text, /Result title/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("wraps fetch_content ToolExecutionComponent getters", () => {
    withApexUi("1", () => {
      installWebSearchReceipts();
    const proto = ToolExecutionComponent.prototype as any;
    const fetch = {
      toolName: "fetch_content",
      toolDefinition: { name: "fetch_content" },
    };
    assert.equal(
      proto.getCallRenderer.call(fetch),
      fetchContentReceiptRenderers.renderCall,
    );
    assert.equal(
      proto.getResultRenderer.call(fetch),
      fetchContentReceiptRenderers.renderResult,
    );
    assert.equal(proto.getRenderShell.call(fetch), "self");
    assert.equal(proto.hasRendererDefinition.call(fetch), true);

    const owned = {
      toolName: "fetch_content",
      toolDefinition: {
        name: "fetch_content",
        renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
      },
    };
    assert.notEqual(
      proto.getCallRenderer.call(owned),
      fetchContentReceiptRenderers.renderCall,
    );
    assert.equal(proto.getRenderShell.call(owned), "default");
    });
  });

  it("renders a real fetch_content ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installWebSearchReceipts();

    const args = { url: "https://example.com/docs" };
    const component = new ToolExecutionComponent(
      "fetch_content",
      "call-1",
      args,
      { showImages: false },
      { name: "fetch_content" } as any,
      stubUi() as any,
      process.cwd(),
    );
    component.markExecutionStarted();
    component.updateResult({
      content: [
        {
          type: "text",
          text: "# Docs\nSource: https://example.com/docs\n\nHello world.",
        },
      ],
      details: { host: "example.com", urlCount: 1, contentLength: 12 },
      isError: false,
    });

    const lines = component.render(80);
    const text = lines.join("\n");
    assert.match(text, /fetch_content/);
    assert.match(text, /example.com\/docs/);
    assert.match(text, /Hello world/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previous = process.env.PI_APEX_UI;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    try {
      installWebSearchReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});
