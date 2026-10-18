import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it, test } from "node:test";
import { shipping, type Exec, type ShippingInput } from "../worktree/internal/shipping.ts";
import { branch, commonDir, git as shippingGit, head, loadTask, locked, refHead, stateDir, trees } from "../worktree/internal/shipping-state.ts";

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
    git(root, ["config", "diff.mnemonicPrefix", "true"]);
    writeFileSync(join(target, "README.md"), "changed\n");
    writeFileSync(join(target, "new.txt"), "new\n");

    const rejected = await execute("2", { operation: "export", path: target, paths: ["README.md"] }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(rejected.isError, true);
    assert.match(text(rejected), /outside assigned paths/);

    const exported = await execute("3", { operation: "export", path: target, paths: ["README.md", "new.txt"] }, new AbortController().signal, undefined, { cwd: target });
    assert.equal(exported.isError, false, text(exported));
    const patchPath = text(exported).match(/^patch: (.+)$/m)?.[1];
    assert.ok(patchPath && existsSync(patchPath));

    const applied = await execute("4", { operation: "apply", path: patchPath, paths: ["README.md", "new.txt"] }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(applied.isError, false, text(applied));
    assert.equal(readFileSync(join(root, "README.md"), "utf8").replaceAll("\r\n", "\n"), "changed\n");
    assert.equal(readFileSync(join(root, "new.txt"), "utf8").replaceAll("\r\n", "\n"), "new\n");
    assert.equal(existsSync(patchPath), true, "retain recovery evidence until durable integration");
    const repeated = await execute("5", { operation: "apply", path: patchPath, paths: ["README.md", "new.txt"] }, new AbortController().signal, undefined, { cwd: root });
    assert.equal(repeated.isError, false, text(repeated));
    assert.match(text(repeated), /already present/);
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

const shippingTemps: string[] = [];
after(() => shippingTemps.forEach(p => rmSync(p, { recursive: true, force: true })));
const checks = [{ command: "node", args: ["-e", "process.exit(0)"] }];
const realExec: Exec = async (command, args, options) => {
  const r = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8", timeout: options?.timeout, windowsHide: true });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? r.error?.message ?? "", code: r.status ?? 1, killed: !!r.error };
};
function shippingFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-shipping-test-")); shippingTemps.push(dir);
  const root = join(dir, "repo"), remote = join(dir, "remote.git"), worker = join(dir, "worker");
  mkdirSync(root);
  shippingGit(root, ["init", "--initial-branch=main"]);
  shippingGit(root, ["config", "user.name", "Shipping Test"]); shippingGit(root, ["config", "user.email", "test@example.com"]);
  shippingGit(root, ["config", "commit.gpgsign", "false"]); shippingGit(root, ["config", "core.hooksPath", join(dir, "no-hooks")]);
  writeFileSync(join(root, "README.md"), "base\n"); writeFileSync(join(root, "outside.txt"), "preserve\n");
  shippingGit(root, ["add", "README.md", "outside.txt"]); shippingGit(root, ["commit", "-m", "initial"]);
  shippingGit(root, ["init", "--bare", "--initial-branch=main", remote]); shippingGit(root, ["remote", "add", "origin", remote]); shippingGit(root, ["push", "origin", "main"]);
  const base = head(root); shippingGit(root, ["switch", "-c", "feat/task"]);
  const call = (p: ShippingInput, exec: Exec = realExec, cwd = root) => shipping(cwd, "session-one", p, exec);
  const begin = (p: Partial<ShippingInput> = {}) => call({ operation: "begin", task: "demo", paths: ["README.md", "new.txt"], base, target: "main", remote: "origin", route: "direct", delivery: "ship", checks, confirm: true, ...p });
  const change = (text = "task\n") => { writeFileSync(join(root, "README.md"), text); shippingGit(root, ["add", "README.md"]); shippingGit(root, ["commit", "-m", "feat: task"]); return head(root); };
  const prove = async (exec = realExec) => {
    await call({ operation: "review", task: "demo", expectedHead: head(root), verdict: "pass", evidence: "test shippingFixture review" }, exec);
    await call({ operation: "verify", task: "demo", expectedHead: head(root) }, exec);
  };
  return { dir, root, remote, worker, base, call, begin, change, prove };
}
function worktreeTool() {
  const tools = new Map<string, any>();
  worktreeExtension({ registerTool(spec: any) { tools.set(spec.name, spec); } } as any);
  return async (cwd: string, params: object) => {
    const result = await tools.get("worktree").execute("test", params, undefined, undefined, { cwd, sessionManager: { getSessionId: () => "session-one" } });
    if (result.isError) throw new Error(result.content[0].text);
    return result.content[0].text as string;
  };
}

test("status is read-only; registration is immutable, scoped, and visible from linked trees", async () => {
  const f = shippingFixture();
  await f.call({ operation: "status" }); assert.equal(existsSync(stateDir(f.root)), false);
  await assert.rejects(f.begin({ confirm: false }), /authorization/);
  await assert.rejects(f.begin({ paths: [":(glob)**"] }), /Invalid owned path/);
  await f.begin();
  await f.begin({ target: "wrong", paths: ["outside.txt"] });
  assert.equal(loadTask(f.root, "demo").target, "main");
  const wt = worktreeTool();
  await wt(f.root, { operation: "add", path: f.worker, branch: "worker/one", task: "demo", paths: ["README.md"], startPoint: f.base });
  assert.equal(commonDir(f.worker), commonDir(f.root));
  assert.equal(loadTask(f.worker, "demo").owner, "session-one");
  assert.match(await wt(f.worker, { operation: "list" }), /task=demo/);
  await assert.rejects(wt(f.root, { operation: "remove", path: f.worker, force: true }), /shipping cleanup/);
  await assert.rejects(f.call({ operation: "begin", task: "second", paths: ["README.md"], base: f.base, target: "main" }), /already belongs/);
});

test("checkpoints preserve unrelated dirt, refuse unrelated index entries and avoid empty commits", async () => {
  const f = shippingFixture(); await f.begin();
  writeFileSync(join(f.root, "README.md"), "changed\n"); writeFileSync(join(f.root, "outside.txt"), "other owner\n");
  shippingGit(f.root, ["add", "outside.txt"]);
  await assert.rejects(f.call({ operation: "checkpoint", task: "demo", expectedHead: f.base, message: "fix: scoped", confirm: true }), /Unrelated staged/);
  assert.equal(shippingGit(f.root, ["diff", "--cached", "--name-only"]), "outside.txt");
  shippingGit(f.root, ["restore", "--staged", "outside.txt"]);
  await f.call({ operation: "checkpoint", task: "demo", expectedHead: f.base, message: "fix: scoped", confirm: true });
  const sha = head(f.root);
  assert.equal(shippingGit(f.root, ["show", "HEAD:outside.txt"]), "preserve");
  assert.equal(readFileSync(join(f.root, "outside.txt"), "utf8"), "other owner\n");
  await f.call({ operation: "checkpoint", task: "demo", expectedHead: sha, message: "fix: scoped", confirm: true });
  assert.equal(head(f.root), sha);
  await assert.rejects(f.prove(), /must be clean/);
});

test("worker integration requires inactive exact revision, preserves changes, and cleans up idempotently", async () => {
  const f = shippingFixture(); await f.begin();
  const wt = worktreeTool();
  await wt(f.root, { operation: "add", path: f.worker, branch: "worker/one", task: "demo", paths: ["README.md"], startPoint: f.base });
  writeFileSync(join(f.worker, "README.md"), "worker\n");
  await f.call({ operation: "checkpoint", task: "demo", path: f.worker, expectedHead: f.base, message: "fix: worker", confirm: true });
  const tip = head(f.worker);
  await assert.rejects(f.call({ operation: "integrate", task: "demo", path: f.worker, expectedHead: tip, confirm: true }), /settle/);
  await f.call({ operation: "settle", task: "demo", path: f.worker, expectedHead: tip, confirm: true });
  await f.call({ operation: "integrate", task: "demo", path: f.worker, expectedHead: tip, confirm: true });
  const integrated = head(f.root);
  await f.call({ operation: "integrate", task: "demo", path: f.worker, expectedHead: tip, confirm: true });
  assert.equal(head(f.root), integrated);
  assert.equal(readFileSync(join(f.root, "README.md"), "utf8"), "worker\n");
  writeFileSync(join(f.worker, "local.txt"), "not committed\n");
  await assert.rejects(f.call({ operation: "cleanup", task: "demo", expectedHead: integrated, confirm: true }), /must be clean/);
  rmSync(join(f.worker, "local.txt"));
  // Ignore policy is repository-local and never hides unknown local data from cleanup.
  writeFileSync(join(commonDir(f.root), "info", "exclude"), "local-data\n");
  writeFileSync(join(f.worker, "local-data"), "private scratch\n");
  await assert.rejects(f.call({ operation: "cleanup", task: "demo", expectedHead: integrated, confirm: true }), /Ignored files/);
  rmSync(join(f.worker, "local-data"));
  await f.call({ operation: "cleanup", task: "demo", expectedHead: integrated, confirm: true });
  await f.call({ operation: "cleanup", task: "demo", expectedHead: integrated, confirm: true });
  assert.equal(existsSync(f.worker), false); assert.equal(refHead(f.root, "refs/heads/worker/one"), undefined);
  assert.ok(refHead(f.root, "refs/heads/feat/task")); assert.equal(trees(f.root)[0].removed, true);
});

test("verification resumes only matching commands/revision, rejects failed and mutated gates", async () => {
  const f = shippingFixture(); await f.begin({ checks: [...checks, { command: "second", args: [] }] }); f.change();
  let first = 0, second = 0, fail = true;
  const exec: Exec = async command => {
    if (command === "node") first++; else second++;
    return { code: command === "second" && fail ? 1 : 0, stdout: "gate", stderr: "", killed: false };
  };
  const verify = (fresh = false) => f.call({ operation: "verify", task: "demo", expectedHead: head(f.root), fresh }, exec);
  await assert.rejects(verify(), /Gate 2\/2 failed/); assert.equal(loadTask(f.root, "demo").gates?.passed, 1);
  fail = false; await verify(); assert.equal(first, 1); assert.equal(second, 2);
  await verify(); assert.equal(first, 1);
  await verify(true); assert.equal(first, 2);
  f.change("new revision\n"); await verify(); assert.equal(first, 3);
  await assert.rejects(f.call({ operation: "land", task: "demo", expectedHead: head(f.root), confirm: true }), /review verdict/);
  const mutating: Exec = async () => { writeFileSync(join(f.root, "README.md"), "formatter mutation\n"); return { code: 0, stdout: "", stderr: "", killed: false }; };
  await assert.rejects(f.call({ operation: "verify", task: "demo", expectedHead: head(f.root), fresh: true }, mutating), /must be clean/);
  assert.equal(loadTask(f.root, "demo").gates?.passed, 0);
});

test("direct landing and cleanup use exact remote evidence; retries do not duplicate commits", async () => {
  const f = shippingFixture(); await f.begin(); const sha = f.change(); await f.prove();
  await assert.rejects(f.call({ operation: "land", task: "demo", expectedHead: sha }), /authorization/);
  await f.call({ operation: "land", task: "demo", expectedHead: sha, confirm: true });
  assert.equal(shippingGit(f.remote, ["rev-parse", "main"]), sha);
  await f.call({ operation: "land", task: "demo", expectedHead: sha, confirm: true });
  await f.call({ operation: "cleanup", task: "demo", confirm: true });
  await f.call({ operation: "cleanup", task: "demo", confirm: true });
  assert.equal(branch(f.root), "main"); assert.equal(head(f.root), sha);
  assert.equal(refHead(f.root, "refs/heads/feat/task"), undefined);
  assert.equal(loadTask(f.root, "demo").cleaned, true);
});

test("target advance requires explicit refresh and invalidates prior gates/review", async () => {
  const f = shippingFixture(); await f.begin(); f.change(); await f.prove();
  const other = join(f.dir, "other"); shippingGit(f.root, ["clone", f.remote, other]);
  shippingGit(other, ["config", "user.name", "Other"]); shippingGit(other, ["config", "user.email", "other@example.com"]); shippingGit(other, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(other, "outside.txt"), "upstream\n"); shippingGit(other, ["add", "outside.txt"]); shippingGit(other, ["commit", "-m", "upstream"]); shippingGit(other, ["push"]);
  await assert.rejects(f.call({ operation: "land", task: "demo", expectedHead: head(f.root), confirm: true }), /target branch advanced/);
  await f.call({ operation: "refresh", task: "demo", expectedHead: head(f.root), confirm: true });
  assert.equal(loadTask(f.root, "demo").gates, undefined); assert.equal(loadTask(f.root, "demo").review, undefined);
  await f.prove(); await f.call({ operation: "land", task: "demo", expectedHead: head(f.root), confirm: true });
  assert.equal(shippingGit(f.remote, ["show", "main:outside.txt"]), "upstream");
});

test("repository lock serializes sessions; wrong remote and unsafe ownership fail closed", async () => {
  const f = shippingFixture(); await f.begin();
  await locked(f.root, async () => { await assert.rejects(f.call({ operation: "authorize", task: "demo", delivery: "ship", confirm: true }), /repository lock/); });
  f.change(); await f.prove(); shippingGit(f.root, ["remote", "set-url", "origin", join(f.dir, "another.git")]);
  await assert.rejects(f.call({ operation: "land", task: "demo", expectedHead: head(f.root), confirm: true }), /Remote identity changed/);
  const other = shippingFixture();
  await assert.rejects(f.call({ operation: "attach", task: "demo", path: other.root, base: other.base, paths: ["README.md"], confirm: true }), /different worktree/);
});

function githubFixture(f: ReturnType<typeof shippingFixture>) {
  shippingGit(f.root, ["remote", "set-url", "origin", "https://github.com/test/fork.git"]);
  let pr: any; let remoteTip: string | undefined; let target = f.base; let pending = false;
  const calls: { command: string; args: string[] }[] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args });
    let stdout = "";
    if (command === "gh") {
      assert.equal(args[args.indexOf("--repo") + 1], "test/fork", "every GH call explicitly selects the fork");
      if (args[1] === "list") stdout = JSON.stringify(pr ? [pr] : []);
      else if (args[1] === "create") { pr = { number: 42, url: "https://github.com/test/fork/pull/42", state: "OPEN", isDraft: false, headRefOid: remoteTip, headRefName: "feat/task", baseRefName: "main", headRepository: { nameWithOwner: "test/fork" }, mergeCommit: null }; stdout = pr.url; }
      else if (args[1] === "view") stdout = JSON.stringify(pr);
      else if (args[1] === "merge") {
        assert.equal(args[args.indexOf("--match-head-commit") + 1], head(f.root));
        if (!pending) {
          target = shippingGit(f.root, ["commit-tree", `${head(f.root)}^{tree}`, "-p", f.base, "-m", "squashed"]);
          pr.state = "MERGED"; pr.mergeCommit = { oid: target };
        }
      }
    } else if (command === "git" && args[0] === "push") {
      if (args.some(a => a.startsWith(":"))) remoteTip = undefined;
      else remoteTip = args[2].split(":")[0];
    } else if (command === "git" && args[0] === "ls-remote") stdout = remoteTip ? `${remoteTip}\trefs/heads/feat/task` : "";
    else if (command === "git" && args[0] === "fetch") shippingGit(f.root, ["update-ref", "refs/remotes/origin/main", target]);
    else return realExec(command, args, options);
    return { code: 0, stdout, stderr: "", killed: false };
  };
  return { exec, calls, setPending(v: boolean) { pending = v; }, getPR: () => pr };
}

