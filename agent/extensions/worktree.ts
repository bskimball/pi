import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { textResult } from "./worktree/internal/tool-result.ts";

export const WORKTREE_TOOL_NAME = "worktree";
export const GIT_TIMEOUT_MS = 30_000;
const OUTPUT_MAX_CHARS = 50_000;
const OUTPUT_MAX_LINES = 80;
const OPERATIONS = ["add", "list", "remove"] as const;

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
    description: "Create, list, or remove local Git worktrees. Never commits or pushes.",
    parameters: Type.Object({
      operation: Type.Union(OPERATIONS.map((value) => Type.Literal(value)), { description: "add | list | remove" }),
      path: Type.Optional(Type.String({ description: "Worktree path for add or remove." })),
      branch: Type.Optional(Type.String({ description: "Branch name for add." })),
      force: Type.Optional(Type.Boolean({ description: "Use only with remove." })),
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
