import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { textResult } from "./worktree/internal/tool-result.ts";
import { registerShipping } from "./worktree/internal/shipping-tool.ts";
import { commonDir, commit, head, isAncestor, loadTask, locked, owns, registerTree, saveTree, scope, trees } from "./worktree/internal/shipping-state.ts";

export const WORKTREE_TOOL_NAME = "worktree";
export const GIT_TIMEOUT_MS = 30_000;
const OUTPUT_MAX_CHARS = 50_000;
const OUTPUT_MAX_LINES = 80;
const OPERATIONS = ["add", "list", "remove", "export", "apply"] as const;

type Worktree = { path: string; head?: string; branch?: string };

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function allowedWorktreePath(root: string, target: string): boolean {
  return isPathInside(resolve(root, ".."), target);
}

export function boundText(text: string): string {
  const clipped = text.length > OUTPUT_MAX_CHARS ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n...[truncated]` : text;
  const lines = clipped.split(/\r?\n/);
  return lines.length > OUTPUT_MAX_LINES ? `${lines.slice(0, OUTPUT_MAX_LINES).join("\n")}\n...[truncated]` : clipped;
}

export function parseWorktreeList(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7);
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export function worktreeSlug(branch: string): string {
  return branch.replace(/^refs\/heads\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true, shell: false });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { ok: !result.error && result.status === 0, stdout, stderr, message: result.error?.message ?? boundText([stdout, stderr].filter(Boolean).join("\n")) };
}

function gitWithInput(cwd: string, args: string[], input: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
    input,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { ok: !result.error && result.status === 0, stdout, stderr, message: result.error?.message ?? boundText([stdout, stderr].filter(Boolean).join("\n")) };
}

export function patchPaths(patchText: string): string[] | undefined {
  const files = new Set<string>();
  for (const line of patchText.split(/\r?\n/)) {
    const diff = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diff) {
      files.add(diff[1]);
      files.add(diff[2]);
      continue;
    }
    const traditional = /^(?:---|\+\+\+) (?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line);
    if (traditional && traditional[1] !== "/dev/null") files.add(traditional[1]);
  }
  return files.size ? [...files] : undefined;
}

function normalizeAssignedPaths(root: string, raw: unknown): { paths?: string[]; error?: string } {
  if (!Array.isArray(raw) || raw.length < 1) return { error: "paths must contain at least one repository-relative path." };
  const paths: string[] = [];
  for (const value of raw) {
    const candidate = String(value).trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!candidate || candidate === "." || isAbsolute(candidate)) return { error: `invalid assigned path: ${String(value)}` };
    if (!isPathInside(root, resolve(root, candidate))) return { error: `assigned path escapes repository: ${candidate}` };
    paths.push(candidate.replace(/\/$/, ""));
  }
  return { paths: [...new Set(paths)] };
}

function pathIsAssigned(file: string, paths: readonly string[]): boolean {
  const normalized = file.replace(/\\/g, "/");
  return paths.some((assigned) => normalized === assigned || normalized.startsWith(`${assigned}/`));
}

function changedFiles(cwd: string): { files?: string[]; error?: string } {
  const result = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!result.ok) return { error: result.message || "git status failed" };
  const files: string[] = [];
  const entries = result.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const target = entries[++i];
      if (target) files.push(file, target);
    } else files.push(file);
  }
  return { files: [...new Set(files)] };
}

function exportPatch(cwd: string, paths: readonly string[]): { patch?: string; files?: string[]; error?: string } {
  const changed = changedFiles(cwd);
  if (changed.error || !changed.files) return { error: changed.error };
  const outside = changed.files.filter((file) => !pathIsAssigned(file, paths));
  if (outside.length) return { error: `refusing export; changed files outside assigned paths:\n${outside.join("\n")}` };
  if (!changed.files.length) return { error: "worktree has no changes to export." };
  const tracked = git(cwd, ["--literal-pathspecs", "diff", "--binary", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--", ...paths]);
  if (!tracked.ok) return { error: tracked.message || "git diff failed" };
  const chunks = [tracked.stdout];
  for (const file of changed.files) {
    if (git(cwd, ["ls-files", "--error-unmatch", "--", file]).ok) continue;
    const absolute = resolve(cwd, file);
    if (!existsSync(absolute) || statSync(absolute).isDirectory()) continue;
    const untracked = git(cwd, ["diff", "--binary", "--src-prefix=a/", "--dst-prefix=b/", "--no-index", "--", "/dev/null", file]);
    if (untracked.ok || untracked.stdout) chunks.push(untracked.stdout);
    else return { error: untracked.message || `failed to export untracked file ${file}` };
  }
  return { patch: chunks.filter(Boolean).join("\n"), files: changed.files };
}

function repositoryRoot(cwd: string): string | undefined {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout.trim() : undefined;
}

function existsAndNotEmpty(target: string): boolean {
  if (!existsSync(target)) return false;
  try { return !statSync(target).isDirectory() || readdirSync(target).length > 0; } catch { return true; }
}

function formatList(worktrees: Worktree[]): string {
  return worktrees.map((worktree) => [
    `path: ${worktree.path}`,
    `branch: ${worktree.branch?.replace(/^refs\/heads\//, "") ?? "(detached)"}`,
    `HEAD: ${worktree.head ?? "(unknown)"}`,
  ].join("\n")).join("\n\n") || "No worktrees found.";
}

