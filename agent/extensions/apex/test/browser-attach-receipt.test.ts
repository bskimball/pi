import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  BROWSER_ATTACH_TOOL,
  browserAttachConnectExcerpt,
  browserAttachPreviewLines,
  browserAttachReceiptArg,
  browserAttachReceiptRenderers,
  installBrowserAttachReceipts,
} from "../internal/presentation/browser-attach-receipt.ts";

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

const CONNECT_PROMPT = [
  '<skill name="agent-browser">',
  "If the current prompt or tool result already contains a successful [Connect step], the browser is attached; continue with interaction instead of attaching again.",
  "Never use plain agent-browser.",
  "</skill>",
  "You are co-browsing with me in a dedicated authenticated debug Chrome.",
  "## Hard rules",
  "Never use autoConnect.",
  "Task/URL from me: inspect https://example.com",
  "[Connect step]",
  "status: succeeded",
  "exitCode: 0",
  "",
  "[stdout]",
  "STATUS: connected",
  "Mode: classic",
  "Port: 29300",
].join("\n");

describe("apex browser_attach receipt", () => {
  it("formats the task as the compact header argument", () => {
    assert.equal(
      browserAttachReceiptArg({ task: "inspect https://example.com" }, 80),
      "inspect https://example.com",
    );
    assert.equal(browserAttachReceiptArg({}, 80), "attach");
  });

  it("keeps the connect excerpt and drops the custom prompt preamble", () => {
    const excerpt = browserAttachConnectExcerpt(CONNECT_PROMPT);
    assert.match(excerpt, /\[Connect step\]/);
    assert.match(excerpt, /STATUS: connected/);
    assert.doesNotMatch(excerpt, /You are co-browsing/);
    assert.doesNotMatch(excerpt, /Hard rules/);
    assert.doesNotMatch(excerpt, /Never use plain agent-browser/);
    assert.deepEqual(browserAttachPreviewLines(CONNECT_PROMPT), [
      "status: succeeded",
      "STATUS: connected",
      "Mode: classic",
      "Port: 29300",
    ]);
  });

  it("renders an Apex receipt instead of boxed JSON args", () => {
    const args = { task: "inspect https://example.com" };
    const ctx = context(args);
    const call = browserAttachReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /browser_attach/);
    assert.match(call, /inspect https:\/\/example.com/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"task"/);

    const rendered = browserAttachReceiptRenderers
      .renderResult(
        { content: [{ type: "text", text: CONNECT_PROMPT }] },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /browser_attach/);
    assert.match(text, /status: succeeded/);
    assert.match(text, /STATUS: connected/);
    assert.match(text, /Mode: classic/);
    assert.doesNotMatch(text, /You are co-browsing/);
    assert.doesNotMatch(text, /Hard rules/);
    assert.doesNotMatch(text, /\[Connect step\]/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));

    const expanded = browserAttachReceiptRenderers
      .renderResult(
        { content: [{ type: "text", text: CONNECT_PROMPT }] },
        { expanded: true, isPartial: false },
        theme,
        ctx,
      )
      .render(80)
      .join("\n");
    assert.match(expanded, /\[Connect step\]/);
    assert.match(expanded, /STATUS: connected/);
    assert.doesNotMatch(expanded, /You are co-browsing/);
    assert.doesNotMatch(expanded, /Hard rules/);
    assert.doesNotMatch(expanded, /Never use plain agent-browser/);
  });

  it("attaches the receipt to real browser_attach ToolExecutionComponents", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installBrowserAttachReceipts();
      const proto = ToolExecutionComponent.prototype as any;
      const definition = {
        toolName: BROWSER_ATTACH_TOOL,
        toolDefinition: { name: BROWSER_ATTACH_TOOL },
      };
      assert.equal(
        proto.getCallRenderer.call(definition),
        browserAttachReceiptRenderers.renderCall,
      );
      assert.equal(
        proto.getResultRenderer.call(definition),
        browserAttachReceiptRenderers.renderResult,
      );
      assert.equal(proto.getRenderShell.call(definition), "self");

      const component = new ToolExecutionComponent(
        BROWSER_ATTACH_TOOL,
        "call-1",
        { task: "inspect https://example.com" },
        { showImages: false },
        { name: BROWSER_ATTACH_TOOL } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: CONNECT_PROMPT }],
        isError: false,
      });

      const lines = component.render(80);
      const text = lines.join("\n");
      assert.match(text, /browser_attach/);
      assert.match(text, /inspect https:\/\/example.com/);
      assert.match(text, /status: succeeded/);
      assert.match(text, /STATUS: connected/);
      assert.doesNotMatch(text, /You are co-browsing/);
      assert.doesNotMatch(text, /\[Connect step\]/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.equal((text.match(/browser_attach/g) ?? []).length, 1);
      assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previous = process.env.PI_APEX_UI;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    try {
      installBrowserAttachReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});