test("PR publication is idempotent, uses exact fork/head, and PR-only never grants merge", async () => {
  const f = shippingFixture(), gh = githubFixture(f);
  await f.begin({ route: "pr", repo: "test/fork", delivery: "pr" }); f.change(); await f.prove();
  const publish: ShippingInput = { operation: "publish", task: "demo", expectedHead: head(f.root), title: "feat: test", body: "## Verification\nTests passed", confirm: true };
  await f.call(publish, gh.exec); await f.call(publish, gh.exec);
  assert.equal(gh.calls.filter(c => c.command === "gh" && c.args[1] === "create").length, 1);
  await assert.rejects(f.call({ operation: "land", task: "demo", expectedHead: head(f.root), confirm: true }, gh.exec), /ship authorization/);
  await f.call({ operation: "authorize", task: "demo", delivery: "ship", confirm: true });
  gh.getPR().headRefOid = f.base;
  await assert.rejects(f.call({ operation: "land", task: "demo", expectedHead: head(f.root), confirm: true }, gh.exec), /PR identity/);
  gh.getPR().headRefOid = head(f.root); gh.setPending(true);
  const pending: any = await f.call({ operation: "land", task: "demo", expectedHead: head(f.root), confirm: true }, gh.exec);
  assert.equal(pending.state, "pending-merge"); assert.equal(loadTask(f.root, "demo").landed, undefined);
  gh.setPending(false);
  await f.call({ operation: "land", task: "demo", expectedHead: head(f.root), confirm: true }, gh.exec);
  await f.call({ operation: "cleanup", task: "demo", confirm: true }, gh.exec);
  assert.equal(loadTask(f.root, "demo").cleaned, true);
  assert.equal(refHead(f.root, "refs/heads/feat/task"), undefined, "squash landing permits exact-tip cleanup without ancestry guesswork");
  assert.ok(gh.calls.some(c => c.args.some(a => a.startsWith("--force-with-lease=refs/heads/feat/task:"))));
});

