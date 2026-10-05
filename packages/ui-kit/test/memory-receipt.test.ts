import { resolveReceiptFor, ReceiptToolExecutionComponent } from "./receipt-test-host.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "@pi/ui-kit/internal/presentation/safe-text-layout.ts";
import {
  MEMORY_LIST_TOOL,
  MEMORY_WRITE_TOOL,
  installMemoryReceipts,
  memoryListReceiptRenderers,
  memoryWriteReceiptRenderers,
} from "@pi/ui-kit/internal/presentation/memory-receipt.ts";

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
  const previousApex = process.env.PI_APEX_UI;
  const previousChrome = process.env.PI_UI_CHROME;
  process.env.PI_APEX_UI = value;
  process.env.PI_UI_CHROME = value;
  try {
    return run();
  } finally {
    if (previousApex === undefined) delete process.env.PI_APEX_UI;
    else process.env.PI_APEX_UI = previousApex;
    if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
    else process.env.PI_UI_CHROME = previousChrome;
  }
}

function stubUi() {
  return { requestRender() {} };
}

describe("apex memory receipts", () => {
  it("renders memory_list as an Apex receipt instead of boxed JSON args", () => {
    const args = { scope: "all" };
    const ctx = context(args);
    const call = memoryListReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /memory_list/);
    assert.match(call, /all/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"scope"/);

    const rendered = memoryListReceiptRenderers
      .renderResult(
        {
          content: [
            {
              type: "text",
              text: "global/memory: 1\n- [global:pref] pref: default scope is global",
            },
          ],
          details: { message: "1 entry" },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /memory_list/);
    assert.match(text, /1 entry/);
    assert.match(text, /global\/memory/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("renders memory_write as an Apex receipt", () => {
    const args = {
      action: "create",
      scope: "global",
      kind: "memory",
      title: "pref",
    };
    const ctx = context(args);
    const rendered = memoryWriteReceiptRenderers
      .renderResult(
        {
          content: [
            { type: "text", text: "created global:pref (memory) pref" },
          ],
          details: { message: "created global:pref (memory) pref" },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /memory_write/);
    assert.match(text, /create global memory pref/);
    assert.match(text, /created global:pref \(memory\) pref/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
  });

  it("resolves memory tool renderers through the public API and leaves others alone", () => {
    withApexUi("1", () => {
      installMemoryReceipts();

      const list = {
        toolName: MEMORY_LIST_TOOL,
        toolDefinition: { name: "memory_list" },
      };
      assert.equal(
        resolveReceiptFor(list)?.renderCall,
        memoryListReceiptRenderers.renderCall,
      );
      assert.equal(
        resolveReceiptFor(list)?.renderResult,
        memoryListReceiptRenderers.renderResult,
      );
      assert.equal(resolveReceiptFor(list)?.renderShell ?? "default", "self");

      const write = {
        toolName: MEMORY_WRITE_TOOL,
        toolDefinition: { name: "memory_write" },
      };
      assert.equal(
        resolveReceiptFor(write)?.renderCall,
        memoryWriteReceiptRenderers.renderCall,
      );
      assert.equal(resolveReceiptFor(write)?.renderShell ?? "default", "self");

      const owned = {
        toolName: MEMORY_LIST_TOOL,
        toolDefinition: {
          name: "memory_list",
          renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
        },
      };
      assert.notEqual(
        resolveReceiptFor(owned)?.renderCall,
        memoryListReceiptRenderers.renderCall,
      );
      assert.equal(resolveReceiptFor(owned)?.renderShell ?? "default", "default");

      const other = {
        toolName: "bash",
        toolDefinition: { name: "bash" },
      };
      assert.equal(resolveReceiptFor(other)?.renderCall, undefined);
      assert.equal(resolveReceiptFor(other)?.renderShell ?? "default", "default");
    });
  });

  it("renders a real memory_list ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installMemoryReceipts();

      const args = { scope: "global", kind: "memory" };
      const component = new ReceiptToolExecutionComponent(
        "memory_list",
        "call-1",
        args,
        { showImages: false },
        { name: "memory_list" } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [
          {
            type: "text",
            text: "global/memory: 1\n- [global:pref] pref: default scope is global",
          },
        ],
        details: { message: "1 entry" },
        isError: false,
      });

      const lines = component.render(80);
      const text = lines.join("\n");
      assert.match(text, /memory_list/);
      assert.match(text, /global memory/);
      assert.match(text, /1 entry/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.equal((text.match(/memory_list/g) ?? []).length, 1);
      assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previousApex = process.env.PI_APEX_UI;
    const previousChrome = process.env.PI_UI_CHROME;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    process.env.PI_UI_CHROME = "0";
    try {
      installMemoryReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previousApex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previousApex;
      if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
      else process.env.PI_UI_CHROME = previousChrome;
    }
  });
});
