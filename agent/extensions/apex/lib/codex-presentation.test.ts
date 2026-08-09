import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  codexToolTitle,
  formatCodexArgSummary,
  installCodexPresentation,
  isCodexToolDefinition,
} from "./codex-presentation.ts";
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

const plainTheme = {
  fg: (_key: unknown, text: string) => text,
  bg: (_key: unknown, text: string) => text,
};

function fakeContext(args: unknown, overrides: Record<string, unknown> = {}) {
  return {
    args,
    invalidate: () => {},
    state: {},
    cwd: "c:/repo",
    executionStarted: false,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  } as any;
}

describe("codex presentation", () => {
  it("recognizes the exact Codex conversion tool names only", () => {
    for (const name of [
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
      "web_run",
      "imagegen",
    ]) {
      assert.equal(isCodexToolDefinition({ name } as any), true);
    }
    assert.equal(isCodexToolDefinition({ name: "bash" } as any), false);
    assert.equal(isCodexToolDefinition({ name: "mcpScript" } as any), false);
    assert.equal(isCodexToolDefinition({ name: "exec_command2" } as any), false);
    // Code Mode tools are a separate dormant surface.
    assert.equal(isCodexToolDefinition({ name: "exec" } as any), false);
    assert.equal(isCodexToolDefinition({ name: "wait" } as any), false);
  });

  it("titles Codex tools with spaced names", () => {
    assert.equal(codexToolTitle({ name: "exec_command" } as any), "exec command");
    assert.equal(codexToolTitle({ name: "apply_patch" } as any), "apply patch");
    assert.equal(codexToolTitle({ name: "web_run" } as any), "web run");
  });

  it("summarizes exec_command by cmd only", () => {
    assert.equal(
      formatCodexArgSummary(
        { cmd: "git status --short", workdir: "c:/repo" },
        120,
        "exec_command",
      ),
      "git status --short",
    );
    assert.equal(
      formatCodexArgSummary(JSON.stringify({ cmd: "npm test" }), 120, "exec_command"),
      "npm test",
    );
    assert.equal(
      formatCodexArgSummary({ workdir: "c:/repo" }, 120, "exec_command"),
      "",
    );
  });

  it("summarizes write_stdin by session and short input", () => {
    assert.equal(
      formatCodexArgSummary({ session_id: 3, chars: "ls\n" }, 120, "write_stdin"),
      "session 3 ls",
    );
    assert.equal(
      formatCodexArgSummary({ session_id: 4 }, 120, "write_stdin"),
      "session 4",
    );
    assert.equal(formatCodexArgSummary({}, 120, "write_stdin"), "");
  });

  it("summarizes apply_patch by target files without patch text", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "*** End Patch",
    ].join("\n");
    const summary = formatCodexArgSummary({ input: patch }, 120, "apply_patch");
    assert.equal(summary, "2 files (src/a.ts, …)");
    assert.equal(summary.includes("-old"), false);
    assert.equal(summary.includes("+new"), false);

    const single = "*** Begin Patch\n*** Delete File: src/c.ts\n*** End Patch";
    assert.equal(
      formatCodexArgSummary({ input: single }, 120, "apply_patch"),
      "src/c.ts",
    );
    // No recognizable targets: fall back to a line count, never the source.
    assert.equal(
      formatCodexArgSummary({ input: "garbage\npayload" }, 120, "apply_patch"),
      "patch 2 lines",
    );
    assert.equal(formatCodexArgSummary({ input: "" }, 120, "apply_patch"), "");
  });

  it("summarizes view_image, imagegen, and web_run by primary arg", () => {
    assert.equal(
      formatCodexArgSummary({ path: "assets/logo.png" }, 120, "view_image"),
      "assets/logo.png",
    );
    assert.equal(
      formatCodexArgSummary({ prompt: "a shark" }, 120, "imagegen"),
      "a shark",
    );
    assert.equal(
      formatCodexArgSummary(
        { search_query: [{ q: "pi tui" }, { q: "apex" }] },
        120,
        "web_run",
      ),
      "pi tui",
    );
    assert.equal(
      formatCodexArgSummary({ open: [{ ref_id: "u1" }] }, 120, "web_run"),
      "open 1 ref",
    );
  });

  it("handles bare strings and bounds the summary to the width budget", () => {
    assert.equal(
      formatCodexArgSummary("raw command text", 120, "exec_command"),
      "raw command text",
    );
    const summary = formatCodexArgSummary(
      { cmd: "x".repeat(500) },
      24,
      "exec_command",
    );
    assert.ok(safeVisibleWidth(summary) <= 24);
    const patchSummary = formatCodexArgSummary(
      { input: "*** Begin Patch\n*** Update File: very/long/path/name.ts\n*** End Patch" },
      16,
      "apply_patch",
    );
    assert.ok(safeVisibleWidth(patchSummary) <= 16);
  });

  it("install wrapper replaces Codex custom renderers with Apex receipts", () => {
    const { pi, registered } = fakeApi();
    installCodexPresentation(pi as any);
    const originalRenderCall = () => "package-chrome";
    const def = {
      name: "exec_command",
      label: "exec_command",
      renderCall: originalRenderCall,
      renderResult: () => "package-chrome",
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    pi.registerTool(def as any);
    assert.equal(registered.length, 1);
    const wrapped = registered[0];
    assert.notEqual(wrapped, def);
    assert.equal(wrapped.name, "exec_command");
    assert.equal(wrapped.renderShell, "self");
    assert.equal(typeof wrapped.renderCall, "function");
    assert.notEqual(wrapped.renderCall, originalRenderCall);
    assert.equal(typeof wrapped.renderResult, "function");
    // Execution and schema pass through unchanged.
    assert.equal(wrapped.execute, def.execute);
  });

  it("leaves unrelated self-rendered definitions untouched", () => {
    const { pi, registered } = fakeApi();
    installCodexPresentation(pi as any);
    const custom = {
      name: "custom_thing",
      renderCall: () => "custom",
      renderResult: () => "custom",
    };
    const alreadyApex = {
      name: "apply_patch",
      renderShell: "self",
      renderCall: () => "apex",
    };
    pi.registerTool(custom as any);
    pi.registerTool(alreadyApex as any);
    assert.equal(registered.length, 2);
    assert.equal(registered[0], custom);
    assert.equal(registered[1], alreadyApex);
  });

  it("renders a bounded Apex receipt instead of package chrome", () => {
    const { pi, registered } = fakeApi();
    installCodexPresentation(pi as any);
    pi.registerTool({
      name: "exec_command",
      renderCall: () => "package-chrome",
      renderResult: () => "package-chrome",
    } as any);
    const wrapped = registered[0];

    const args = { cmd: "git status --short" };
    const call = wrapped.renderCall(args, plainTheme, fakeContext(args));
    const callLines = call.render(80);
    assert.equal(callLines.length, 1);
    assert.equal(callLines[0].includes("exec command"), true);
    assert.equal(callLines[0].includes("git status --short"), true);
    assert.ok(safeVisibleWidth(callLines[0]) <= 80);

    const context = fakeContext(args);
    const longOutput = Array.from({ length: 50 }, (_, i) => `row ${i}`).join(
      "\n",
    );
    const result = wrapped.renderResult(
      { content: [{ type: "text", text: longOutput }] },
      { expanded: false, isPartial: false },
      plainTheme,
      context,
    );
    const lines = result.render(60);
    // Header + at most 3 rail-indented preview lines: bounded and passive.
    assert.ok(lines.length <= 5);
    assert.equal(lines[0].includes("exec command"), true);
    for (const line of lines) {
      assert.ok(safeVisibleWidth(line) <= 60);
    }
    // The receipt is a plain StableText component, not pi-tui Text/Container.
    assert.equal(wrapped.renderResult.constructor.name, "Function");
    assert.equal(typeof lines[0], "string");
  });
});
