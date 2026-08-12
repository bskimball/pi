import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import unifiedEdit from "./unified-edit-adapter.ts";

function registeredTool(): any {
  let tool: any;
  unifiedEdit({
    registerTool(definition: any) {
      tool = definition;
    },
  } as any);
  return tool;
}

const theme = {
  fg(_key: string, text: string) {
    return text;
  },
  bg(_key: string, text: string) {
    return text;
  },
  inverse(text: string) {
    return text;
  },
};

describe("unified edit", () => {
  it("applies a multi-file patch and renders an Apex receipt", async () => {
    const tool = registeredTool();
    assert.equal(tool.name, "edit");
    assert.equal(tool.renderShell, "self");

    const cwd = await mkdtemp(join(tmpdir(), "pi-unified-edit-"));
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
      const result = await tool.execute(
        "test",
        { text },
        undefined,
        undefined,
        { cwd },
      );

      assert.equal(
        await readFile(join(cwd, "alpha.txt"), "utf8"),
        "one\nTWO\nthree\n",
      );
      assert.equal(await readFile(join(cwd, "beta.txt"), "utf8"), "created\n");
      assert.equal(result.details.files.length, 2);

      const state: any = {};
      const context: any = {
        state,
        cwd,
        args: { text },
        argsComplete: true,
        executionStarted: true,
        isError: false,
        invalidate() {},
      };
      const call = tool.renderCall({ text }, theme, context);
      assert.match(call.render(48).join("\n"), /edit 2 files/);

      const rendered = tool
        .renderResult(
          result,
          { expanded: true, isPartial: false },
          theme,
          context,
        )
        .render(72)
        .join("\n");
      assert.match(rendered, /edit 2 files/);
      assert.match(rendered, /TWO/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("accepts a row-oriented replacement", async () => {
    const tool = registeredTool();
    const cwd = await mkdtemp(join(tmpdir(), "pi-unified-edit-row-"));
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
});
