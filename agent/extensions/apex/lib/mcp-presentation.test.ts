import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatMcpArgSummary,
  installMcpPresentation,
  isMcpToolDefinition,
  mcpToolTitle,
} from "./mcp-presentation.ts";
import { safeVisibleWidth } from "./safe-text-layout.ts";

function fakeApi() {
  const registered: any[] = [];
  const pi = {
    registerTool(def: any) {
      registered.push(def);
      return def;
    },
  };
  return { pi, registered };
}

describe("mcp presentation", () => {
  it("recognizes mcpScript and preserves existing MCP cases", () => {
    assert.equal(isMcpToolDefinition({ name: "mcpScript" } as any), true);
    assert.equal(isMcpToolDefinition({ name: "mcp" } as any), true);
    assert.equal(
      isMcpToolDefinition({ name: "x", label: "MCP: server/tool" } as any),
      true,
    );
    assert.equal(
      isMcpToolDefinition({ name: "mcp__github_search" } as any),
      true,
    );
    assert.equal(isMcpToolDefinition({ name: "mcp_server_tool" } as any), true);
    assert.equal(isMcpToolDefinition({ name: "bash" } as any), false);
    assert.equal(isMcpToolDefinition({ name: "read" } as any), false);
    assert.equal(isMcpToolDefinition({ name: "mcpScript2" } as any), false);
  });

  it("titles mcpScript exactly and keeps existing titles", () => {
    assert.equal(mcpToolTitle({ name: "mcpScript" } as any, {}), "mcp script");
    assert.equal(
      mcpToolTitle({ name: "mcp" } as any, { server: "s", tool: "t" }),
      "mcp s/t",
    );
    assert.equal(mcpToolTitle({ name: "mcp" } as any, {}), "mcp");
    assert.equal(
      mcpToolTitle({ name: "mcp__github_search" } as any, {}),
      "mcp github/search",
    );
  });

  it("summarizes mcpScript by code line count without source", () => {
    const code = [
      "const rows = await ctx.query('select 1');",
      "const total = rows.length;",
      "console.log(`total=${total}`);",
      "return total;",
    ].join("\n");
    const summary = formatMcpArgSummary({ code }, 120, "mcpScript");
    assert.equal(summary, "code 4 lines");
    assert.equal(summary.includes("console"), false);
    assert.equal(summary.includes("query"), false);
    assert.equal(summary.includes("total"), false);
  });

  it("counts a single-line script and appends only valid timeouts", () => {
    assert.equal(
      formatMcpArgSummary(
        { code: "console.log('secret-token-value')", timeoutMs: 5000 },
        120,
        "mcpScript",
      ),
      "code 1 line timeout=5000ms",
    );
    assert.equal(
      formatMcpArgSummary({ code: "a\nb", timeoutMs: 0 }, 120, "mcpScript"),
      "code 2 lines",
    );
    for (const timeoutMs of [-5, Number.NaN, Infinity, "5000"]) {
      const summary = formatMcpArgSummary(
        { code: "x", timeoutMs },
        120,
        "mcpScript",
      );
      assert.equal(summary, "code 1 line");
      assert.equal(summary.includes("timeout"), false);
    }
  });

  it("ignores sub-1 timeoutMs and floors valid fractional values", () => {
    // Positive fractions below the adapter minimum (1ms) are ignored.
    const subOne = formatMcpArgSummary(
      { code: "x", timeoutMs: 0.5 },
      120,
      "mcpScript",
    );
    assert.equal(subOne, "code 1 line");
    assert.equal(subOne.includes("timeout"), false);
    // Finite values >= 1 display the runtime-normalized integer.
    assert.equal(
      formatMcpArgSummary({ code: "x", timeoutMs: 1.9 }, 120, "mcpScript"),
      "code 1 line timeout=1ms",
    );
    assert.equal(
      formatMcpArgSummary({ code: "x", timeoutMs: 5000.7 }, 120, "mcpScript"),
      "code 1 line timeout=5000ms",
    );
  });

  it("ignores the unsupported `timeout` argument", () => {
    const bare = formatMcpArgSummary(
      { code: "x", timeout: 5000 },
      120,
      "mcpScript",
    );
    assert.equal(bare, "code 1 line");
    assert.equal(bare.includes("timeout"), false);
    // A valid `timeoutMs` still wins when both keys are present.
    assert.equal(
      formatMcpArgSummary(
        { code: "x", timeout: 9999, timeoutMs: 250 },
        120,
        "mcpScript",
      ),
      "code 1 line timeout=250ms",
    );
  });

  it("handles empty, missing, and JSON-string mcpScript args", () => {
    assert.equal(formatMcpArgSummary({}, 120, "mcpScript"), "code 0 lines");
    assert.equal(formatMcpArgSummary(undefined, 120, "mcpScript"), "");
    assert.equal(formatMcpArgSummary("not json", 120, "mcpScript"), "");
    assert.equal(
      formatMcpArgSummary(
        JSON.stringify({ code: "const a = 1;\nconsole.log(a);", timeoutMs: 250 }),
        120,
        "mcpScript",
      ),
      "code 2 lines timeout=250ms",
    );
  });

  it("bounds the mcpScript summary to the width budget", () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i};`).join(
      "\n",
    );
    const summary = formatMcpArgSummary(
      { code, timeoutMs: 5000 },
      16,
      "mcpScript",
    );
    assert.ok(safeVisibleWidth(summary) <= 16);
    assert.equal(summary.includes("line 5;"), false);
  });

  it("keeps the generic summary path for other tools", () => {
    assert.equal(
      formatMcpArgSummary({ server: "s", tool: "t", args: { q: "hi" } }),
      "q=hi",
    );
    assert.equal(formatMcpArgSummary(undefined), "");
    assert.equal(formatMcpArgSummary([1, 2, 3]), "[3]");
  });

  it("install wrapper replaces renderers for mcpScript", () => {
    const { pi, registered } = fakeApi();
    installMcpPresentation(pi as any);
    const originalRenderCall = () => "original";
    const def = {
      name: "mcpScript",
      label: "mcpScript",
      renderCall: originalRenderCall,
      renderResult: () => "original",
    };
    pi.registerTool(def as any);
    assert.equal(registered.length, 1);
    const wrapped = registered[0];
    assert.notEqual(wrapped, def);
    assert.equal(wrapped.name, "mcpScript");
    assert.equal(wrapped.renderShell, "self");
    assert.equal(typeof wrapped.renderCall, "function");
    assert.notEqual(wrapped.renderCall, originalRenderCall);
    assert.equal(typeof wrapped.renderResult, "function");
  });

  it("passes non-MCP and self-rendered definitions through untouched", () => {
    const { pi, registered } = fakeApi();
    installMcpPresentation(pi as any);
    const plain = { name: "bash", renderCall: () => "plain" };
    const selfRendered = {
      name: "mcpScript",
      renderShell: "self",
      renderCall: () => "self",
    };
    pi.registerTool(plain as any);
    pi.registerTool(selfRendered as any);
    assert.equal(registered.length, 2);
    assert.equal(registered[0].renderShell, undefined);
    assert.equal(registered[0], plain);
    assert.equal(registered[1], selfRendered);
    assert.equal(registered[1].renderCall, selfRendered.renderCall);
  });
});
