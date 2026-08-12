import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lsp, { lspArgSummary, lspTitle } from "../index.ts";

function registeredTool(): any {
  let tool: any;
  lsp({
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

describe("lsp receipt", () => {
  it("renders through the shared Apex receipt", () => {
    const tool = registeredTool();
    assert.equal(tool.name, "lsp");
    assert.equal(tool.renderShell, "self");
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");

    const args = {
      operation: "references",
      path: "agent/extensions/lsp/manager.ts",
      line: 120,
      column: 9,
    };
    const ctx = context(args);
    const call = tool.renderCall(args, theme, ctx).render(80).join("\n");
    assert.match(call, /lsp references/);
    assert.match(call, /manager\.ts:120:9/);

    const result = {
      content: [
        { type: "text", text: "manager.ts:120:9\nmanager.ts:204:3\nindex.ts:8:1" },
      ],
      details: {},
    };
    const rendered = tool
      .renderResult(result, { expanded: false, isPartial: false }, theme, ctx)
      .render(80);
    assert.match(rendered[0], /lsp references/);
    assert.ok(rendered.length <= 4);
    assert.ok(rendered.every((line: string) => line.length <= 80));
  });

  it("builds compact titles and argument summaries without JSON", () => {
    assert.equal(lspTitle({ operation: "hover" }), "lsp hover");
    assert.equal(lspTitle({}), "lsp");

    // Operation appears in the title only, never repeated in the argument.
    assert.ok(!lspArgSummary({ operation: "hover", path: "a/b.ts" }).includes("hover"));

    assert.equal(
      lspArgSummary({ operation: "document_symbols", path: "src/app/main.ts" }),
      "src/app/main.ts",
    );
    assert.equal(
      lspArgSummary({ operation: "definition", path: "src/a.ts", line: 3, column: 7 }),
      "src/a.ts:3:7",
    );
    assert.equal(
      lspArgSummary({ operation: "workspace_symbols", query: "LspManager" }),
      '"LspManager"',
    );
    assert.match(
      lspArgSummary({ operation: "read_symbol", query: "run", path: "pkg/x.go" }),
      /^"run" in pkg\/x\.go$/,
    );

    const deep = lspArgSummary(
      { operation: "diagnostics", path: "a/very/deeply/nested/project/src/module/file.ts", line: 42 },
      28,
    );
    assert.ok(deep.length <= 28);
    assert.match(deep, /file\.ts:42$/);
    const veryDeep = lspArgSummary(
      {
        operation: "diagnostics",
        path: `${"nested/".repeat(40)}identifying-file.ts`,
        line: 7,
      },
      32,
    );
    assert.ok(veryDeep.length <= 32);
    assert.match(veryDeep, /identifying-file\.ts:7$/);
    assert.ok(
      lspArgSummary(
        { path: "some/file.ts", line: 123456789, column: 987654321 },
        8,
      ).length <= 8,
    );
    assert.equal(lspArgSummary({ query: "abcdef" }, 1).length, 1);
    assert.equal(lspArgSummary({ query: "abcdef", path: "some/file.ts" }, 2).length, 2);
    assert.equal(lspArgSummary({ path: "some/file.ts" }, 0), "");
    assert.equal(lspArgSummary({ operation: "diagnostics" }), "");
  });
});