export default function worktreeExtension(pi: ExtensionAPI): void {
  registerShipping(pi);
  pi.registerTool({
    name: WORKTREE_TOOL_NAME,
    label: "Worktree",
    description: "Create, list, remove, export uncommitted scoped patches from, or apply scoped patches to Git worktrees. Records owner/base/task in Git-local metadata. Use shipping for committed worker integration and task cleanup. Never commits or pushes.",
    parameters: Type.Object({
      operation: Type.Union(OPERATIONS.map((value) => Type.Literal(value)), { description: "add | list | remove | export | apply" }),
      path: Type.Optional(Type.String({ description: "Worktree path for add, remove, or export; patch file path for apply." })),
      branch: Type.Optional(Type.String({ description: "Branch name for add." })),
      startPoint: Type.Optional(Type.String({ description: "Explicit starting commit/ref for add. Defaults to the task HEAD or current HEAD; dirty changes are not inherited." })),
      task: Type.Optional(Type.String({ description: "Shipping task slug owning this writer. Requires paths within that task's scope." })),
      force: Type.Optional(Type.Boolean({ description: "Use only with remove." })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Repository-relative paths assigned to this patch." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = repositoryRoot(ctx?.cwd ?? process.cwd());
      if (!root) return textResult("cwd must be inside a Git repository.", true);
      const operation = params.operation as typeof OPERATIONS[number];
      const execute = async () => {
      const listed = () => {
        const result = git(root, ["worktree", "list", "--porcelain"]);
        return result.ok ? parseWorktreeList(result.stdout) : undefined;
      };
      if (operation === "list") {
        const worktrees = listed();
        if (!worktrees) return textResult("git worktree list failed.", true);
        const ownership = trees(root);
        return textResult(boundText(formatList(worktrees) + "\n\nOwnership:\n" + ownership.filter(w => !w.removed).map(w => `${w.path}: task=${w.task ?? "unassigned"} owner=${w.owner} base=${w.base} state=${w.integrated ? "integrated" : w.settled ? "settled" : "working"}`).join("\n")));
      }
      if (operation === "add") {
        const branch = String(params.branch ?? `pi/wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`).trim();
        if (!branch) return textResult("branch must not be empty.", true);
        const target = resolve(params.path?.trim() || resolve(root, "..", `${basename(root)}-worktrees`, worktreeSlug(branch)));
        if (!allowedWorktreePath(root, target)) {
          return textResult("worktree path must stay under the repository or its parent directory.", true);
        }
        const task = params.task ? loadTask(root, params.task) : undefined;
        if (task && (task.cleaned || [task.branch, task.target].includes(branch))) throw new Error("Use a new worker branch for an open task, never its outcome/default branch.");
        const paths = task ? scope(params.paths ?? []) : undefined;
        if (task && paths?.some(p => !owns(task.paths, p))) throw new Error("Worker paths must be contained in task scope.");
        const base = commit(root, params.startPoint ?? (task ? head(task.root) : "HEAD"));
        if (task && !isAncestor(root, base, head(task.root))) throw new Error("Worker base must already be integrated in its task.");
        if (!git(root, ["check-ref-format", `refs/heads/${branch}`]).ok) throw new Error("Invalid branch name.");
        const owner = ctx.sessionManager?.getSessionId?.() ?? "unassigned";
        const prior = trees(root).find(w => w.path === target && !w.removed);
        if (existsAndNotEmpty(target)) {
          if (prior && prior.owner === owner && prior.task === params.task && prior.branch === branch && listed()?.some(w => resolve(w.path) === target && w.branch === `refs/heads/${branch}`)) return textResult(`path: ${target}\nbranch: ${branch}\nAlready registered; no changes made.`);
          return textResult(`worktree path exists and is not empty: ${target}`, true);
        }
        const branchExists = git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
        if (branchExists && commit(root, branch) !== base) throw new Error("Existing branch differs from startPoint; inspect and attach it explicitly.");
        registerTree(root, { version: 1, path: target, branch, base, owner, task: params.task, paths });
        const result = git(root, branchExists
          ? ["worktree", "add", target, branch]
          : ["worktree", "add", "-b", branch, target, base]);
        if (!result.ok) return textResult(`git worktree add failed (ownership retained for recovery): ${result.message || "unknown error"}`, true);
        return textResult(`path: ${target}\nbranch: ${branch}\nbase: ${base}\nowner: ${owner}\ntask: ${params.task ?? "unassigned"}\nDirty parent changes were not inherited.\nPass task_start cwd="${target}" for a writing worker.`);
      }
      if (operation === "export") {
        if (!params.path?.trim()) return textResult("export requires the source worktree path.", true);
        const source = resolve(params.path);
        const worktrees = listed();
        if (!worktrees?.some((worktree) => resolve(worktree.path) === source)) return textResult("export source must be a listed worktree.", true);
        const assigned = normalizeAssignedPaths(source, params.paths);
        if (assigned.error || !assigned.paths) return textResult(assigned.error ?? "invalid paths", true);
        const exported = exportPatch(source, assigned.paths);
        if (exported.error || !exported.patch) return textResult(exported.error ?? "patch export failed", true);
        const patchDir = resolve(commonDir(root), "pi-patches");
        mkdirSync(patchDir, { recursive: true });
        const patchPath = resolve(patchDir, `patch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.patch`);
        writeFileSync(patchPath, exported.patch, "utf8");
        return textResult(`patch: ${patchPath}\nfiles:\n${exported.files?.join("\n") ?? ""}\nApply with worktree operation="apply" path="${patchPath}" and the same paths.`);
      }
      if (operation === "apply") {
        if (!params.path?.trim()) return textResult("apply requires a patch file path.", true);
        const patchPath = resolve(params.path);
        if (!existsSync(patchPath) || !statSync(patchPath).isFile()) return textResult(`patch file not found: ${patchPath}`, true);
        const patchJail = resolve(commonDir(root), "pi-patches");
        if (!isPathInside(patchJail, patchPath)) return textResult("patch file must come from this repository's git pi-patches directory.", true);
        const assigned = normalizeAssignedPaths(root, params.paths);
        if (assigned.error || !assigned.paths) return textResult(assigned.error ?? "invalid paths", true);
        const patchText = readFileSync(patchPath, "utf8");
        const patchFiles = patchPaths(patchText);
        if (!patchFiles) return textResult("refusing apply; patch contains no recognized file paths.", true);
        const outside = patchFiles.filter((file) => !pathIsAssigned(file, assigned.paths!));
        if (outside.length) return textResult(`refusing apply; patch contains files outside assigned paths:\n${outside.join("\n")}`, true);
        const check = gitWithInput(root, ["apply", "--check", "--binary", "-"], patchText);
        if (!check.ok) {
          const reversed = gitWithInput(root, ["apply", "--reverse", "--check", "--binary", "-"], patchText);
          if (reversed.ok) return textResult("Patch is already present; no files changed. Retained patch is not proof of a durable commit.");
          return textResult(`git apply --check failed; no files changed:\n${check.message || "unknown conflict"}`, true);
        }
        const applied = gitWithInput(root, ["apply", "--binary", "-"], patchText);
        if (!applied.ok) return textResult(`git apply failed:\n${applied.message || "unknown error"}`, true);
        return textResult(`Applied scoped patch to ${root}. Patch retained until durable integration is confirmed.\nfiles:\n${patchFiles.join("\n")}`);
      }
      if (!params.path?.trim()) return textResult("remove requires path.", true);
      const target = resolve(params.path);
      if (resolve(target) === resolve(root)) return textResult("Refusing to remove the main worktree.", true);
      if (!allowedWorktreePath(root, target)) {
        return textResult("Refusing to remove a worktree outside the repository or its parent directory.", true);
      }
      const worktrees = listed();
      if (!worktrees) return textResult("git worktree list failed.", true);
      if (!worktrees.some((worktree) => resolve(worktree.path) === target)) return textResult("Refusing to remove a path that is not a listed worktree.", true);
      if (trees(root).some(w => w.path === target && w.task && !w.removed)) return textResult("Task-owned worktrees must be retired through shipping cleanup with integration proof.", true);
      const result = git(root, ["worktree", "remove", ...(params.force ? ["--force"] : []), target]);
      const record = trees(root).find(w => w.path === target && !w.removed);
      if (result.ok && record) { record.removed = true; saveTree(root, record); }
      return result.ok ? textResult(`Removed worktree: ${target}`) : textResult(`git worktree remove failed: ${result.message || "unknown error"}`, true);
      };
      try { return operation === "list" ? await execute() : await locked(root, execute); }
      catch (e) { return textResult(e instanceof Error ? e.message : String(e), true); }
    },
  });
}
