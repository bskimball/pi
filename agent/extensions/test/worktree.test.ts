import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import worktreeExtension, { allowedWorktreePath, parseWorktreeList, patchPaths } from "../worktree.ts";

const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "worktree-ext-"));
  temps.push(root);
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  writeFileSync(join(root, "README.md"), "test\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

type Execute = (id: string, params: Record<string, unknown>, signal: AbortSignal, update: unknown, ctx: { cwd: string }) => Promise<any>;
function tool(): Execute {
  let execute: Execute | undefined;
  worktreeExtension({ registerTool(spec: { name: string; execute: Execute }) { execute = spec.execute; } } as any);
  assert.ok(execute);
  return execute;
}

function text(result: any): string { return result.content[0].text; }

describe("worktree extension", () => {
  it("rejects paths outside the repository parent jail", () => {
    const root = fixture();
    assert.equal(allowedWorktreePath(root, resolve(root, "..", "..", "escape")), false);
  });

  it("extracts paths from git and traditional unified patch headers", () => {
    assert.deepEqual(patchPaths("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n"), ["a.txt"]);
    assert.deepEqual(patchPaths("--- a/outside.txt\n+++ b/outside.txt\n"), ["outside.txt"]);
    assert.equal(patchPaths("not a patch\n"), undefined);
  });

  it("adds, lists, removes, and refuses the main worktree", async () => {
    const root = fixture();
    const execute = tool();
    const target = join(root, ".pi-worktrees", "writer");
    const added = await execute("1", { operation: "add", path: target, branch: "pi/writer" }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(added.isError, false, text(added));
    assert.match(text(added), new RegExp(`path: ${resolve(target).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
    assert.match(text(added), /Pass task_start cwd=".+" for a writing worker\./);

    const listed = await execute("2", { operation: "list" }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(listed.isError, false, text(listed));
    assert.ok(text(listed).replaceAll("\\", "/").includes(`path: ${resolve(target).replaceAll("\\", "/")}`));
    assert.match(text(listed), /branch: pi\/writer/);
    assert.equal(parseWorktreeList(`worktree ${target}\nHEAD abc\nbranch refs/heads/pi/writer\n\n`).length, 1);

    const mainRemoval = await execute("3", { operation: "remove", path: root }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(mainRemoval.isError, true);
    assert.match(text(mainRemoval), /main worktree/);

    const removed = await execute("4", { operation: "remove", path: target }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(removed.isError, false, text(removed));
  });

  it("exports and applies a scoped patch including untracked files", async () => {
    const root = fixture();
    const execute = tool();
    const target = join(root, ".pi-worktrees", "writer-patch");
    const added = await execute("1", { operation: "add", path: target, branch: "pi/writer-patch" }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(added.isError, false, text(added));
    writeFileSync(join(target, "README.md"), "changed\n");
    writeFileSync(join(target, "new.txt"), "new\n");

    const rejected = await execute("2", { operation: "export", path: target, paths: ["README.md"] }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(rejected.isError, true);
    assert.match(text(rejected), /outside assigned paths/);

    const exported = await execute("3", { operation: "export", path: target, paths: ["README.md", "new.txt"] }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(exported.isError, false, text(exported));
    const patchPath = text(exported).match(/^patch: (.+)$/m)?.[1];
    assert.ok(patchPath && existsSync(patchPath));

    const applied = await execute("4", { operation: "apply", path: patchPath, paths: ["README.md", "new.txt"] }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(applied.isError, false, text(applied));
    assert.equal(readFileSync(join(root, "README.md"), "utf8").replaceAll("\r\n", "\n"), "changed\n");
    assert.equal(readFileSync(join(root, "new.txt"), "utf8").replaceAll("\r\n", "\n"), "new\n");
    assert.equal(existsSync(patchPath), false);
  });

  it("rejects a traditional patch that targets an unassigned file", async () => {
    const root = fixture();
    writeFileSync(join(root, "outside.txt"), "base\n");
    git(root, ["add", "outside.txt"]);
    git(root, ["commit", "-m", "outside"]);
    const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const patchDir = join(root, gitDir, "pi-patches");
    mkdirSync(patchDir, { recursive: true });
    const patchPath = join(patchDir, "hostile.patch");
    writeFileSync(patchPath, "--- a/outside.txt\n+++ b/outside.txt\n@@ -1 +1 @@\n-base\n+changed\n");
    const applied = await tool()("1", { operation: "apply", path: patchPath, paths: ["README.md"] }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(applied.isError, true);
    assert.match(text(applied), /outside assigned paths/);
    assert.equal(readFileSync(join(root, "outside.txt"), "utf8").replaceAll("\r\n", "\n"), "base\n");
  });
});
