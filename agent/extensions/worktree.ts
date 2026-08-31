import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { textResult } from "./worktree/internal/tool-result.ts";

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
  const tracked = git(cwd, ["diff", "--binary", "HEAD", "--", ...paths]);
  if (!tracked.ok) return { error: tracked.message || "git diff failed" };
  const chunks = [tracked.stdout];
  for (const file of changed.files) {
    if (git(cwd, ["ls-files", "--error-unmatch", "--", file]).ok) continue;
    const absolute = resolve(cwd, file);
    if (!existsSync(absolute) || statSync(absolute).isDirectory()) continue;
    const untracked = git(cwd, ["diff", "--binary", "--no-index", "--", "/dev/null", file]);
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
  pi.registerTool({
    name: WORKTREE_TOOL_NAME,
    label: "Worktree",
    description: "Create, list, remove, export scoped patches from, or apply scoped patches to local Git worktrees. Never commits or pushes.",
    parameters: Type.Object({
      operation: Type.Union(OPERATIONS.map((value) => Type.Literal(value)), { description: "add | list | remove | export | apply" }),
      path: Type.Optional(Type.String({ description: "Worktree path for add, remove, or export; patch file path for apply." })),
      branch: Type.Optional(Type.String({ description: "Branch name for add." })),
      force: Type.Optional(Type.Boolean({ description: "Use only with remove." })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Repository-relative paths assigned to this patch." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = repositoryRoot(ctx?.cwd ?? process.cwd());
      if (!root) return textResult("cwd must be inside a Git repository.", true);
      const operation = params.operation as typeof OPERATIONS[number];
      const listed = () => {
        const result = git(root, ["worktree", "list", "--porcelain"]);
        return result.ok ? parseWorktreeList(result.stdout) : undefined;
      };
      if (operation === "list") {
        const worktrees = listed();
        return worktrees ? textResult(boundText(formatList(worktrees))) : textResult("git worktree list failed.", true);
      }
      if (operation === "add") {
        const branch = String(params.branch ?? `pi/wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`).trim();
        if (!branch) return textResult("branch must not be empty.", true);
        const target = resolve(params.path?.trim() || resolve(root, ".pi-worktrees", worktreeSlug(branch)));
        if (!allowedWorktreePath(root, target)) {
          return textResult("worktree path must stay under the repository or its parent directory.", true);
        }
        if (existsAndNotEmpty(target)) return textResult(`worktree path exists and is not empty: ${target}`, true);
        const branchExists = git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
        const result = git(root, branchExists
          ? ["worktree", "add", target, branch]
          : ["worktree", "add", "-b", branch, target]);
        if (!result.ok) return textResult(`git worktree add failed: ${result.message || "unknown error"}`, true);
        return textResult(`path: ${target}\nbranch: ${branch}\nPass task_start cwd="${target}" for a writing worker.`);
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
        const gitDirResult = git(root, ["rev-parse", "--git-dir"]);
        if (!gitDirResult.ok) return textResult("could not resolve the repository git directory.", true);
        const gitDir = resolve(root, gitDirResult.stdout.trim());
        const patchDir = resolve(gitDir, "pi-patches");
        mkdirSync(patchDir, { recursive: true });
        const patchPath = resolve(patchDir, `patch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.patch`);
        writeFileSync(patchPath, exported.patch, "utf8");
        return textResult(`patch: ${patchPath}\nfiles:\n${exported.files?.join("\n") ?? ""}\nApply with worktree operation="apply" path="${patchPath}" and the same paths.`);
      }
      if (operation === "apply") {
        if (!params.path?.trim()) return textResult("apply requires a patch file path.", true);
        const patchPath = resolve(params.path);
        if (!existsSync(patchPath) || !statSync(patchPath).isFile()) return textResult(`patch file not found: ${patchPath}`, true);
        const gitDirResult = git(root, ["rev-parse", "--git-dir"]);
        if (!gitDirResult.ok) return textResult("could not resolve the repository git directory.", true);
        const patchJail = resolve(root, gitDirResult.stdout.trim(), "pi-patches");
        if (!isPathInside(patchJail, patchPath)) return textResult("patch file must come from this repository's git pi-patches directory.", true);
        const assigned = normalizeAssignedPaths(root, params.paths);
        if (assigned.error || !assigned.paths) return textResult(assigned.error ?? "invalid paths", true);
        const patchText = readFileSync(patchPath, "utf8");
        const patchFiles = patchPaths(patchText);
        if (!patchFiles) return textResult("refusing apply; patch contains no recognized file paths.", true);
        const outside = patchFiles.filter((file) => !pathIsAssigned(file, assigned.paths!));
        if (outside.length) return textResult(`refusing apply; patch contains files outside assigned paths:\n${outside.join("\n")}`, true);
        const check = gitWithInput(root, ["apply", "--check", "--binary", "-"], patchText);
        if (!check.ok) return textResult(`git apply --check failed; no files changed:\n${check.message || "unknown conflict"}`, true);
        const applied = gitWithInput(root, ["apply", "--binary", "-"], patchText);
        if (!applied.ok) return textResult(`git apply failed:\n${applied.message || "unknown error"}`, true);
        try { unlinkSync(patchPath); } catch { /* best-effort cleanup */ }
        return textResult(`Applied scoped patch to ${root}.\nfiles:\n${patchFiles.join("\n")}`);
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
      const result = git(root, ["worktree", "remove", ...(params.force ? ["--force"] : []), target]);
      return result.ok ? textResult(`Removed worktree: ${target}`) : textResult(`git worktree remove failed: ${result.message || "unknown error"}`, true);
    },
  });
}
