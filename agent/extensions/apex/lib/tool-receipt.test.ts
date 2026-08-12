import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RECEIPT_OUTPUT_CHARS,
  toolRenderers,
  type ToolRenderState,
} from "./tool-receipt.ts";
import type { ToolRenderContext } from "./ui-common.ts";

const theme = {
  fg: (_key: unknown, text: string) => text,
  bg: (_key: unknown, text: string) => text,
};

function context(
  state: ToolRenderState,
): ToolRenderContext<ToolRenderState, Record<string, never>> {
  return {
    args: {},
    invalidate() {},
    state,
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
  };
}

describe("Apex tool receipts", () => {
  it("bounds long single-line output before preview and body hooks", () => {
    const seen: number[] = [];
    const ui = toolRenderers<Record<string, never>>({
      title: "bash",
      arg: () => "python generated output",
      preview(output) {
        seen.push(output.length);
        return [output];
      },
      body(output) {
        seen.push(output.length);
        return [output];
      },
    });
    const result = {
      content: [{ type: "text", text: "x".repeat(RECEIPT_OUTPUT_CHARS * 4) }],
    };

    const collapsed = ui.renderResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      context({}),
    );
    const collapsedLines = collapsed.render(80);
    assert.ok(collapsedLines.length <= 5);
    assert.ok(collapsedLines.every((line) => line.length <= 80));

    const expanded = ui.renderResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      context({}),
    );
    const expandedLines = expanded.render(80);
    assert.ok(expandedLines.length <= 5);
    assert.ok(expandedLines.every((line) => line.length <= 80));
    assert.deepEqual(seen, [RECEIPT_OUTPUT_CHARS, RECEIPT_OUTPUT_CHARS]);
  });

  it("scrubs secrets before applying the presentation intake cap", () => {
    const secret = "SECRET-" + "z".repeat(120);
    const seen: string[] = [];
    const ui = toolRenderers<Record<string, never>>({
      title: "fetch",
      arg: () => "",
      scrub: (text) => text.replace(secret, "[redacted]"),
      preview(output) {
        seen.push(output);
        return [output];
      },
    });
    const prefix = "x".repeat(RECEIPT_OUTPUT_CHARS - 20);

    ui.renderResult(
      { content: [{ type: "text", text: `${prefix}${secret}` }] },
      { expanded: false, isPartial: false },
      theme,
      context({}),
    ).render(80);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].includes(secret), false);
    assert.equal(seen[0].endsWith("[redacted]"), true);
  });

  it("preserves ANSI styling from bounded custom body hooks", () => {
    const styled = "\x1b[31mred\x1b[0m";
    const ui = toolRenderers<Record<string, never>>({
      title: "edit",
      arg: () => "",
      body: () => [styled],
    });
    const expanded = ui.renderResult(
      { content: [{ type: "text", text: "ok" }] },
      { expanded: true, isPartial: false },
      theme,
      context({}),
    );

    assert.ok(expanded.render(72).some((line) => line.includes(styled)));
  });

  it("bounds custom hook output even when the hook ignores its input", () => {
    const ui = toolRenderers<Record<string, never>>({
      title: "custom",
      arg: () => "",
      preview: () => ["p".repeat(50_000)],
      body: () => ["b".repeat(50_000)],
    });
    const result = { content: [{ type: "text", text: "ok" }] };

    const collapsed = ui.renderResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      context({}),
    );
    assert.ok(collapsed.render(72).every((line) => line.length <= 72));

    const expanded = ui.renderResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      context({}),
    );
    const lines = expanded.render(72);
    assert.ok(lines.length <= 5);
    assert.ok(lines.every((line) => line.length <= 72));
  });

  it("processes only the configured preview-line budget", () => {
    let converted = 0;
    const preview = Array.from({ length: 10_000 }, () => ({
      toString() {
        converted++;
        return "line";
      },
    }));
    const ui = toolRenderers<Record<string, never>>({
      title: "custom",
      arg: () => "",
      previewLines: 2,
      preview: () => preview as unknown as string[],
    });

    ui.renderResult(
      { content: [{ type: "text", text: "ok" }] },
      { expanded: false, isPartial: false },
      theme,
      context({}),
    ).render(72);

    assert.equal(converted, 2);
  });
});
