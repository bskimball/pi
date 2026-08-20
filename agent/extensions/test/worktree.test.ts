import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import worktreeExtension, { allowedWorktreePath, parseWorktreeList } from "../worktree.ts";

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
});
