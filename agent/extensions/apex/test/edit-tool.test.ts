import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  createEditToolDefinition,
  createReadToolDefinition,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";

const { installEditTool } = await import("../internal/edit/edit-tool.ts");
const { installBuiltinReceipts } = await import("../internal/presentation/builtin-receipts.ts");
const { installSkillInvocationChrome } = await import("../internal/presentation/skill-invocation.ts");

function registeredTool(apexUi = "1"): any {
  const previousApexUi = process.env.PI_APEX_UI;
  process.env.PI_APEX_UI = apexUi;
  try {
    let tool: any;
    installEditTool({
      registerTool(definition: any) {
        tool = definition;
      },
    } as any);
    return tool;
  } finally {
    if (previousApexUi === undefined) delete process.env.PI_APEX_UI;
    else process.env.PI_APEX_UI = previousApexUi;
  }
}

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

describe("Pi-owned tool and skill chrome", () => {
  it("renders read and edit through Apex without taking execution ownership", () => {
    initTheme("dark");
    const previous = process.env.PI_APEX_UI;
    process.env.PI_APEX_UI = "1";
    try {
      installBuiltinReceipts();

      const readArgs = { path: "src/app.ts", offset: 4, limit: 2 };
      const read = new ToolExecutionComponent(
        "read",
        "read-1",
        readArgs,
        { showImages: false },
        createReadToolDefinition(process.cwd()),
        { requestRender() {} } as any,
        process.cwd(),
      ) as any;
      read.markExecutionStarted();
      read.updateResult({
        content: [{ type: "text", text: "alpha\n\nbeta\n[Image: original 10x10]\n[2 more lines in file. Use offset=6 to continue.]" }],
      });
      const readText = read.render(80).join("\n");
      assert.match(readText, /read/);
      assert.match(readText, /src\/app\.ts:4\+2/);
      assert.match(readText, /4 alpha/);
      assert.match(readText, /6 beta/);
      assert.match(readText, /\[Image: original 10x10\]/);
      assert.doesNotMatch(readText, /7 \[Image:/);
      assert.doesNotMatch(readText, /┌|┐|└|┘/);

      const editArgs = {
        path: "src/app.ts",
        edits: [{ oldText: "old", newText: "new" }],
      };
      const edit = new ToolExecutionComponent(
        "edit",
        "edit-1",
        editArgs,
        { showImages: false },
        createEditToolDefinition(process.cwd()),
        { requestRender() {} } as any,
        process.cwd(),
      ) as any;
      edit.markExecutionStarted();
      edit.updateResult({
        content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
        details: { diff: " 1 before\n-2 old\n+2 new\n 3 after" },
      });
      edit.setExpanded(true);
      const editLines = edit.render(80);
      const editText = editLines.join("\n");
      assert.match(editText, /edit/);
      assert.match(editText, /src\/app\.ts/);
      assert.match(editText, /\+1/);
      assert.match(editText, /-1/);
      assert.match(editText, /new/);
      assert.doesNotMatch(editText, /┌|┐|└|┘/);
      assert.ok(editLines.every((line: string) => safeVisibleWidth(line) <= 80));
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });

  it("renders compact skill chrome and dynamically restores Pi chrome when disabled", () => {
    initTheme("dark");
    installSkillInvocationChrome();
    const previous = process.env.PI_APEX_UI;
    try {
      process.env.PI_APEX_UI = "1";
      const component = new SkillInvocationMessageComponent(
        {
          name: "repo-cleanup\u001b[2J",
          location: "agent/skills/repo-cleanup/SKILL.md\u001b[0m",
          content: "# Cleanup\nRun safely.\u001b[2J\nFinal instruction remains visible.",
          userMessage: undefined,
        },
        getMarkdownTheme(),
      );
      const collapsed = component.render(80);
      assert.equal(collapsed.length, 1);
      assert.match(collapsed[0], /skill repo-cleanup/);
      assert.doesNotMatch(collapsed[0], /\[skill\]/);

      component.setExpanded(true);
      const expanded = component.render(80);
      assert.match(expanded.join("\n"), /Run safely\./);
      assert.match(expanded.join("\n"), /Final instruction remains visible\./);
      assert.doesNotMatch(expanded.join("\n"), /\u001b\[2J|\u001b\[0m/);
      assert.ok(expanded.every((line) => safeVisibleWidth(line) <= 80));

      process.env.PI_APEX_UI = "0";
      const stock = component.render(80).join("\n");
      assert.match(stock, /\[skill\]/);
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});

describe("legacy Apex edit tool", () => {
  it("applies a multi-file patch", async () => {
    const tool = registeredTool();
    assert.equal(tool.name, "edit");

    const cwd = await mkdtemp(join(tmpdir(), "pi-apex-edit-"));
    try {
      await writeFile(join(cwd, "alpha.txt"), "one\ntwo\nthree\n", "utf8");
      const text = `*** Begin Patch
*** Update File: alpha.txt
@@
 one
-two
+TWO
 three
*** Add File: beta.txt
+created
*** End Patch`;
      const result = await tool.execute("test", { text }, undefined, undefined, {
        cwd,
      });

      assert.equal(
        await readFile(join(cwd, "alpha.txt"), "utf8"),
        "one\nTWO\nthree\n",
      );
      assert.equal(await readFile(join(cwd, "beta.txt"), "utf8"), "created\n");
      assert.equal(result.details.files.length, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("accepts a row-oriented replacement", async () => {
    const tool = registeredTool();
    const cwd = await mkdtemp(join(tmpdir(), "pi-apex-edit-row-"));
    try {
      await writeFile(join(cwd, "row.txt"), "before\ntarget\nafter\n", "utf8");
      await tool.execute(
        "test",
        { text: "[row.txt]\n@REPLACE\n-target\n+replaced" },
        undefined,
        undefined,
        { cwd },
      );
      assert.equal(
        await readFile(join(cwd, "row.txt"), "utf8"),
        "before\nreplaced\nafter\n",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("renders an Apex diff receipt with path, stats, and diff body", () => {
    const tool = registeredTool();
    assert.equal(tool.renderShell, "self");

    const args = { text: "[src/app.ts]\n@REPLACE\n-old\n+new" };
    const ctx = context(args);
    const call = tool.renderCall(args, theme, ctx).render(80).join("\n");
    assert.match(call, /edit/);
    assert.match(call, /src\/app\.ts/);

    const result = {
      content: [{ type: "text", text: "edited src/app.ts" }],
      details: {
        files: [{ path: "src/app.ts" }],
        diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
      },
    };
    const rendered = tool
      .renderResult(result, { expanded: true, isPartial: false }, theme, ctx)
      .render(80);
    const text = rendered.join("\n");
    assert.match(text, /src\/app\.ts/);
    assert.match(text, /\+1/);
    assert.match(text, /-1/);
    assert.match(text, /new/);
    assert.doesNotMatch(text, /┌|┐|└|┘/);
    assert.ok(
      rendered.every((line: string) => safeVisibleWidth(line) <= 80),
      "all diff receipt lines bounded by safeVisibleWidth",
    );
  });

  it("registers and executes with stock rendering when PI_APEX_UI=0", async () => {
    const tool = registeredTool("0");
    assert.equal(tool.name, "edit");
    assert.equal(tool.renderShell, undefined);
    assert.equal(tool.renderCall, undefined);
    assert.equal(tool.renderResult, undefined);

    const cwd = await mkdtemp(join(tmpdir(), "pi-apex-edit-stock-"));
    try {
      await writeFile(join(cwd, "row.txt"), "before\n", "utf8");
      await tool.execute(
        "test",
        { text: "[row.txt]\n@APPEND\n+after" },
        undefined,
        undefined,
        { cwd },
      );
      assert.equal(await readFile(join(cwd, "row.txt"), "utf8"), "before\nafter\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an empty payload before touching the filesystem", async () => {
    const tool = registeredTool();
    await assert.rejects(
      () => tool.execute("test", { text: "   " }, undefined, undefined, { cwd: process.cwd() }),
      /non-empty text payload/,
    );
  });
});
