import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  WORKTREE_RECEIPT_TOOL,
  installWorktreeReceipts,
  worktreeReceiptRenderers,
} from "../internal/presentation/worktree-receipt.ts";

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

describe("apex worktree receipt", () => {
  it("renders worktree output as an Apex receipt instead of boxed JSON args", () => {
    const args = { operation: "list" };
    const ctx = context(args);
    const call = worktreeReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /worktree/);
    assert.match(call, /list/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"operation"/);

    const rendered = worktreeReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "path: C:/repo\nbranch: main\nHEAD: abc123" }],
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /worktree/);
    assert.match(text, /path: C:\/repo/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("attaches the receipt to real worktree ToolExecutionComponents", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installWorktreeReceipts();
      const proto = ToolExecutionComponent.prototype as any;
      const definition = { toolName: WORKTREE_RECEIPT_TOOL, toolDefinition: { name: WORKTREE_RECEIPT_TOOL } };
      assert.equal(proto.getCallRenderer.call(definition), worktreeReceiptRenderers.renderCall);
      assert.equal(proto.getResultRenderer.call(definition), worktreeReceiptRenderers.renderResult);
      assert.equal(proto.getRenderShell.call(definition), "self");

      const component = new ToolExecutionComponent(
        WORKTREE_RECEIPT_TOOL,
        "call-1",
        { operation: "list" },
        { showImages: false },
        { name: WORKTREE_RECEIPT_TOOL } as any,
        { requestRender() {} } as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: "path: C:/repo\nbranch: main\nHEAD: abc123" }],
        isError: false,
      });

      const lines = component.render(80);
      const text = lines.join("\n");
      assert.match(text, /worktree/);
      assert.match(text, /list/);
      assert.match(text, /path: C:\/repo/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.equal((text.match(/worktree/g) ?? []).length, 1);
      assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });
});