test("interrupted direct push and PR creation recover from remote facts without duplication", async () => {
  const f = shippingFixture(); await f.begin(); const sha = f.change(); await f.prove();
  let interrupt = true;
  const lostPush: Exec = async (command, args, options) => {
    const result = await realExec(command, args, options);
    if (command === "git" && args[0] === "push" && interrupt) { interrupt = false; throw new Error("lost response after successful push"); }
    return result;
  };
  await assert.rejects(f.call({ operation: "land", task: "demo", expectedHead: sha, confirm: true }, lostPush), /lost response/);
  assert.equal(loadTask(f.root, "demo").landed, undefined);
  assert.equal(shippingGit(f.remote, ["rev-parse", "main"]), sha);
  await f.call({ operation: "land", task: "demo", expectedHead: sha, confirm: true });
  assert.equal(loadTask(f.root, "demo").landed?.commit, sha);

  const g = shippingFixture(), gh = githubFixture(g); await g.begin({ route: "pr", repo: "test/fork", delivery: "pr" }); g.change(); await g.prove();
  const lostCreate: Exec = async (command, args, options) => {
    const result = await gh.exec(command, args, options);
    if (command === "gh" && args[1] === "create") throw new Error("lost response after creating PR");
    return result;
  };
  const publish: ShippingInput = { operation: "publish", task: "demo", expectedHead: head(g.root), title: "feat: retry", body: "proof", confirm: true };
  await assert.rejects(g.call(publish, lostCreate), /lost response/);
  await g.call(publish, gh.exec);
  assert.equal(gh.calls.filter(c => c.command === "gh" && c.args[1] === "create").length, 1);
});

