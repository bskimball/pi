import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";
import {
  getHeadlessReceiptState,
  HEADLESS_STATE_KEY,
} from "../internal/presentation/headless-receipts.ts";
import {
  FFF_FIND_TOOL,
  FFF_GREP_TOOL,
  fffindReceiptArg,
  fffindReceiptRenderers,
  ffgrepReceiptArg,
  ffgrepReceiptRenderers,
  installFffReceipts,
} from "../internal/presentation/fff-receipt.ts";

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

describe("apex fff receipts", () => {
  it("formats compact header arguments for fffind including opaque cursor", () => {
    assert.equal(
      fffindReceiptArg({ pattern: "Receipt" }, 80),
      "Receipt",
    );
    assert.equal(
      fffindReceiptArg(
        { pattern: "button", path: "src/components" },
        80,
      ),
      "button src/components",
    );
    assert.equal(
      fffindReceiptArg(
        { pattern: "*.ts", exclude: ["test/", "*.min.js"] },
        80,
      ),
      "*.ts !test/,*.min.js",
    );
    assert.equal(
      fffindReceiptArg(
        { pattern: "foo", exclude: "test/" },
        80,
      ),
      "foo !test/",
    );
    assert.equal(
      fffindReceiptArg(
        { pattern: "bar", limit: 20, cursor: "2" },
        80,
      ),
      "bar limit 20 continued",
    );
    assert.equal(
      fffindReceiptArg(
        { pattern: "bar", limit: 20, cursor: "curs_opaque_token_999" },
        80,
      ),
      "bar limit 20 continued",
    );
    assert.equal(
      fffindReceiptArg(
        { pattern: "main", path: "agent\\extensions\\apex" },
        80,
      ),
      "main agent/extensions/apex",
    );
    assert.equal(
      fffindReceiptArg({ path: "src/components" }, 80),
      "src/components",
    );
    assert.equal(fffindReceiptArg(undefined, 80), "find");
    assert.equal(fffindReceiptArg({ pattern: "" }, 80), "find");
  });

  it("formats compact header arguments for ffgrep including opaque cursor", () => {
    assert.equal(
      ffgrepReceiptArg(
        { pattern: "import.*tool", path: "src/" },
        80,
      ),
      "import.*tool src/",
    );
    assert.equal(
      ffgrepReceiptArg(
        { pattern: "FooBar", caseSensitive: true },
        80,
      ),
      "FooBar case-sensitive",
    );
    assert.equal(
      ffgrepReceiptArg(
        { pattern: "TODO", context: 2, limit: 10 },
        80,
      ),
      "TODO ctx 2 limit 10",
    );
    assert.equal(
      ffgrepReceiptArg(
        { pattern: "export", exclude: ["dist/"], cursor: "3" },
        80,
      ),
      "export continued !dist/",
    );
    assert.equal(
      ffgrepReceiptArg(
        { pattern: "search", cursor: "opaque_grep_cursor_abc" },
        80,
      ),
      "search continued",
    );
    assert.equal(
      ffgrepReceiptArg(
        { pattern: "renderCall", path: "agent\\extensions", context: 0 },
        80,
      ),
      "renderCall agent/extensions",
    );
    assert.equal(ffgrepReceiptArg(undefined, 80), "grep");
    assert.equal(ffgrepReceiptArg({ pattern: "" }, 80), "grep");
  });

  it("renders an Apex receipt for fffind with 1-based page and indexed files", () => {
    const args = { pattern: "receipt", path: "agent/extensions" };
    const ctx = context(args);
    const call = fffindReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /fffind/);
    assert.match(call, /receipt agent\/extensions/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"pattern"/);

    const result = {
      content: [
        {
          type: "text",
          text: "agent/extensions/apex/internal/presentation/fff-receipt.ts\nagent/extensions/apex/internal/presentation/tool-receipt.ts",
        },
      ],
      details: {
        totalMatched: 2,
        totalFiles: 50,
        pageIndex: 1,
        hasMore: true,
      },
    };
    const rendered = fffindReceiptRenderers
      .renderResult(result, { expanded: false, isPartial: false }, theme, ctx)
      .render(120);
    const text = rendered.join("\n");
    assert.match(text, /fffind/);
    assert.match(text, /2 matches/);
    assert.match(text, /50 indexed/);
    assert.match(text, /page 2/);
    assert.doesNotMatch(text, /50 files/);
    assert.doesNotMatch(text, /page 1/);
    assert.match(text, /has/);
    assert.match(text, /fff-receipt\.ts/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 120));

    // hasMore fits within stats budget when not crowded
    const hasMoreResult = {
      content: [{ type: "text", text: "agent/extensions/apex/internal/presentation/fff-receipt.ts" }],
      details: { totalMatched: 2, pageIndex: 1, hasMore: true },
    };
    const hasMoreRendered = fffindReceiptRenderers
      .renderResult(hasMoreResult, { expanded: false, isPartial: false }, theme, ctx)
      .render(120)
      .join("\n");
    assert.match(hasMoreRendered, /has more/);

    // Zero-based pageIndex 0 should display as page 1
    const pageZeroResult = {
      content: [{ type: "text", text: "file.ts" }],
      details: { totalMatched: 1, totalFiles: 10, pageIndex: 0 },
    };
    const renderedZero = fffindReceiptRenderers
      .renderResult(pageZeroResult, { expanded: false, isPartial: false }, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(renderedZero, /page 1/);
    assert.match(renderedZero, /10 indexed/);
  });

  it("renders an Apex receipt for ffgrep with indexed stats", () => {
    const args = { pattern: "toolRenderers", path: "agent/extensions" };
    const ctx = context(args);
    const call = ffgrepReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /ffgrep/);
    assert.match(call, /toolRenderers agent\/extensions/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"pattern"/);

    const result = {
      content: [
        {
          type: "text",
          text: "agent/extensions/apex/internal/presentation/fff-receipt.ts\n 112: export const fffindReceiptRenderers = {\n 148: export const ffgrepReceiptRenderers = {",
        },
      ],
      details: {
        totalMatched: 2,
        totalFiles: 1,
      },
    };
    const rendered = ffgrepReceiptRenderers
      .renderResult(result, { expanded: false, isPartial: false }, theme, ctx)
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /ffgrep/);
    assert.match(text, /2 matches/);
    assert.match(text, /1 indexed/);
    assert.doesNotMatch(text, /1 file/);
    assert.match(text, /fff-receipt\.ts/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("blanks the call row once the result receipt exists", () => {
    const args = { pattern: "test" };
    const ctx = context(args);
    const callComponent = fffindReceiptRenderers.renderCall(args, theme, ctx);
    assert.match(callComponent.render(80).join("\n"), /test/);

    fffindReceiptRenderers.renderResult(
      { content: [{ type: "text", text: "test.ts" }] },
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );
    assert.deepEqual(callComponent.render(80), []);
  });

  it("overrides pi-fff owned renderers for fffind and ffgrep while leaving default owned presentation unchanged", () => {
    withApexUi("1", () => installFffReceipts());
    const proto = ToolExecutionComponent.prototype as any;

    const ownFindCall = () => ({ render: () => ["OWN-FIND-CALL"], invalidate() {} });
    const ownFindResult = () => ({ render: () => ["OWN-FIND-RESULT"], invalidate() {} });
    const fffindComp = {
      toolName: FFF_FIND_TOOL,
      toolDefinition: {
        name: FFF_FIND_TOOL,
        renderCall: ownFindCall,
        renderResult: ownFindResult,
      },
    };

    // fffind MUST be overridden by Apex receipts
    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(fffindComp), fffindReceiptRenderers.renderCall);
      assert.equal(proto.getResultRenderer.call(fffindComp), fffindReceiptRenderers.renderResult);
      assert.equal(proto.getRenderShell.call(fffindComp), "self");
      assert.equal(proto.hasRendererDefinition.call(fffindComp), true);
    });

    const ownGrepCall = () => ({ render: () => ["OWN-GREP-CALL"], invalidate() {} });
    const ownGrepResult = () => ({ render: () => ["OWN-GREP-RESULT"], invalidate() {} });
    const ffgrepComp = {
      toolName: FFF_GREP_TOOL,
      toolDefinition: {
        name: FFF_GREP_TOOL,
        renderCall: ownGrepCall,
        renderResult: ownGrepResult,
      },
    };

    // ffgrep MUST be overridden by Apex receipts
    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(ffgrepComp), ffgrepReceiptRenderers.renderCall);
      assert.equal(proto.getResultRenderer.call(ffgrepComp), ffgrepReceiptRenderers.renderResult);
      assert.equal(proto.getRenderShell.call(ffgrepComp), "self");
      assert.equal(proto.hasRendererDefinition.call(ffgrepComp), true);
    });

    // Another arbitrary tool with owned presentation MUST NOT be overridden
    const otherOwnCall = () => ({ render: () => ["OTHER-CALL"], invalidate() {} });
    const otherOwnResult = () => ({ render: () => ["OTHER-RESULT"], invalidate() {} });
    const otherTool = {
      toolName: "custom_external_tool",
      toolDefinition: {
        name: "custom_external_tool",
        renderCall: otherOwnCall,
        renderResult: otherOwnResult,
      },
    };
    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(otherTool), otherOwnCall);
      assert.equal(proto.getResultRenderer.call(otherTool), otherOwnResult);
      assert.equal(proto.getRenderShell.call(otherTool), "default");
    });

    // A headless tool without overrideOwned (e.g. lsp) preserves owned presentation if provided
    const ownedLsp = {
      toolName: "lsp",
      toolDefinition: {
        name: "lsp",
        renderCall: otherOwnCall,
        renderResult: otherOwnResult,
      },
    };
    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(ownedLsp), otherOwnCall);
      assert.equal(proto.getResultRenderer.call(ownedLsp), otherOwnResult);
      assert.equal(proto.getRenderShell.call(ownedLsp), "default");
    });
  });

  it("dynamically falls back when PI_APEX_UI=0 is toggled after installation and restores on re-enable", () => {
    withApexUi("1", () => installFffReceipts());
    const proto = ToolExecutionComponent.prototype as any;

    const ownFindCall = () => ({ render: () => ["OWN-FIND-CALL"], invalidate() {} });
    const ownFindResult = () => ({ render: () => ["OWN-FIND-RESULT"], invalidate() {} });
    const fffindComp = {
      toolName: FFF_FIND_TOOL,
      toolDefinition: {
        name: FFF_FIND_TOOL,
        renderCall: ownFindCall,
        renderResult: ownFindResult,
      },
    };

    // Enabled: returns Apex receipts
    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(fffindComp), fffindReceiptRenderers.renderCall);
      assert.equal(proto.getResultRenderer.call(fffindComp), fffindReceiptRenderers.renderResult);
      assert.equal(proto.getRenderShell.call(fffindComp), "self");
      assert.equal(proto.hasRendererDefinition.call(fffindComp), true);
    });

    // Dynamically disable Apex presentation: falls back immediately to owned renderers / default shell
    const previous = process.env.PI_APEX_UI;
    try {
      process.env.PI_APEX_UI = "0";
      assert.equal(proto.getCallRenderer.call(fffindComp), ownFindCall);
      assert.equal(proto.getResultRenderer.call(fffindComp), ownFindResult);
      assert.equal(proto.getRenderShell.call(fffindComp), "default");

      const bareComp = { toolName: "bare_unregistered" };
      assert.equal(proto.getCallRenderer.call(bareComp), undefined);
      assert.equal(proto.getRenderShell.call(bareComp), "default");
      assert.equal(proto.hasRendererDefinition.call(bareComp), false);

      // Re-enable Apex presentation: immediately restores Apex receipts
      process.env.PI_APEX_UI = "1";
      assert.equal(proto.getCallRenderer.call(fffindComp), fffindReceiptRenderers.renderCall);
      assert.equal(proto.getResultRenderer.call(fffindComp), fffindReceiptRenderers.renderResult);
      assert.equal(proto.getRenderShell.call(fffindComp), "self");
      assert.equal(proto.hasRendererDefinition.call(fffindComp), true);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });

  it("preserves receipt registry and avoids stacking closures across module reloads", async () => {
    withApexUi("1", () => installFffReceipts());
    const state = getHeadlessReceiptState();
    assert.ok(state.installed);
    assert.ok(state.registry.has(FFF_FIND_TOOL));
    assert.ok(state.registry.has(FFF_GREP_TOOL));

    const moduleUrl = new URL(
      "../internal/presentation/headless-receipts.ts",
      import.meta.url,
    );
    moduleUrl.search = "fff-reload-test";
    const reloaded = await import(moduleUrl.href);

    const reloadedState = reloaded.getHeadlessReceiptState();
    assert.equal(reloadedState, (globalThis as any)[HEADLESS_STATE_KEY]);
    assert.ok(reloadedState.registry.has(FFF_FIND_TOOL));

    const probeCall = () => ({ render: () => ["PROBE CALL"], invalidate() {} });
    const probeResult = () => ({ render: () => ["PROBE RESULT"], invalidate() {} });
    reloaded.registerHeadlessReceipt("fff_reload_probe", {
      renderCall: probeCall,
      renderResult: probeResult,
    });

    // Re-running install should not stack closures or throw
    reloaded.installHeadlessReceipts();

    const proto = ToolExecutionComponent.prototype as any;
    const probeComp = {
      toolName: "fff_reload_probe",
      toolDefinition: { name: "fff_reload_probe" },
    };
    withApexUi("1", () => {
      assert.equal(proto.getCallRenderer.call(probeComp), probeCall);
      assert.equal(proto.getResultRenderer.call(probeComp), probeResult);
      assert.equal(proto.getRenderShell.call(probeComp), "self");
    });
  });

  it("suppresses legacy registered receipts when Apex is disabled after migration", () => {
    withApexUi("1", () => installFffReceipts());
    const state = getHeadlessReceiptState();
    const proto = ToolExecutionComponent.prototype as any;
    const legacyCall = state.originals.getCallRenderer;
    const legacyResult = state.originals.getResultRenderer;
    const legacyShell = state.originals.getRenderShell;
    const legacyHasRenderer = state.originals.hasRendererDefinition;

    const renderCall = () => ({ render: () => ["LEGACY CALL"], invalidate() {} });
    const renderResult = () => ({ render: () => ["LEGACY RESULT"], invalidate() {} });
    state.registry.set("legacy_headless_probe", {
      renderCall,
      renderResult,
      overrideOwned: false,
    });
    state.legacyWrapped = true;
    state.originals = {
      getCallRenderer(this: any) {
        return state.registry.get(this.toolName)?.renderCall ?? legacyCall?.call(this);
      },
      getResultRenderer(this: any) {
        return state.registry.get(this.toolName)?.renderResult ?? legacyResult?.call(this);
      },
      getRenderShell(this: any) {
        return state.registry.has(this.toolName) ? "self" : legacyShell?.call(this);
      },
      hasRendererDefinition(this: any) {
        return state.registry.has(this.toolName) || legacyHasRenderer?.call(this) || false;
      },
    };

    const probe = {
      toolName: "legacy_headless_probe",
      toolDefinition: undefined,
      builtInToolDefinition: undefined,
    };
    try {
      withApexUi("1", () => {
        assert.equal(proto.getCallRenderer.call(probe), renderCall);
        assert.equal(proto.getResultRenderer.call(probe), renderResult);
        assert.equal(proto.getRenderShell.call(probe), "self");
        assert.equal(proto.hasRendererDefinition.call(probe), true);
      });
      withApexUi("0", () => {
        assert.equal(proto.getCallRenderer.call(probe), undefined);
        assert.equal(proto.getResultRenderer.call(probe), undefined);
        assert.equal(proto.getRenderShell.call(probe), "default");
        assert.equal(proto.hasRendererDefinition.call(probe), false);
      });
    } finally {
      state.registry.delete("legacy_headless_probe");
      state.legacyWrapped = false;
      state.originals = {
        getCallRenderer: legacyCall,
        getResultRenderer: legacyResult,
        getRenderShell: legacyShell,
        hasRendererDefinition: legacyHasRenderer,
      };
    }
  });

  it("renders a real fffind ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installFffReceipts();

      const args = { pattern: "receipt", path: "src/" };
      const ownCall = () => ({ render: () => ["SHOULD NOT BE USED"], invalidate() {} });
      const ownResult = () => ({ render: () => ["SHOULD NOT BE USED"], invalidate() {} });
      const component = new ToolExecutionComponent(
        "fffind",
        "call-fff-1",
        args,
        { showImages: false },
        { name: "fffind", renderCall: ownCall, renderResult: ownResult } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [
          {
            type: "text",
            text: "src/fff-receipt.ts\nsrc/tool-receipt.ts",
          },
        ],
        details: { totalMatched: 2, totalFiles: 100 },
        isError: false,
      });

      const lines = component.render(80);
      const text = lines.join("\n");
      assert.match(text, /fffind/);
      assert.match(text, /receipt src\//);
      assert.match(text, /2 matches/);
      assert.match(text, /100 indexed/);
      assert.doesNotMatch(text, /100 files/);
      assert.match(text, /fff-receipt\.ts/);
      assert.doesNotMatch(text, /SHOULD NOT BE USED/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("renders a real ffgrep ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installFffReceipts();

      const args = { pattern: "Receipts", caseSensitive: true };
      const component = new ToolExecutionComponent(
        "ffgrep",
        "call-fff-2",
        args,
        { showImages: false },
        { name: "ffgrep", renderCall: () => {}, renderResult: () => {} } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [
          {
            type: "text",
            text: "agent/extensions/apex/apex-ui.ts\n 200: installFffReceipts();",
          },
        ],
        details: { totalMatched: 1, totalFiles: 1 },
        isError: false,
      });

      const lines = component.render(80);
      const text = lines.join("\n");
      assert.match(text, /ffgrep/);
      assert.match(text, /Receipts/);
      assert.match(text, /case-sensitive/);
      assert.match(text, /1 match/);
      assert.match(text, /1 indexed/);
      assert.doesNotMatch(text, /1 file/);
      assert.match(text, /apex-ui\.ts/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("respects terminal width bounds under various sizes", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installFffReceipts();

      const args = {
        pattern: "very_long_pattern_that_exceeds_narrow_terminals",
        path: "deeply/nested/path/to/some/source/code",
      };
      const component = new ToolExecutionComponent(
        "fffind",
        "call-fff-3",
        args,
        { showImages: false },
        { name: "fffind", renderCall: () => {}, renderResult: () => {} } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [
          {
            type: "text",
            text: "deeply/nested/path/to/some/source/code/very_long_file_name_that_should_be_truncated_properly.ts",
          },
        ],
        details: { totalMatched: 1, totalFiles: 500 },
        isError: false,
      });

      for (const width of [40, 60, 80, 120]) {
        const lines = component.render(width);
        assert.ok(lines.every((line) => safeVisibleWidth(line) <= width));
      }
    });
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previous = process.env.PI_APEX_UI;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    try {
      installFffReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});
