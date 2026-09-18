import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "@pi/ui-kit/internal/presentation/safe-text-layout.ts";
import {
  BUILTIN_GREP_TOOL,
  BUILTIN_LS_TOOL,
  builtinGrepReceiptArg,
  builtinGrepReceiptRenderers,
  builtinLsReceiptArg,
  builtinLsReceiptRenderers,
  installBuiltinReceipts,
} from "@pi/ui-kit/internal/presentation/builtin-receipts.ts";

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

describe("apex builtin grep/ls receipts", () => {
  it("formats compact grep header arguments", () => {
    assert.equal(builtinGrepReceiptArg({ pattern: "toolRenderers" }, 80), "toolRenderers");
    assert.equal(
      builtinGrepReceiptArg({ pattern: "import.*tool", path: "src/" }, 80),
      "import.*tool src/",
    );
    assert.equal(
      builtinGrepReceiptArg({ pattern: "TODO", path: "src", glob: "*.ts" }, 80),
      "TODO src *.ts",
    );
    assert.equal(
      builtinGrepReceiptArg({ pattern: "Foo", ignoreCase: true }, 80),
      "Foo ignore-case",
    );
    assert.equal(
      builtinGrepReceiptArg({ pattern: "Foo.*", literal: true }, 80),
      "Foo.* literal",
    );
    assert.equal(
      builtinGrepReceiptArg({ pattern: "TODO", context: 2, limit: 10 }, 80),
      "TODO ctx 2 limit 10",
    );
    assert.equal(
      builtinGrepReceiptArg(
        { pattern: "x", ignoreCase: true, literal: true, context: 3, limit: 5 },
        80,
      ),
      "x ignore-case literal ctx 3 limit 5",
    );
    // Absent flags are omitted entirely.
    assert.equal(
      builtinGrepReceiptArg(
        { pattern: "x", ignoreCase: false, literal: false, context: 0 },
        80,
      ),
      "x",
    );
    assert.equal(
      builtinGrepReceiptArg({ pattern: "renderCall", path: "agent\\extensions" }, 80),
      "renderCall agent/extensions",
    );
    assert.equal(builtinGrepReceiptArg(undefined, 80), "grep");
  });

  it("formats compact ls header arguments", () => {
    assert.equal(builtinLsReceiptArg({ path: "src/components" }, 80), "src/components");
    assert.equal(builtinLsReceiptArg({ path: "src", limit: 20 }, 80), "src limit 20");
    assert.equal(builtinLsReceiptArg(undefined, 80), ".");
    assert.equal(builtinLsReceiptArg({}, 80), ".");
    assert.equal(builtinLsReceiptArg({ path: "" }, 80), ".");
    assert.equal(builtinLsReceiptArg({ limit: 10 }, 80), ". limit 10");
  });

  it("renders grep stats only when details are present", () => {
    const args = { pattern: "toolRenderers" };
    const ctx = context(args);
    const empty = builtinGrepReceiptRenderers
      .renderResult(
        { content: [{ type: "text", text: "src/a.ts:1:toolRenderers" }] },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80)
      .join("\n");
    assert.match(empty, /grep/);
    assert.doesNotMatch(empty, /limit/);
    assert.doesNotMatch(empty, /truncated/);

    const limited = builtinGrepReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "src/a.ts:1:toolRenderers" }],
          details: { matchLimitReached: 100 },
        },
        { expanded: false, isPartial: false },
        theme,
        context(args),
      )
      .render(80)
      .join("\n");
    assert.match(limited, /limit 100/);

    const truncated = builtinGrepReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "src/a.ts:1:toolRenderers" }],
          details: { linesTruncated: true },
        },
        { expanded: false, isPartial: false },
        theme,
        context(args),
      )
      .render(80)
      .join("\n");
    assert.match(truncated, /truncated/);
  });

  it("renders ls stats only when details are present", () => {
    const args = { path: "src" };
    const plain = builtinLsReceiptRenderers
      .renderResult(
        { content: [{ type: "text", text: "a.ts\nb.ts" }] },
        { expanded: false, isPartial: false },
        theme,
        context(args),
      )
      .render(80)
      .join("\n");
    assert.match(plain, /ls/);
    assert.doesNotMatch(plain, /limit/);

    const limited = builtinLsReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "a.ts\nb.ts" }],
          details: { entryLimitReached: 50 },
        },
        { expanded: false, isPartial: false },
        theme,
        context(args),
      )
      .render(80)
      .join("\n");
    assert.match(limited, /limit 50/);
  });

  it("reads the truncation object for grep stats", () => {
    const render = (details: unknown) =>
      builtinGrepReceiptRenderers
        .renderResult(
          { content: [{ type: "text", text: "src/a.ts:1:x" }], details },
          { expanded: false, isPartial: false },
          theme,
          context({ pattern: "x" }),
        )
        .render(80)
        .join("\n");

    assert.match(
      render({ truncation: { truncated: true, truncatedBy: "lines", totalLines: 2500 } }),
      /truncated 2500 lines/,
    );
    assert.match(
      render({ truncation: { truncated: true, truncatedBy: "bytes", totalBytes: 51200 } }),
      /truncated 51200 bytes/,
    );
    // Not truncated: no token.
    assert.doesNotMatch(
      render({ truncation: { truncated: false, truncatedBy: null } }),
      /truncated/,
    );
    // Malformed: truncated without a recognized truncatedBy stays bounded.
    const bare = render({ truncation: { truncated: true } });
    assert.match(bare, /truncated/);
    assert.doesNotMatch(bare, /lines|bytes/);
    // Non-object truncation value: no crash, no token.
    assert.doesNotMatch(render({ truncation: "oops" }), /truncated/);
    assert.doesNotMatch(render({ truncation: 42 }), /truncated/);
    // Oversized counts are not printed raw.
    const huge = render({
      truncation: { truncated: true, truncatedBy: "bytes", totalBytes: 10 ** 12 },
    });
    assert.match(huge, /truncated/);
    assert.doesNotMatch(huge, /1000000000000/);
    // Dedupe: generic flag plus a specific signal reads once.
    const both = render({
      linesTruncated: true,
      truncation: { truncated: true, truncatedBy: "lines", totalLines: 2500 },
    });
    assert.match(both, /truncated 2500 lines/);
    assert.equal((both.match(/truncated/g) ?? []).length, 1);
    // Dedupe: generic flag plus a plain signal reads once.
    const plain = render({ linesTruncated: true, truncation: { truncated: true } });
    assert.equal((plain.match(/truncated/g) ?? []).length, 1);
    // Ordering: match limit first, truncation signal last.
    const ordered = render({
      matchLimitReached: 100,
      truncation: { truncated: true, truncatedBy: "lines", totalLines: 2500 },
    });
    assert.match(ordered, /limit 100 · truncated 2500 lines/);
  });

  it("reads the truncation object for ls stats", () => {
    const render = (details: unknown) =>
      builtinLsReceiptRenderers
        .renderResult(
          { content: [{ type: "text", text: "a.ts\nb.ts" }], details },
          { expanded: false, isPartial: false },
          theme,
          context({ path: "src" }),
        )
        .render(80)
        .join("\n");

    assert.match(
      render({ truncation: { truncated: true, truncatedBy: "lines", totalLines: 300 } }),
      /truncated 300 lines/,
    );
    assert.match(
      render({ truncation: { truncated: true, truncatedBy: "bytes", totalBytes: 60000 } }),
      /truncated 60000 bytes/,
    );
    assert.doesNotMatch(
      render({ truncation: { truncated: false, truncatedBy: null } }),
      /truncated/,
    );
    assert.doesNotMatch(render({ truncation: "oops" }), /truncated/);
    const bare = render({ truncation: { truncated: true } });
    assert.match(bare, /truncated/);
    // Ordering: entry limit first, truncation signal last.
    const ordered = render({
      entryLimitReached: 50,
      truncation: { truncated: true, truncatedBy: "bytes", totalBytes: 60000 },
    });
    assert.match(ordered, /limit 50 · truncated 60000 bytes/);
  });

  it("renders grep and ls receipts without boxes or JSON dumps", () => {
    const grepCtx = context({ pattern: "toolRenderers", path: "agent/extensions" });
    const grepCall = builtinGrepReceiptRenderers
      .renderCall({ pattern: "toolRenderers", path: "agent/extensions" }, theme, grepCtx)
      .render(80)
      .join("\n");
    assert.match(grepCall, /grep/);
    assert.match(grepCall, /toolRenderers agent\/extensions/);
    assert.doesNotMatch(grepCall, /┌|┐|└|┘/);
    assert.doesNotMatch(grepCall, /"pattern"/);

    const lsCtx = context({ path: "src" });
    const lsCall = builtinLsReceiptRenderers
      .renderCall({ path: "src" }, theme, lsCtx)
      .render(80)
      .join("\n");
    assert.match(lsCall, /ls/);
    assert.match(lsCall, /src/);
    assert.doesNotMatch(lsCall, /┌|┐|└|┘/);
    assert.doesNotMatch(lsCall, /"path"/);
  });

  it("blanks the call row once the result receipt exists", () => {
    const args = { pattern: "test" };
    const ctx = context(args);
    const callComponent = builtinGrepReceiptRenderers.renderCall(args, theme, ctx);
    assert.match(callComponent.render(80).join("\n"), /test/);

    builtinGrepReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "test.ts:1:test" }] },
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );
    assert.deepEqual(callComponent.render(80), []);
  });

  it("overrides owned grep/ls renderers while enabled and falls back when PI_APEX_UI=0", () => {
    withApexUi("1", () => installBuiltinReceipts());
    const proto = ToolExecutionComponent.prototype as any;

    const ownGrepCall = () => ({ render: () => ["OWN-GREP-CALL"], invalidate() {} });
    const ownGrepResult = () => ({ render: () => ["OWN-GREP-RESULT"], invalidate() {} });
    const grepComp = {
      toolName: BUILTIN_GREP_TOOL,
      toolDefinition: {
        name: BUILTIN_GREP_TOOL,
        renderCall: ownGrepCall,
        renderResult: ownGrepResult,
      },
    };

    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(grepComp), builtinGrepReceiptRenderers.renderCall);
      assert.equal(
        proto.getResultRenderer.call(grepComp),
        builtinGrepReceiptRenderers.renderResult,
      );
      assert.equal(proto.getRenderShell.call(grepComp), "self");
      assert.equal(proto.hasRendererDefinition.call(grepComp), true);
    });

    withApexUi("0", () => {
      assert.equal(proto.getCallRenderer.call(grepComp), ownGrepCall);
      assert.equal(proto.getResultRenderer.call(grepComp), ownGrepResult);
      assert.equal(proto.getRenderShell.call(grepComp), "default");
    });

    // Re-enable restores Apex receipts.
    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(grepComp), builtinGrepReceiptRenderers.renderCall);
      assert.equal(
        proto.getResultRenderer.call(grepComp),
        builtinGrepReceiptRenderers.renderResult,
      );
      assert.equal(proto.getRenderShell.call(grepComp), "self");
    });

    const ownLsCall = () => ({ render: () => ["OWN-LS-CALL"], invalidate() {} });
    const ownLsResult = () => ({ render: () => ["OWN-LS-RESULT"], invalidate() {} });
    const lsComp = {
      toolName: BUILTIN_LS_TOOL,
      toolDefinition: {
        name: BUILTIN_LS_TOOL,
        renderCall: ownLsCall,
        renderResult: ownLsResult,
      },
    };

    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(lsComp), builtinLsReceiptRenderers.renderCall);
      assert.equal(
        proto.getResultRenderer.call(lsComp),
        builtinLsReceiptRenderers.renderResult,
      );
      assert.equal(proto.getRenderShell.call(lsComp), "self");
    });

    withApexUi("0", () => {
      assert.equal(proto.getCallRenderer.call(lsComp), ownLsCall);
      assert.equal(proto.getResultRenderer.call(lsComp), ownLsResult);
      assert.equal(proto.getRenderShell.call(lsComp), "default");
    });

    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(lsComp), builtinLsReceiptRenderers.renderCall);
      assert.equal(proto.getRenderShell.call(lsComp), "self");
    });
  });

  it("renders real grep/ls ToolExecutionComponents as Apex receipts", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installBuiltinReceipts();

      const grep = new ToolExecutionComponent(
        "grep",
        "call-grep-1",
        { pattern: "renderCall", path: "src/" },
        { showImages: false },
        { name: "grep", renderCall: () => {}, renderResult: () => {} } as any,
        stubUi() as any,
        process.cwd(),
      );
      grep.markExecutionStarted();
      grep.updateResult({
        content: [{ type: "text", text: "src/a.ts:10:renderCall(args)" }],
        isError: false,
      });
      const grepLines = grep.render(80);
      const grepText = grepLines.join("\n");
      assert.match(grepText, /grep/);
      assert.match(grepText, /renderCall src\//);
      assert.match(grepText, /renderCall\(args\)/);
      assert.doesNotMatch(grepText, /┌|┐|└|┘/);
      assert.ok(grepLines.every((line) => safeVisibleWidth(line) <= 80));

      const ls = new ToolExecutionComponent(
        "ls",
        "call-ls-1",
        { path: "src" },
        { showImages: false },
        { name: "ls", renderCall: () => {}, renderResult: () => {} } as any,
        stubUi() as any,
        process.cwd(),
      );
      ls.markExecutionStarted();
      ls.updateResult({
        content: [{ type: "text", text: "a.ts\nb.ts" }],
        isError: false,
      });
      const lsLines = ls.render(80);
      const lsText = lsLines.join("\n");
      assert.match(lsText, /ls/);
      assert.match(lsText, /src/);
      assert.match(lsText, /a\.ts/);
      assert.doesNotMatch(lsText, /┌|┐|└|┘/);
      assert.ok(lsLines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("keeps output bounded and width-safe", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installBuiltinReceipts();

      const big = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts:${i}:match`).join("\n");
      const component = new ToolExecutionComponent(
        "grep",
        "call-grep-bounded",
        { pattern: "match" },
        { showImages: false },
        { name: "grep", renderCall: () => {}, renderResult: () => {} } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: big }],
        details: { matchLimitReached: 500 },
        isError: false,
      });

      for (const width of [40, 80, 120]) {
        const lines = component.render(width);
        assert.ok(lines.length <= 100);
        assert.ok(lines.every((line) => safeVisibleWidth(line) <= width));
        assert.ok(lines.join("\n").length <= width * 100 + 500);
      }
      const text = component.render(80).join("\n");
      assert.match(text, /more lines/);
      assert.match(text, /limit 500/);
    });
  });
});
