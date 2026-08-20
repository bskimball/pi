import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { collectEditPaths, shouldDiagnosePostEdit } from "../post-edit.ts";

describe("post-edit diagnostics", () => {
  it("collects scalar, array, and unified-edit paths without duplicates", () => {
    const cwd = process.cwd();
    const paths = collectEditPaths({
      path: "src/a.rs",
      paths: ["src/b.zig", "src/a.rs"],
      text: "[package.json]\n@REPLACE\n[ src/not-a-header ]\n",
    }, cwd);
    assert.deepEqual(paths, [
      resolve(cwd, "src/a.rs"),
      resolve(cwd, "src/b.zig"),
      resolve(cwd, "package.json"),
      resolve(cwd, "src/not-a-header"),
    ]);
  });

  it("skips failed results and non-edit tools", () => {
    const expected = process.env.PI_SUBAGENT === "1" ? false : true;
    assert.equal(shouldDiagnosePostEdit({ toolName: "edit" }), expected);
    assert.equal(shouldDiagnosePostEdit({ toolName: "WRITE" }), expected);
    assert.equal(shouldDiagnosePostEdit({ toolName: "bash" }), false);
    assert.equal(shouldDiagnosePostEdit({ toolName: "edit", isError: true }), false);
  });
});
