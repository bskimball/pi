import assert from "node:assert/strict";
import { describe, it } from "node:test";
import powershell, { formatPowerShellCommand } from "../powershell.ts";

function registeredTool(): any {
  let tool: any;
  powershell({
    registerTool(definition: any) {
      tool = definition;
    },
    on() {},
  } as any);
  return tool;
}

const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
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

describe("powershell receipt", () => {
  it("renders through the shared Apex receipt", () => {
    const tool = registeredTool();
    assert.equal(tool.name, "powershell");
    assert.equal(tool.renderShell, "self");
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");

    const args = { command: "Get-Service -Name W32Time" };
    const ctx = context(args);
    const call = tool.renderCall(args, theme, ctx).render(80).join("\n");
    assert.match(call, /powershell Get-Service -Name W32Time/);

    const result = {
      content: [{ type: "text", text: "Running  W32Time  Windows Time" }],
      details: { exitCode: 0 },
    };
    const rendered = tool
      .renderResult(result, { expanded: false, isPartial: false }, theme, ctx)
      .render(80);
    // Header + bounded rail preview, never the raw multi-line dump.
    assert.match(rendered[0], /powershell/);
    assert.ok(rendered.length <= 4);
    assert.ok(rendered.every((line: string) => line.length <= 80));
    assert.match(rendered.join("\n"), /W32Time/);
  });

  it("summarizes multi-line scripts within the width budget", () => {
    const script = [
      "$services = Get-Service",
      "$services | Where-Object Status -eq 'Running'",
      "$services.Count",
    ].join("\n");
    const summary = formatPowerShellCommand(script, 60);
    assert.match(summary, /^\$services = Get-Service \+2 lines$/);
    assert.ok(summary.length <= 60);
    assert.ok(!summary.includes("\n"));

    const long = formatPowerShellCommand("Get-ChildItem " + "x".repeat(400), 40);
    assert.ok(long.length <= 40);
    assert.ok(formatPowerShellCommand("a\nb", 8).length <= 8);
    assert.ok(formatPowerShellCommand("abcdef", 1).length <= 1);
    assert.equal(formatPowerShellCommand("a", 0), "");
    assert.equal(formatPowerShellCommand("   ", 40), "");
  });
});