test("cleanup leaves advanced branch tips and another default-branch checkout untouched", async () => {
  const f = shippingFixture(); await f.begin(); const sha = f.change(); await f.prove();
  await f.call({ operation: "land", task: "demo", expectedHead: sha, confirm: true });
  const main = join(f.dir, "active-main"); shippingGit(f.root, ["worktree", "add", main, "main"]);
  await assert.rejects(f.call({ operation: "cleanup", task: "demo", confirm: true }), /checked out elsewhere/);
  assert.equal(head(main), f.base); assert.ok(refHead(f.root, "refs/heads/feat/task"));
  shippingGit(f.root, ["worktree", "remove", main]);
  const newer = f.change("later task change\n");
  await assert.rejects(f.call({ operation: "cleanup", task: "demo", confirm: true }), /Checkout changed/);
  assert.equal(head(f.root), newer); assert.ok(refHead(f.root, "refs/heads/feat/task"));
});

test("cleanup preserves ignored local data during default-branch switch and fast-forward", async () => {
  const f = shippingFixture();
  await f.begin({ paths: ["outside.txt", ".gitignore"] });
  shippingGit(f.root, ["rm", "outside.txt"]);
  writeFileSync(join(f.root, ".gitignore"), "outside.txt\n");
  shippingGit(f.root, ["add", ".gitignore"]);
  shippingGit(f.root, ["commit", "-m", "stop tracking local data"]);
  await f.prove();
  await f.call({ operation: "land", task: "demo", expectedHead: head(f.root), confirm: true });
  writeFileSync(join(f.root, "outside.txt"), "private local data\n");
  await assert.rejects(f.call({ operation: "cleanup", task: "demo", confirm: true }), /overwritten/);
  assert.equal(readFileSync(join(f.root, "outside.txt"), "utf8"), "private local data\n");
  assert.equal(shippingGit(f.root, ["branch", "--show-current"]), "feat/task");

  const g = shippingFixture();
  await g.begin();
  writeFileSync(join(g.root, "new.txt"), "published data\n");
  shippingGit(g.root, ["add", "new.txt"]);
  shippingGit(g.root, ["commit", "-m", "add published file"]);
  await g.prove();
  await g.call({ operation: "land", task: "demo", expectedHead: head(g.root), confirm: true });
  shippingGit(g.root, ["switch", "main"]);
  writeFileSync(join(g.root, ".git", "info", "exclude"), "new.txt\n");
  writeFileSync(join(g.root, "new.txt"), "other private data\n");
  await assert.rejects(g.call({ operation: "cleanup", task: "demo", confirm: true }), /overwritten/);
  assert.equal(readFileSync(join(g.root, "new.txt"), "utf8"), "other private data\n");
  assert.equal(head(g.root), g.base);
});

