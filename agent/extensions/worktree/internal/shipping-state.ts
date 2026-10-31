import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type Check = { command: string; args: string[] };
export type Delivery = "local" | "pr" | "ship";
export type Task = {
  version: 1; id: string; owner: string; root: string; branch: string; base: string;
  paths: string[]; delivery: Delivery; route: "pr" | "direct";
  remote?: string; remoteHash?: string; repo?: string; target: string;
  checks: Check[]; mergeMethod: "merge" | "squash" | "rebase";
  gates?: { head: string; passed: number; runtime: string; at: string };
  review?: { head: string; verdict: "pass" | "advisory" | "not-required" | "block"; evidence: string };
  pr?: { number: number; url: string }; published?: string;
  landed?: { head: string; commit: string }; cleaned?: boolean;
};
export type OwnedTree = {
  version: 1; path: string; branch: string; base: string; owner: string;
  task?: string; paths?: string[]; settled?: string; integrated?: { head: string; commit: string }; removed?: boolean;
  released?: { task: string; reason: string };
};
export function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) throw new Error((r.error?.message ?? r.stderr ?? "git failed").slice(-4000));
  return r.stdout.trimEnd();
}
export function isAncestor(root: string, a: string, b: string): boolean {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: root, timeout: 30_000, windowsHide: true });
  if (r.error || (r.status !== 0 && r.status !== 1)) throw new Error("Could not establish commit ancestry.");
  return r.status === 0;
}
export function head(root: string): string { return git(root, ["rev-parse", "--verify", "HEAD"]); }
export function branch(root: string): string { return git(root, ["symbolic-ref", "--short", "HEAD"]); }
export function commit(root: string, ref: string): string { return git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]); }
export function refHead(root: string, ref: string): string | undefined {
  return git(root, ["for-each-ref", "--format=%(refname) %(objectname)", ref]).split("\n").find(line => line.startsWith(`${ref} `))?.slice(ref.length + 1);
}
export function commonDir(root: string): string { return realpathSync(resolve(root, git(root, ["rev-parse", "--git-common-dir"]))); }
export function repositoryRoot(cwd: string): string { return realpathSync(git(cwd, ["rev-parse", "--show-toplevel"])); }
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function stateDir(root: string): string { return join(commonDir(root), "pi-shipping"); }
export function scope(paths: string[]): string[] {
  if (!paths.length) throw new Error("At least one owned repository-relative path is required.");
  return [...new Set(paths.map(p => {
    const s = p.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!s || s === "." || isAbsolute(s) || s.startsWith(":") || s.split("/").some(x => x === ".." || x === ".git") || /^[A-Za-z]:/.test(s)) throw new Error(`Invalid owned path: ${p}`);
    return s;
  }))];
}
export function owns(paths: string[], file: string): boolean { return paths.some(p => file === p || file.startsWith(`${p}/`)); }
export function dirty(root: string): string[] {
  const entries = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    files.push(entries[i].slice(3));
    if (/[RC]/.test(entries[i].slice(0, 2))) files.push(entries[++i]);
  }
  return [...new Set(files)];
}
export function clean(root: string): void {
  if (dirty(root).length) throw new Error(`Worktree must be clean before this operation: ${root}`);
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    if (existsSync(resolve(root, git(root, ["rev-parse", "--git-path", marker])))) throw new Error(`Finish or explicitly abort the in-progress Git operation (${marker}) first.`);
  }
}
export function changedSince(root: string, base: string, tip: string): string[] {
  const finalTree = git(root, ["diff", "--no-renames", "--name-only", "-z", base, tip]);
  // Reverted files still travel in published history. Exclude merge-parent diffs:
  // refreshed target history is already excluded by base, while finalTree covers resolutions.
  const history = git(root, ["log", "--no-merges", "--format=", "--no-renames", "--name-only", "-z", `${base}..${tip}`]);
  return [...new Set(`${finalTree}\0${history}`.split("\0").filter(Boolean))];
}
export function assertScope(root: string, base: string, tip: string, paths: string[]): void {
  if (!isAncestor(root, base, tip)) throw new Error("Recorded base is not an ancestor; reconcile rewritten history explicitly.");
  const outside = changedSince(root, base, tip).filter(p => !owns(paths, p));
  if (outside.length) throw new Error(`Changes outside task scope: ${outside.slice(0, 30).join(", ")}`);
}
function taskFile(root: string, id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error("Task id must be 1–80 letters, digits, hyphens or underscores.");
  return join(stateDir(root), "tasks", `${id}.json`);
}
function save(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(tmp, path); }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
export function loadTask(root: string, id: string): Task {
  const t = JSON.parse(readFileSync(taskFile(root, id), "utf8")) as Task;
  if (t.version !== 1 || t.id !== id || (existsSync(t.root) && commonDir(t.root) !== commonDir(root))) throw new Error("Invalid task record or repository identity.");
  return t;
}
export function taskExists(root: string, id: string): boolean { return existsSync(taskFile(root, id)); }
export function saveTask(root: string, t: Task): void { save(taskFile(root, t.id), t); }
export function tasks(root: string): Task[] {
  const dir = join(stateDir(root), "tasks");
  return existsSync(dir) ? readdirSync(dir).filter(x => x.endsWith(".json")).map(x => loadTask(root, x.slice(0, -5))) : [];
}
export function trees(root: string): OwnedTree[] {
  const dir = join(stateDir(root), "worktrees");
  return existsSync(dir) ? readdirSync(dir).filter(x => x.endsWith(".json")).map(x => {
    const t = JSON.parse(readFileSync(join(dir, x), "utf8")) as OwnedTree;
    if (t.version !== 1) throw new Error("Unsupported worktree record.");
    return t;
  }) : [];
}
export function saveTree(root: string, t: OwnedTree): void { save(join(stateDir(root), "worktrees", `${digest(t.path)}.json`), t); }
export function listedTrees(root: string): { path: string; branch?: string; head?: string }[] {
  return git(root, ["worktree", "list", "--porcelain", "-z"]).split("\0\0").filter(Boolean).map(block => {
    const lines = block.split("\0");
    return { path: lines.find(x => x.startsWith("worktree "))!.slice(9), branch: lines.find(x => x.startsWith("branch "))?.slice(18), head: lines.find(x => x.startsWith("HEAD "))?.slice(5) };
  });
}
export function checkTree(root: string, tree: OwnedTree): void {
  if (!listedTrees(root).some(w => resolve(w.path) === tree.path && w.branch === tree.branch)) throw new Error("Owned worktree is missing or its branch changed.");
  if (commonDir(tree.path) !== commonDir(root)) throw new Error("Worktree belongs to another repository.");
}
export function registerTree(root: string, tree: OwnedTree): void {
  const old = trees(root).find(w => w.path === tree.path && !w.removed);
  if (old && (old.owner !== tree.owner || old.task !== tree.task)) throw new Error("Worktree is already owned by another session/task.");
  saveTree(root, tree);
}
// Shared across all Pi sessions in the repository. Git still protects against external writers;
// callers must settle workers before attesting a source revision. Never steal a live lock.
export async function locked<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const dir = stateDir(root); mkdirSync(dir, { recursive: true });
  const file = join(dir, "operation.lock");
  if (existsSync(file)) {
    const owner = JSON.parse(readFileSync(file, "utf8")) as { pid: number; host: string };
    let dead = false;
    if (owner.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    if (!dead) throw new Error("Another shipping operation owns the repository lock. Wait; do not bypass it.");
    // Rename is not a stale-lock CAS. Leave reclamation explicit to avoid racing two rescuers.
    throw new Error(`Stale shipping lock from exited PID ${owner.pid}; inspect and remove ${file}, then resume.`);
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, host: hostname(), ...(process.env.PI_SHIPPING_QUEUE_RUNNER === "1" ? { queue: true } : {}) }), { flag: "wx", mode: 0o600 });
  try { return await fn(); } finally { unlinkSync(file); }
}
