import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";

const { installEditTool } = await import("../internal/edit/edit-tool.ts");

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

describe("apex edit tool", () => {
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
