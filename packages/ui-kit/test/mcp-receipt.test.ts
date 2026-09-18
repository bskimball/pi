import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "@pi/ui-kit/internal/presentation/safe-text-layout.ts";
import {
  getHeadlessReceiptState,
  registerHeadlessReceipt,
  resolveLiveBundleEntryUrl,
  shouldAttachApexReceipts,
  wrapToolExecutionPrototype,
} from "@pi/ui-kit/internal/presentation/headless-receipts.ts";
import {
  MCP_SCHEMA_SENTINEL,
  MCP_TOOL,
  compactMcpArgs,
  installMcpReceipts,
  mcpReceiptArg,
  mcpReceiptRenderers,
  mcpScriptReceiptArg,
  mcpScriptReceiptRenderers,
} from "@pi/ui-kit/internal/presentation/mcp-receipt.ts";

const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
  inverse: (text: string) => text,
};

function context(args: any): any {
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

describe("apex mcp receipts", () => {
  it("formats compact header arguments per gateway mode", () => {
    assert.equal(mcpReceiptArg({}, 80), "status");
    assert.equal(
      mcpReceiptArg({ search: "snapshot", server: "chrome-devtools" }, 80),
      "search snapshot @ chrome-devtools",
    );
    assert.equal(
      mcpReceiptArg(
        { tool: "list_tabs", server: "chrome-devtools", args: { max: 5 } },
        80,
      ),
      'call list_tabs @ chrome-devtools {"max":5}',
    );
    assert.equal(mcpReceiptArg({ connect: "linear" }, 80), "connect linear");
    assert.equal(
      mcpReceiptArg({ describe: "chrome-devtools/list_tabs" }, 80),
      "describe chrome-devtools/list_tabs",
    );
    assert.equal(
      mcpReceiptArg({ action: "auth-start", server: "linear" }, 80),
      "auth-start linear",
    );
    assert.equal(mcpReceiptArg({ server: "chrome-devtools" }, 80), "list chrome-devtools");
  });

  it("compacts JSON-ish args without dumping multiline objects", () => {
    assert.equal(compactMcpArgs({ query: "pi" }, 80), '{"query":"pi"}');
    assert.equal(compactMcpArgs('{"query":"pi"}', 80), '{"query":"pi"}');
    assert.doesNotMatch(compactMcpArgs({ a: 1, b: 2 }, 80), /\n/);
  });

  it("formats mcpScript as the first statement plus extra line count", () => {
    assert.equal(
      mcpScriptReceiptArg({ code: "emit(await tools.search({ query: \"tabs\" }))" }, 80),
      'emit(await tools.search({ query: "tabs" }))',
    );
    assert.equal(
      mcpScriptReceiptArg(
        { code: "const a = 1;\nemit(a);", timeoutMs: 5000 },
        80,
      ),
      "const a = 1; +1 line 5000ms",
    );
  });

  it("renders an Apex receipt instead of boxed JSON args", () => {
    const args = { search: "snapshot" };
    const ctx = context(args);
    const call = mcpReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /mcp/);
    assert.match(call, /search snapshot/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
    assert.doesNotMatch(call, /"search"/);

    const rendered = mcpReceiptRenderers
      .renderResult(
        {
          content: [{ type: "text", text: "1. chrome-devtools/take_snapshot" }],
          details: { mode: "search" },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      )
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /mcp/);
    assert.match(text, /search/);
    assert.match(text, /take_snapshot/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(rendered.every((line: string) => safeVisibleWidth(line) <= 80));
  });

  it("overrides adapter-owned mcp presentation when Apex is on", () => {
    withApexUi("1", () => {
      installMcpReceipts();
      const proto = ToolExecutionComponent.prototype as any;
      const owned = {
        toolName: MCP_TOOL,
        toolDefinition: {
          name: MCP_TOOL,
          renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderResult: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderShell: "self",
        },
      };
      assert.equal(
        proto.getCallRenderer.call(owned),
        mcpReceiptRenderers.renderCall,
      );
      assert.equal(
        proto.getResultRenderer.call(owned),
        mcpReceiptRenderers.renderResult,
      );
      assert.equal(proto.getRenderShell.call(owned), "self");
    });
  });

  it("renders a real mcp ToolExecutionComponent as an Apex receipt", () => {
    initTheme("dark");
    withApexUi("1", () => {
      installMcpReceipts();

      const args = { tool: "list_pages", server: "chrome-devtools" };
      const component = new ToolExecutionComponent(
        MCP_TOOL,
        "call-1",
        args,
        { showImages: false },
        {
          name: MCP_TOOL,
          renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderResult: () => ({ render: () => ["OWN"], invalidate() {} }),
        } as any,
        stubUi() as any,
        process.cwd(),
      );
      component.markExecutionStarted();
      component.updateResult({
        content: [{ type: "text", text: "pages: Example" }],
        details: { mode: "call", server: "chrome-devtools", tool: "list_pages" },
        isError: false,
      });

      const lines = component.render(80);
      const text = lines.join("\n");
      assert.match(text, /mcp/);
      assert.match(text, /list_pages/);
      assert.match(text, /pages: Example/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.doesNotMatch(text, /^OWN$/m);
      assert.match(text, /mcp/);
      assert.ok(lines.every((line) => safeVisibleWidth(line) <= 80));
    });
  });

  it("renders mcpScript as an Apex receipt", () => {
    const args = { code: "emit(1)" };
    const ctx = context(args);
    const call = mcpScriptReceiptRenderers
      .renderCall(args, theme, ctx)
      .render(80)
      .join("\n");
    assert.match(call, /mcpScript/);
    assert.match(call, /emit\(1\)/);
    assert.doesNotMatch(call, /┌|┐|└|┘/);
  });

  it("skips the wrap when PI_APEX_UI=0", () => {
    const previousApex = process.env.PI_APEX_UI;
    const previousChrome = process.env.PI_UI_CHROME;
    const proto = ToolExecutionComponent.prototype as any;
    const before = proto.getCallRenderer;
    process.env.PI_APEX_UI = "0";
    process.env.PI_UI_CHROME = "0";
    try {
      installMcpReceipts();
      assert.equal(proto.getCallRenderer, before);
    } finally {
      if (previousApex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previousApex;
      if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
      else process.env.PI_UI_CHROME = previousChrome;
    }
  });

  it("routes mcp__<server> proxies to server-aware kit renderers", () => {
    withApexUi("1", () => {
      installMcpReceipts();
      const proto = ToolExecutionComponent.prototype as any;
      const proxyOwned = {
        toolName: "mcp__BLI400C",
        toolDefinition: {
          name: "mcp__BLI400C",
          renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderResult: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderShell: "self",
        },
      };
      const first = proto.getCallRenderer.call(proxyOwned);
      const second = proto.getCallRenderer.call(proxyOwned);
      // Factory-built, memoized per tool name: stable identity, not the
      // gateway object, and the adapter's owned chrome is displaced.
      assert.equal(first, second);
      assert.notEqual(first, mcpReceiptRenderers.renderCall);
      assert.notEqual(
        proto.getResultRenderer.call(proxyOwned),
        proxyOwned.toolDefinition.renderResult,
      );
      assert.equal(proto.getRenderShell.call(proxyOwned), "self");
    });
  });

  it("renders @ <server> on proxy call headers from the tool name", () => {
    withApexUi("1", () => {
      installMcpReceipts();
      const proto = ToolExecutionComponent.prototype as any;
      const proxyOwned = {
        toolName: "mcp__BLI400C",
        toolDefinition: {
          name: "mcp__BLI400C",
          renderCall: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderResult: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderShell: "self",
        },
      };
      const renderCall = proto.getCallRenderer.call(proxyOwned);
      const header = renderCall(
        { tool: "plan_run_ibmi_command" },
        theme,
        context({ tool: "plan_run_ibmi_command" }),
      )
        .render(100)
        .join("\n");
      assert.match(header, /plan_run_ibmi_command @ BLI400C/);
    });
  });

  it("leaves the gateway mcp call header unchanged", () => {
    const header = mcpReceiptRenderers
      .renderCall(
        { tool: "list_tabs", server: "chrome-devtools", args: { max: 5 } },
        theme,
        context({ tool: "list_tabs", server: "chrome-devtools" }),
      )
      .render(100)
      .join("\n");
    assert.match(header, /call list_tabs @ chrome-devtools/);
  });

  it("prefers an explicit args server over the proxy name fallback", () => {
    withApexUi("1", () => {
      installMcpReceipts();
      const proto = ToolExecutionComponent.prototype as any;
      const proxyOwned = {
        toolName: "mcp__BLI400C",
        toolDefinition: { name: "mcp__BLI400C" },
      };
      const renderCall = proto.getCallRenderer.call(proxyOwned);
      const header = renderCall(
        { tool: "inspect", server: "OTHER" },
        theme,
        context({ tool: "inspect", server: "OTHER" }),
      )
        .render(100)
        .join("\n");
      assert.match(header, /inspect @ OTHER/);
      assert.doesNotMatch(header, /BLI400C/);
    });
  });

  it("prefers exact keys over prefix matchers", () => {
    withApexUi("1", () => {
      installMcpReceipts();
      const exactCall = () => ({ render: () => ["EXACT"], invalidate() {} });
      const exactResult = () => ({ render: () => ["EXACT"], invalidate() {} });
      registerHeadlessReceipt(
        "mcp__probe",
        { renderCall: exactCall, renderResult: exactResult },
        { overrideOwned: true },
      );
      const decided = shouldAttachApexReceipts({
        toolName: "mcp__probe",
        toolDefinition: {
          renderCall: () => ({}),
          renderResult: () => ({}),
        },
      });
      assert.equal(decided?.renderCall, exactCall);
      assert.equal(decided?.renderResult, exactResult);
    });
  });

  it("matches only mcp-family tool names", () => {
    withApexUi("1", () => {
      installMcpReceipts();
      assert.equal(
        shouldAttachApexReceipts({ toolName: "mcp" })?.renderCall,
        mcpReceiptRenderers.renderCall,
      );
      assert.equal(
        shouldAttachApexReceipts({ toolName: "mcp__BLI400C" })?.renderCall,
        shouldAttachApexReceipts({ toolName: "mcp__BLI400C" })?.renderCall,
      );
      assert.notEqual(
        shouldAttachApexReceipts({ toolName: "mcp__BLI400C" })?.renderCall,
        undefined,
      );
      assert.equal(
        shouldAttachApexReceipts({ toolName: "mcpScript" })?.renderCall,
        mcpScriptReceiptRenderers.renderCall,
      );
      assert.equal(shouldAttachApexReceipts({ toolName: "bash" }), undefined);
      assert.equal(
        shouldAttachApexReceipts({ toolName: "BLI400C_plan_run_ibmi_command" }),
        undefined,
      );
    });
  });

  it("splits error text into a bounded message plus a bounded schema section", () => {
    const schemaLines = Array.from(
      { length: 60 },
      (_, i) => `  param${i} (string) - description for parameter ${i}`,
    );
    const text =
      "Error: DSPDEVD is an interactive display command and cannot run here." +
      `\n\n${MCP_SCHEMA_SENTINEL}\n${schemaLines.join("\n")}`;
    const args = { tool: "plan_run_ibmi_command", server: "BLI400C" };
    const result = {
      content: [{ type: "text", text }],
      details: {
        mode: "call",
        server: "BLI400C",
        tool: "plan_run_ibmi_command",
        error: "tool_error",
      },
    };

    const expanded = mcpReceiptRenderers
      .renderResult(result, { expanded: true, isPartial: false }, theme, context(args))
      .render(80);
    const out = expanded.join("\n");
    assert.match(out, /DSPDEVD/);
    assert.equal(
      out.split("\n").filter((line: string) => line.includes(MCP_SCHEMA_SENTINEL)).length,
      1,
    );
    assert.match(out, /param0/);
    assert.doesNotMatch(out, /param59/);
    assert.match(out, /\.\.\. \d+\+ more lines/);
    // 60-line schema input collapses to message + label + ~24 schema lines.
    assert.ok(expanded.length < 40);
    assert.ok(expanded.every((line: string) => safeVisibleWidth(line) <= 80));

    const collapsed = mcpReceiptRenderers
      .renderResult(result, { expanded: false, isPartial: false }, theme, context(args))
      .render(80);
    const collapsedText = collapsed.join("\n");
    assert.match(collapsedText, /DSPDEVD/);
    assert.doesNotMatch(collapsedText, /param0/);
  });

  it("leaves results without the schema sentinel unchanged", () => {
    const args = { tool: "list_pages", server: "chrome-devtools" };
    const result = {
      content: [{ type: "text", text: "pages: Example\nsecond line" }],
      details: { mode: "call", server: "chrome-devtools", tool: "list_pages" },
    };
    const rendered = mcpReceiptRenderers
      .renderResult(result, { expanded: true, isPartial: false }, theme, context(args))
      .render(80);
    const out = rendered.join("\n");
    assert.match(out, /pages: Example/);
    assert.match(out, /second line/);
    assert.doesNotMatch(out, new RegExp(MCP_SCHEMA_SENTINEL));
  });

  it("yields no chrome for namespace proxies when PI_APEX_UI=0", () => {
    withApexUi("0", () => {
      installMcpReceipts();
      const ownedCall = () => ({ render: () => ["OWN"], invalidate() {} });
      const proto = ToolExecutionComponent.prototype as any;
      const proxyOwned = {
        toolName: "mcp__BLI400C",
        toolDefinition: {
          name: "mcp__BLI400C",
          renderCall: ownedCall,
          renderResult: () => ({ render: () => ["OWN"], invalidate() {} }),
          renderShell: "self",
        },
      };
      assert.equal(proto.getCallRenderer.call(proxyOwned), ownedCall);
      assert.equal(
        shouldAttachApexReceipts({ toolName: "mcp__BLI400C" }),
        undefined,
      );
    });
  });

  it("wraps a second ToolExecutionComponent copy (bundled live TUI class)", () => {
    withApexUi("1", () => {
      installMcpReceipts();
      // Stand-in for the bundled copy the live TUI instantiates: same getter
      // shape as core, distinct prototype object the primary wrap never sees.
      class BundledCopy {
        toolName?: string;
        toolDefinition?: any;
        constructor(name: string, definition: any) {
          this.toolName = name;
          this.toolDefinition = definition;
        }
        getCallRenderer() {
          return this.toolDefinition?.renderCall;
        }
        getResultRenderer() {
          return this.toolDefinition?.renderResult;
        }
        getRenderShell() {
          return this.toolDefinition?.renderShell ?? "default";
        }
        hasRendererDefinition() {
          return this.toolDefinition !== undefined;
        }
      }
      const bundleProto = BundledCopy.prototype as any;
      assert.equal(wrapToolExecutionPrototype(bundleProto), true);
      const ownedCall = () => ({ render: () => ["OWN"], invalidate() {} });
      const ownedResult = () => ({ render: () => ["OWN"], invalidate() {} });
      const component = new BundledCopy("mcp__BLI400A", {
        name: "mcp__BLI400A",
        renderCall: ownedCall,
        renderResult: ownedResult,
        renderShell: "self",
      });
      // overrideOwned receipts beat the adapter-owned renderers on the live
      // copy too — before the two-copy fix this returned the owned renderers.
      // (Proxy names resolve to memoized per-server renderers, so compare
      // against the registry decision, not the gateway singleton.)
      const decided = shouldAttachApexReceipts({
        toolName: "mcp__BLI400A",
        toolDefinition: {
          renderCall: ownedCall,
          renderResult: ownedResult,
        },
      });
      assert.ok(decided);
      assert.equal(
        bundleProto.getCallRenderer.call(component),
        decided.renderCall,
      );
      assert.equal(
        bundleProto.getResultRenderer.call(component),
        decided.renderResult,
      );
      assert.equal(bundleProto.getRenderShell.call(component), "self");
      assert.equal(bundleProto.hasRendererDefinition.call(component), true);
    });
  });

  it("wraps the genuine bundled copy via the real install path", async (t) => {
    const bundleUrl = resolveLiveBundleEntryUrl();
    if (!bundleUrl) {
      t.skip("no bundled core entry in this install");
      return;
    }
    const previousApex = process.env.PI_APEX_UI;
    const previousChrome = process.env.PI_UI_CHROME;
    process.env.PI_APEX_UI = "1";
    process.env.PI_UI_CHROME = "1";
    try {
      installMcpReceipts(); // kicks the fire-and-forget bundle patch
      const state = getHeadlessReceiptState();
      const deadline = Date.now() + 3000;
      while (state.liveBundle === "pending" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Fails if the install path stops reaching the live copy.
      assert.equal(state.liveBundle, "patched");
      const live = (await import(bundleUrl) as any).ToolExecutionComponent;
      const liveProto = live.prototype;
      const ownedCall = () => ({ render: () => ["OWN"], invalidate() {} });
      const ownedResult = () => ({ render: () => ["OWN"], invalidate() {} });
      const component = {
        toolName: "mcp__BLI400A",
        toolDefinition: {
          name: "mcp__BLI400A",
          renderCall: ownedCall,
          renderResult: ownedResult,
          renderShell: "self",
        },
      };
      const decided = shouldAttachApexReceipts(component as any);
      assert.ok(decided);
      assert.equal(
        liveProto.getCallRenderer.call(component),
        decided.renderCall,
      );
      assert.equal(
        liveProto.getResultRenderer.call(component),
        decided.renderResult,
      );
    } finally {
      if (previousApex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previousApex;
      if (previousChrome === undefined) delete process.env.PI_UI_CHROME;
      else process.env.PI_UI_CHROME = previousChrome;
    }
  });
});
