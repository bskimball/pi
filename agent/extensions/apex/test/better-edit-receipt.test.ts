import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  BETTER_EDIT_EDIT_TOOL,
  BETTER_EDIT_READ_SKILL_TOOL,
  BETTER_EDIT_READ_TOOL,
  BETTER_EDIT_UNDO_TOOL,
  betterEditEditReceiptRenderers,
  betterEditPathArg,
  betterEditReadReceiptRenderers,
  betterEditReadSkillReceiptRenderers,
  betterEditUndoReceiptRenderers,
  installBetterEditReceipts,
} from "../internal/presentation/better-edit-receipt.ts";

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

const HASHLINE = [
  "AbC\u2502const x = 1;",
  "DeF\u2502const y = 2;",
  "GhI\u2502",
  "[Showing lines 1-3 of 80. Use offset=4 to continue.]",
].join("\n");

const HASHLINE_DIFF = [
  " AbC\u2502const x = 1;",
  "-DeF\u2502const y = 2;",
  "+JkL\u2502const y = 3;",
].join("\n");

describe("apex better-edit receipts", () => {
  it("formats compact path arguments including read windows", () => {
    assert.equal(betterEditPathArg({ path: "src/app.ts" }, 80), "src/app.ts");
    assert.equal(
      betterEditPathArg({ path: "src/app.ts", offset: 12, limit: 40 }, 80),
      "src/app.ts:12+40",
    );
    assert.equal(
      betterEditPathArg({ path: "agent\\extensions\\apex\\apex-ui.ts" }, 80),
      "agent/extensions/apex/apex-ui.ts",
    );
    assert.equal(betterEditPathArg({ edits: [{}, {}] }, 80), "2 edits");
    assert.equal(betterEditPathArg({}, 80), "...");
  });

  it("renders hashline read output as an Apex receipt instead of a boxed dump", () => {
    const args = { path: "src/app.ts", offset: 1, limit: 40 };
    const ctx = context(args);
    const call = betterEditReadReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /read/);
    assert.match(call, /src\/app\.ts:1\+40/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);

    const rendered = betterEditReadReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: HASHLINE }],
          details: { truncation: { truncated: true }, nextOffset: 4 },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /read/);
    assert.match(text, /truncated/);
    assert.match(text, /next 4/);
    assert.match(text, /AbC\u2502const x = 1;/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("renders hashline edit diffs as an Apex receipt and stays bounded when expanded", () => {
    const args = { path: "src/app.ts", edits: [["DeF", "DeF", "const y = 3;"]] };
    const ctx = context(args);
    const call = betterEditEditReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /edit/);
    assert.match(call, /src\/app\.ts/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);

    const hugeDiff = `${HASHLINE_DIFF}\n${Array.from({ length: 200 }, (_, i) => `+Xy${i % 10}\u2502line ${i}`).join("\n")}`;
    const rendered = betterEditEditReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "edited src/app.ts" }],
          details: {
            diff: hugeDiff,
            metrics: { classification: "applied", added_lines: 201, removed_lines: 1 },
          },
        },
        { expanded: true, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /edit/);
    assert.match(text, /\+201/);
    assert.match(text, /-1/);
    assert.match(text, /const y = 3;/);
    assert.match(text, /truncated for display|more diff lines/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.length <= 90);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("overrides owned read/edit renderers while leaving unrelated tools alone", () => {
    withApexUi("1", () => installBetterEditReceipts());
    const proto = ToolExecutionComponent.prototype as any;
    const ownCall = () => ({ render: () => ["OWN-CALL"], invalidate() {} });
    const ownResult = () => ({ render: () => ["OWN-RESULT"], invalidate() {} });

    for (const [name, renderers] of [
      [BETTER_EDIT_READ_TOOL, betterEditReadReceiptRenderers],
      [BETTER_EDIT_EDIT_TOOL, betterEditEditReceiptRenderers],
      [BETTER_EDIT_READ_SKILL_TOOL, betterEditReadSkillReceiptRenderers],
      [BETTER_EDIT_UNDO_TOOL, betterEditUndoReceiptRenderers],
    ] as const) {
      const owned = {
        toolName: name,
        toolDefinition: {
          name,
          renderCall: ownCall,
          renderResult: ownResult,
          renderShell: "default",
        },
        builtInToolDefinition: {
          name,
          renderCall: ownCall,
          renderResult: ownResult,
        },
      };
      withApexUi("1", () => {
        assert.equal(proto.getCallRenderer.call(owned), renderers.renderCall, `${name} call`);
        assert.equal(proto.getResultRenderer.call(owned), renderers.renderResult, `${name} result`);
        assert.equal(proto.getRenderShell.call(owned), "self", `${name} shell`);
      });
    }

    const other = {
      toolName: "custom_external_tool",
      toolDefinition: {
        name: "custom_external_tool",
        renderCall: ownCall,
        renderResult: ownResult,
      },
    };
    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(other), ownCall);
      assert.equal(proto.getResultRenderer.call(other), ownResult);
      assert.equal(proto.getRenderShell.call(other), "default");
    });
  });

  it("attaches the receipt to a real read ToolExecutionComponent", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installBetterEditReceipts();
      const component = new ToolExecutionComponent(
        BETTER_EDIT_READ_TOOL,
        "call-1",
        { path: "src/app.ts" },
        { showImages: false },
        {
          name: BETTER_EDIT_READ_TOOL,
          renderCall: () => ({ render: () => ["STOCK-CALL"], invalidate() {} }),
          renderResult: () => ({ render: () => ["STOCK-RESULT"], invalidate() {} }),
        } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: HASHLINE }],
        isError: false,
      });
      const lines = component.render(80);
      const text = lines.join("\n");
      assert.match(text, /read/);
      assert.match(text, /src\/app\.ts/);
      assert.match(text, /AbC\u2502const x = 1;/);
      assert.doesNotMatch(text, /STOCK-CALL|STOCK-RESULT/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("falls back when PI_APEX_UI=0 is toggled after installation", () => {
    withApexUi("1", () => installBetterEditReceipts());
    const proto = ToolExecutionComponent.prototype as any;
    const ownCall = () => ({ render: () => ["OWN-CALL"], invalidate() {} });
    const ownResult = () => ({ render: () => ["OWN-RESULT"], invalidate() {} });
    const owned = {
      toolName: BETTER_EDIT_READ_TOOL,
      toolDefinition: {
        name: BETTER_EDIT_READ_TOOL,
        renderCall: ownCall,
        renderResult: ownResult,
      },
    };
    withApexUi("0", () => {
      assert.equal(proto.getCallRenderer.call(owned), ownCall);
      assert.equal(proto.getResultRenderer.call(owned), ownResult);
    });
  });
});