test("exact-tip remote deletion refuses a branch advanced after the read-back", async () => {
  const f = shippingFixture(); await f.begin(); const sha = f.change(); await f.prove();
  shippingGit(f.root, ["push", "origin", `${sha}:refs/heads/feat/task`]);
  await f.call({ operation: "land", task: "demo", expectedHead: sha, confirm: true });
  const newer = shippingGit(f.root, ["commit-tree", `${sha}^{tree}`, "-p", sha, "-m", "concurrent work"]);
  const race: Exec = async (command, args, options) => {
    if (command === "git" && args.some(a => a.startsWith("--force-with-lease="))) shippingGit(f.root, ["push", "origin", `${newer}:refs/heads/feat/task`]);
    return realExec(command, args, options);
  };
  await assert.rejects(f.call({ operation: "cleanup", task: "demo", confirm: true }, race), /failed/);
  assert.equal(shippingGit(f.remote, ["rev-parse", "feat/task"]), newer);
  assert.notEqual(loadTask(f.root, "demo").cleaned, true);
});

test("explicit exclusion preserves a worker; amended scope and checks invalidate evidence", async () => {
  const f = shippingFixture(); await f.begin(); const wt = worktreeTool();
  await wt(f.root, { operation: "add", path: f.worker, branch: "worker/abandoned", task: "demo", paths: ["README.md"] });
  writeFileSync(join(f.worker, "README.md"), "keep unfinished work\n");
  await assert.rejects(f.prove(), /remaining workers/);
  await f.call({ operation: "release", task: "demo", path: f.worker, evidence: "User excludes this unfinished experiment", confirm: true });
  await f.prove();
  const ready: any = await f.call({ operation: "status", task: "demo" });
  assert.equal(ready.tasks[0].ready, true);
  writeFileSync(join(f.root, "README.md"), "new unverified work\n");
  const changed: any = await f.call({ operation: "status", task: "demo" });
  assert.equal(changed.tasks[0].ready, false); assert.equal(changed.tasks[0].state, "working");
  await f.call({ operation: "amend", task: "demo", paths: ["README.md", "new.txt", "outside.txt"], checks, confirm: true });
  assert.equal(loadTask(f.root, "demo").gates, undefined); assert.equal(loadTask(f.root, "demo").review, undefined);
  assert.equal(readFileSync(join(f.worker, "README.md"), "utf8"), "keep unfinished work\n");
  await assert.rejects(f.call({ operation: "amend", task: "demo", paths: ["README.md"], confirm: true }), /not drop/);
  assert.equal(trees(f.root)[0].released?.task, "demo");
});

