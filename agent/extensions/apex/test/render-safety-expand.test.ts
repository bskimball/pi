import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import {
  SAFE_RENDER_MAX_LINES,
  SAFE_TEXT_MAX_CHARS,
  installRenderSafety,
  normalizeRenderedLines,
} from "../internal/presentation/render-safety.ts";

describe("apex expand-all render safety", () => {
  it("caps compositor line arrays so ctrl+o cannot dump unbounded output", () => {
    const rows = Array.from({ length: 800 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
    const normalized = normalizeRenderedLines(rows);
    assert.equal(normalized.length, SAFE_RENDER_MAX_LINES + 1);
    assert.match(normalized.at(-1) ?? "", /truncated for display/);
  });

  it("caps a single pathological tool row before it reaches the compositor", () => {
    const huge = "x".repeat(1_000_000);
    const normalized = normalizeRenderedLines([huge]);
    assert.equal(normalized.length, 2);
    assert.ok((normalized[0] ?? "").length <= SAFE_TEXT_MAX_CHARS);
    assert.match(normalized.at(-1) ?? "", /truncated for display/);
  });

  it("caps Text and Markdown payloads before the compositor measures them", () => {
    installRenderSafety();
    const huge = Array.from({ length: 400 }, (_, i) => `row ${i} ${"m".repeat(80)}`).join("\n");
    assert.ok(huge.length > SAFE_TEXT_MAX_CHARS);

    const text = new Text(huge);
    const textLines = text.render(80);
    assert.ok(textLines.length <= SAFE_RENDER_MAX_LINES + 1);
    assert.match(textLines.join("\n"), /truncated for display/);

    const identity = (t: string) => t;
    const markdown = new Markdown(huge, 0, 0, {
      heading: identity,
      link: identity,
      linkUrl: identity,
      code: identity,
      codeBlock: identity,
      codeBlockBorder: identity,
      quote: identity,
      quoteBorder: identity,
      hr: identity,
      listBullet: identity,
      bold: identity,
      italic: identity,
      strikethrough: identity,
      underline: identity,
    });
    const mdLines = markdown.render(80);
    assert.ok(mdLines.length <= SAFE_RENDER_MAX_LINES + 1);
    assert.match(mdLines.join("\n"), /truncated for display/);
  });

  it("caps stock tool fallback rows after expand-all", () => {
    installRenderSafety();
    initTheme("dark");
    const huge = Array.from(
      { length: 400 },
      (_, i) => `row ${i} ${"m".repeat(80)}`,
    ).join("\n");
    const component = new ToolExecutionComponent(
      "unknown_expand_probe",
      "call-expand-1",
      {},
      { showImages: false },
      undefined as any,
      { requestRender() {} } as any,
      process.cwd(),
    );
    component.updateResult({
      content: [{ type: "text", text: huge }],
      isError: false,
    });
    component.setExpanded(true);
    const lines = component.render(80);
    assert.ok(lines.length <= SAFE_RENDER_MAX_LINES + 1);
    assert.match(lines.at(-1) ?? "", /truncated for display|output truncated/);

    const oneRow = new ToolExecutionComponent(
      "unknown_expand_probe",
      "call-expand-2",
      {},
      { showImages: false },
      {
        name: "unknown_expand_probe",
        renderShell: "self",
        renderCall: () => ({
          render: () => ["x".repeat(1_000_000)],
          invalidate() {},
        }),
        renderResult: () => ({
          render: () => [],
          invalidate() {},
        }),
      } as any,
      { requestRender() {} } as any,
      process.cwd(),
    );
    oneRow.markExecutionStarted();
    const capped = oneRow.render(80);
    assert.ok(capped.every((line) => line.length <= SAFE_TEXT_MAX_CHARS));
    assert.ok(capped.some((line) => /truncated for display/.test(line)));
  });
});
