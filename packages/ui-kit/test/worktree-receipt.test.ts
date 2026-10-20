import { resolveReceiptFor, ReceiptToolExecutionComponent } from "./receipt-test-host.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "@pi/ui-kit/internal/presentation/safe-text-layout.ts";
import {
  WORKTREE_RECEIPT_TOOL,
  installWorktreeReceipts,
  worktreeReceiptRenderers,
} from "@pi/ui-kit/internal/presentation/worktree-receipt.ts";

import { installSharedPresentation, resetUiKitInstallForTests } from "../install.ts";
import { shippingReceiptRenderers } from "../internal/presentation/shipping-receipt.ts";

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

describe("shipping receipts", () => {
  const summary = {
    task: "ui-polish", branch: "feature", remote: "origin", target: "main", delivery: "ship", route: "direct",
    head: "abc123", state: "working", blocker: "Review required", checks: [{ command: "npm", args: ["test"] }],
    gates: { head: "old123", passed: 1 }, review: { head: "old123", verdict: "pass" }, dirty: [],
  };
  function render(details: any, expanded = false, isError = false) {
    return shippingReceiptRenderers.renderResult(
      { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
      { expanded, isPartial: false }, theme, context({ operation: "status", task: "ui-polish" }, { isError }),
    ).render(160).join("\n");
  }

  it("prioritizes blockers and marks stale verification without implying readiness", () => {
    const output = render(summary);
    assert.match(output, /blocked: Review required/);
    assert.match(output, /origin\/main/);
    assert.match(output, /checks 1\/1 \(stale\)/);
    assert.match(output, /review pass \(stale\)/);
    assert.doesNotMatch(output, /"checks"|"owner"/);
    assert.match(render(summary, true), /"checks"/);
    const current = render({ ...summary, gates: { head: "abc123", passed: 1 }, review: { head: "abc123", verdict: "pass" } });
    assert.doesNotMatch(current, /stale/);
  });

  it("distinguishes pending merge, landed, checkpoints, and inventory", () => {
    assert.match(render({ ...summary, state: "pending-merge", next: "Await merge queue" }), /pending-merge/);
    assert.match(render({ ...summary, state: "pending-merge", next: "Await merge queue" }), /next: Await merge queue/);
    assert.match(render({ state: "landed", landed: { commit: "abc123" } }), /landed abc123/);
    assert.match(render({ checkpoint: "abc123", path: "C:/repo", preserved: ["other.ts"] }), /1 paths preserved/);
    const inventory = render({ tasks: [summary, summary, summary, summary], worktrees: [] });
    assert.match(inventory, /4 tasks/);
    assert.match(inventory, /1 more tasks/);
    assert.match(render({ tasks: [], worktrees: [] }), /No shipping tasks recorded/);
    assert.match(render("Gate 1/2 failed", false, true), /Gate 1\/2 failed/);
  });

  it("attaches through the shared installer to Pi components and honors chrome-off", () => {
    initTheme("dark");
    withApexUi("1", () => {
      resetUiKitInstallForTests();
      try {
        installSharedPresentation({ registerMessageRenderer() {}, registerToolRenderer() {}, getFlag() {} } as any);
        const definition = { toolName: "shipping", toolDefinition: { name: "shipping" } };
        assert.equal(resolveReceiptFor(definition)?.renderCall, shippingReceiptRenderers.renderCall);
        const component = new ReceiptToolExecutionComponent(
          "shipping", "shipping-call", { operation: "verify", task: "ui-polish" }, { showImages: false },
          { name: "shipping" } as any, { requestRender() {} } as any, process.cwd(),
        );
        component.markExecutionStarted();
        component.updateResult({ content: [{ type: "text", text: JSON.stringify(summary) }], details: summary, isError: false });
        assert.match(component.render(120).join("\n"), /blocked: Review required/);
        for (const width of [30, 80, 120]) assert.ok(component.render(width).every((line) => safeVisibleWidth(line) <= width));
        process.env.PI_UI_CHROME = "0";
        assert.equal(resolveReceiptFor(definition)?.renderCall, undefined);
      } finally { resetUiKitInstallForTests(); }
    });
  });
});

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
      const definition = { toolName: WORKTREE_RECEIPT_TOOL, toolDefinition: { name: WORKTREE_RECEIPT_TOOL } };
      assert.equal(resolveReceiptFor(definition)?.renderCall, worktreeReceiptRenderers.renderCall);
      assert.equal(resolveReceiptFor(definition)?.renderResult, worktreeReceiptRenderers.renderResult);
      assert.equal(resolveReceiptFor(definition)?.renderShell ?? "default", "self");

      const component = new ReceiptToolExecutionComponent(
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