test("explicit worker base excludes dirty parent edits and missing checkouts remain visible", async () => {
  const f = shippingFixture(); await f.begin();
  writeFileSync(join(f.root, "README.md"), "uncommitted prerequisite\n");
  const wt = worktreeTool();
  await wt(f.root, { operation: "add", path: f.worker, branch: "worker/base", task: "demo", paths: ["README.md"], startPoint: f.base });
  assert.equal(readFileSync(join(f.worker, "README.md"), "utf8"), "base\n");
  rmSync(f.worker, { recursive: true });
  const status: any = await f.call({ operation: "status" });
  assert.match(status.worktrees.find((w: any) => w.path === f.worker).dirty, /missing/);
  assert.equal(status.tasks[0].workers[0].base, f.base);
});

test("reverted unrelated history is not silently adopted and detached checkouts remain inspectable", async () => {
  const f = shippingFixture();
  writeFileSync(join(f.root, "outside.txt"), "unrelated private work\n");
  shippingGit(f.root, ["add", "outside.txt"]); shippingGit(f.root, ["commit", "-m", "unrelated work"]);
  shippingGit(f.root, ["revert", "--no-edit", "HEAD"]);
  await assert.rejects(f.begin(), /outside task scope/);
  const g = shippingFixture(); await g.begin(); shippingGit(g.root, ["switch", "--detach"]);
  const status: any = await g.call({ operation: "status" });
  assert.equal(status.tasks[0].branch, "detached"); assert.equal(status.tasks[0].ready, false);
});

test("GitHub destination must match push remote, not the upstream", async () => {
  const f = shippingFixture(); githubFixture(f);
  await assert.rejects(f.begin({ route: "pr", repo: "test/upstream" }), /must match/);
});

test("shipping workflow pointers preserve mode boundaries and scoped permission", () => {
  const root = resolve(import.meta.dirname, "../..");
  const skill = readFileSync(join(root, "skills/shipping/SKILL.md"), "utf8");
  const prompt = readFileSync(join(root, "prompts/ship.md"), "utf8");
  const poteto = readFileSync(join(root, "prompts/poteto/opening-a-pr.md"), "utf8");
  assert.match(skill, /In Pi mode work inline/); assert.match(skill, /confirm:true.*actual user authorization/);
  assert.match(prompt, /ready.*show the completed task candidates/s); assert.match(prompt, /before mutations/);
  assert.match(poteto, /ship when ready/); assert.match(poteto, /Never rewrite pushed commits/);
});
