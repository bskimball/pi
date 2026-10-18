import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import {
  assertScope, branch, checkTree, clean, commit, commonDir, digest, dirty, git, head,
  isAncestor, listedTrees, loadTask, locked, owns, refHead, registerTree, repositoryRoot, saveTask, saveTree,
  scope, taskExists, tasks, trees, type Check, type Delivery, type OwnedTree, type Task,
} from "./shipping-state.ts";

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
export type ShippingInput = {
  operation: "begin" | "status" | "authorize" | "amend" | "attach" | "release" | "checkpoint" | "settle" | "integrate" | "refresh" | "review" | "verify" | "publish" | "land" | "cleanup";
  task?: string; path?: string; paths?: string[]; base?: string; delivery?: Delivery; route?: "pr" | "direct";
  remote?: string; repo?: string; target?: string; checks?: Check[]; mergeMethod?: Task["mergeMethod"];
  confirm?: boolean; includeExisting?: boolean; expectedHead?: string; message?: string;
  fresh?: boolean; discardIgnored?: string[];
  verdict?: NonNullable<Task["review"]>["verdict"]; evidence?: string; title?: string; body?: string;
};
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined || value === "") throw new Error(`${label} is required.`);
  return value;
}
function authorization(p: ShippingInput): void { if (!p.confirm) throw new Error("This operation requires confirm:true and explicit user authorization for this task/action."); }
function current(t: Task, expected?: string): string {
  if (branch(t.root) !== t.branch) throw new Error("Task checkout changed branches; reconcile before shipping.");
  const sha = head(t.root);
  if (expected !== undefined && expected !== sha) throw new Error("HEAD changed since inspection; inspect the new diff first.");
  assertScope(t.root, t.base, sha, t.paths);
  return sha;
}
function ownedTree(root: string, task: string, path: string): OwnedTree {
  const tree = trees(root).find(w => w.path === resolve(path) && w.task === task);
  if (!tree) throw new Error("Worktree is not owned by this task; inspect and attach it explicitly first.");
  return tree;
}
function remoteUrl(t: Task): string {
  const name = required(t.remote, "remote");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("Use a configured remote name, not a URL or option.");
  const urls = git(t.root, ["remote", "get-url", "--push", "--all", name]).split("\n");
  const fetch = git(t.root, ["remote", "get-url", name]);
  if (urls.length !== 1 || urls[0] !== fetch) throw new Error("Multiple or different fetch/push URLs require explicit repository reconciliation.");
  return urls[0];
}
function githubRepo(url: string): string | undefined {
  const m = /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m?.[1];
}
function checkRemote(t: Task): void {
  if (digest(remoteUrl(t)) !== t.remoteHash) throw new Error("Remote identity changed since task registration.");
}
function noPendingWorkers(t: Task): void {
  const pending = trees(t.root).filter(w => w.task === t.id && !w.removed && (!w.integrated || !w.settled || w.integrated.head !== w.settled));
  if (pending.length) throw new Error(`Integrate or explicitly reconcile remaining workers first: ${pending.map(w => w.path).join(", ")}`);
  for (const w of trees(t.root).filter(w => w.task === t.id && !w.removed)) {
    checkTree(t.root, w); clean(w.path);
    if (head(w.path) !== w.integrated?.head) throw new Error("Worker changed after integration; settle and integrate its new revision first.");
  }
}
function ready(t: Task, expected: string): string {
  const sha = current(t, expected); clean(t.root); noPendingWorkers(t);
  if (!t.checks.length || t.gates?.head !== sha || t.gates.passed !== t.checks.length || t.gates.runtime !== process.version) throw new Error("Required checks have not passed for this exact revision/runtime.");
  if (t.review?.head !== sha || t.review.verdict === "block") throw new Error("Record the applicable review verdict and evidence for this exact revision first.");
  return sha;
}
async function run(exec: Exec, t: Task, command: string, args: string[], signal?: AbortSignal): Promise<string> {
  const r = await exec(command, args, { cwd: t.root, timeout: 120_000, signal });
  if (r.code !== 0 || r.killed) throw new Error(`${command} failed (${r.code}${r.killed ? ", killed" : ""}):\n${(r.stderr || r.stdout).slice(-6000)}`);
  return r.stdout.trim();
}
async function fetchTarget(exec: Exec, t: Task, signal?: AbortSignal): Promise<string> {
  checkRemote(t);
  await run(exec, t, "git", ["fetch", t.remote!, `refs/heads/${t.target}:refs/remotes/${t.remote}/${t.target}`], signal);
  return commit(t.root, `refs/remotes/${t.remote}/${t.target}`);
}
function mustIncludeTarget(t: Task, sha: string, target: string): void {
  if (!isAncestor(t.root, target, sha)) throw new Error("The target branch advanced. Integrate its changes, review, and verify the new candidate before landing.");
}
type PullRequest = {
  number: number; url: string; state: string; isDraft: boolean; headRefOid: string;
  headRefName: string; baseRefName: string; headRepository: { nameWithOwner: string } | null;
  mergeCommit: { oid: string } | null;
};
const PR_FIELDS = "number,url,state,isDraft,headRefOid,headRefName,baseRefName,headRepository,mergeCommit";
function validPR(t: Task, pr: PullRequest, sha: string): void {
  if (pr.headRefOid !== sha || pr.headRefName !== t.branch || pr.baseRefName !== t.target || pr.headRepository?.nameWithOwner.toLowerCase() !== t.repo?.toLowerCase()) throw new Error("PR identity/head differs from this task's approved repository, branch, base or revision.");
}
async function readPR(exec: Exec, t: Task, signal?: AbortSignal): Promise<PullRequest> {
  return JSON.parse(await run(exec, t, "gh", ["pr", "view", String(required(t.pr, "PR").number), "--repo", t.repo!, "--json", PR_FIELDS], signal));
}
function taskSummary(t: Task, metadataRoot = t.root): object {
  const present = existsSync(t.root);
  const sha = present ? head(t.root) : undefined;
  const pendingFiles = present ? dirty(t.root) : [];
  let isReady = false;
  let blocker: string | undefined;
  if (!t.cleaned && !t.landed && sha) {
    try { ready(t, sha); isReady = true; } catch (e) { blocker = e instanceof Error ? e.message : String(e); }
  }
  const workers = trees(metadataRoot).filter(w => w.task === t.id || w.released?.task === t.id).map(w => ({ ...w, dirty: !w.removed && existsSync(w.path) ? dirty(w.path) : undefined }));
  return {
    task: t.id, owner: t.owner, root: t.root, branch: present ? listedTrees(metadataRoot).find(w => resolve(w.path) === t.root)?.branch ?? "detached" : "missing", head: sha,
    delivery: t.delivery, route: t.route, remote: t.remote, repo: t.repo, target: t.target,
    state: t.cleaned ? "cleaned" : t.landed ? "landed" : pendingFiles.length ? "working" : t.published === sha ? "published" : t.gates?.head === sha && t.gates?.passed === t.checks.length ? "verified" : "working",
    ready: isReady, blocker,
    paths: t.paths, dirty: pendingFiles, workers, checks: t.checks, gates: t.gates,
    review: t.review, pr: t.pr, landed: t.landed,
  };
}
export function inventory(root: string, id?: string): object {
  return {
    tasks: (id ? [loadTask(root, id)] : tasks(root)).map(t => taskSummary(t, root)),
    worktrees: listedTrees(root).map(w => ({ ...w, owner: trees(root).find(t => t.path === resolve(w.path) && !t.removed)?.owner ?? "unowned", dirty: existsSync(w.path) ? dirty(w.path) : "worktree missing; preserve metadata for recovery" })),
  };
}

export async function shipping(cwd: string, owner: string, p: ShippingInput, exec: Exec, signal?: AbortSignal): Promise<object> {
  const root = repositoryRoot(cwd);
  if (p.operation === "status") return inventory(root, p.task);
  return locked(root, async () => {
    const id = required(p.task, "task");
    if (p.operation === "begin") {
      if (taskExists(root, id)) return taskSummary(loadTask(root, id)); // An existing contract is never silently replaced.
      const paths = scope(required(p.paths, "paths"));
      if (!p.includeExisting && dirty(root).some(f => owns(paths, f))) throw new Error("Owned paths already contain changes. Inspect them and explicitly authorize includeExisting:true, or use a clean task worktree.");
      if (p.includeExisting) authorization(p);
      const target = required(p.target, "target default branch"); git(root, ["check-ref-format", `refs/heads/${target}`]);
      const t: Task = {
        version: 1, id, owner, root, branch: branch(root), base: commit(root, required(p.base, "base revision")), paths,
        target, delivery: p.delivery ?? "local", route: p.route ?? "pr", checks: p.checks ?? [], mergeMethod: p.mergeMethod ?? "squash",
        remote: p.remote, repo: p.repo,
      };
      if (t.delivery !== "local") authorization(p);
      if (t.remote) {
        const url = remoteUrl(t); t.remoteHash = digest(url);
        if (t.route === "pr" && (!t.repo || githubRepo(url)?.toLowerCase() !== t.repo.toLowerCase())) throw new Error("Explicit GitHub owner/repo must match the configured remote (not its upstream).");
      }
      if (t.delivery === "pr" && t.route !== "pr") throw new Error("PR delivery requires the PR route.");
      if (t.delivery !== "local" && (!t.remote || !t.checks.length)) throw new Error("Published delivery requires a configured remote and canonical verification commands.");
      if (t.route === "pr" && t.delivery !== "local" && t.branch === target) throw new Error("PR delivery requires a task branch, not the default branch.");
      for (const check of t.checks) if (!check.command || check.command.startsWith("-") || !Array.isArray(check.args)) throw new Error("Checks require an executable and argv array, not a shell script.");
      assertScope(root, t.base, head(root), paths);
      const collision = tasks(root).find(other => !other.cleaned && other.root === root && other.branch === t.branch);
      if (collision) throw new Error(`Checkout already belongs to task ${collision.id}; resume it or use an isolated task worktree.`);
      saveTask(root, t); return taskSummary(t);
    }
    const t = loadTask(root, id);
    if (t.cleaned) {
      if (p.operation === "cleanup") return taskSummary(t);
      throw new Error("Task is closed. Start a new outcome rather than modifying its delivery record.");
    }
    if (p.operation === "amend") {
      authorization(p);
      const paths = p.paths ? scope(p.paths) : t.paths;
      if (t.paths.some(f => !owns(paths, f))) throw new Error("Reconciliation may add owned paths, not drop earlier obligations.");
      t.paths = paths;
      if (p.checks) {
        if (!p.checks.length || p.checks.some(c => !c.command || !Array.isArray(c.args))) throw new Error("Supply the complete canonical check contract.");
        t.checks = p.checks;
      }
      delete t.gates; delete t.review; saveTask(root, t); return taskSummary(t);
    }
    if (p.operation === "authorize") {
      authorization(p);
      if (!t.remote || !t.checks.length) throw new Error("Task lacks a remote/check contract; register a properly scoped delivery task.");
      if (p.delivery === "pr" && t.route !== "pr") throw new Error("Direct tasks cannot be published as PRs without a new explicit contract.");
      t.delivery = required(p.delivery, "delivery"); saveTask(root, t); return taskSummary(t);
    }
    if (p.operation === "release") {
      authorization(p);
      const w = ownedTree(root, id, required(p.path, "path"));
      w.released = { task: id, reason: required(p.evidence, "reason for excluding this worker from the outcome").slice(0, 2000) };
      delete w.task; saveTree(root, w);
      return taskSummary(t);
    }
    if (p.operation === "attach") {
      authorization(p);
      const path = repositoryRoot(required(p.path, "path"));
      if (path === t.root || commonDir(path) !== commonDir(root)) throw new Error("Attach a different worktree from this repository.");
      if ([t.branch, t.target].includes(branch(path))) throw new Error("The task/default branch cannot be adopted as a disposable worker.");
      const existing = trees(root).find(w => w.path === path && !w.removed);
      if (existing?.task && existing.task !== id) throw new Error("Worktree belongs to another task.");
      if (existing && existing.owner !== owner) throw new Error("Existing owner must explicitly hand off this worktree before adoption.");
      const paths = scope(required(p.paths, "paths"));
      if (paths.some(f => !owns(t.paths, f))) throw new Error("Worker scope must be contained in task scope.");
      const base = commit(path, required(p.base, "worker base revision"));
      if (!isAncestor(root, base, head(t.root))) throw new Error("Worker base must already be integrated in the task.");
      assertScope(path, base, head(path), paths);
      registerTree(root, { version: 1, owner, task: id, path, branch: branch(path), base, paths });
      return taskSummary(t);
    }
    if (p.operation === "checkpoint") {
      authorization(p);
      const path = p.path ? repositoryRoot(p.path) : t.root;
      const w = path === t.root ? undefined : ownedTree(root, id, path);
      if (w) checkTree(root, w); else current(t);
      const expected = required(p.expectedHead, "expectedHead");
      if (head(path) !== expected) throw new Error("HEAD changed before checkpoint.");
      const paths = w?.paths ?? t.paths;
      if (git(path, ["diff", "--cached", "--name-only", "-z"]).split("\0").some(f => f && !owns(paths, f))) throw new Error("Unrelated staged changes exist; leave the index untouched and ask their owner.");
      const files = dirty(path).filter(f => owns(paths, f));
      if (files.length) {
        git(path, ["--literal-pathspecs", "add", "--", ...files]);
        git(path, ["diff", "--cached", "--check"]);
        git(path, ["--literal-pathspecs", "commit", "--only", "-m", required(p.message, "commit message"), "--", ...files]);
      }
      if (w) { delete w.settled; delete w.integrated; saveTree(root, w); }
      return { task: id, checkpoint: head(path), path, preserved: dirty(path) };
    }
    if (p.operation === "settle" || p.operation === "integrate") {
      const w = ownedTree(root, id, required(p.path, "path")); checkTree(root, w); clean(w.path);
      if (head(w.path) !== required(p.expectedHead, "expectedHead")) throw new Error("Worker HEAD changed since inspection.");
      assertScope(w.path, w.base, head(w.path), required(w.paths, "worker paths"));
      if (p.operation === "settle") {
        // This is an explicit caller attestation: the worker was closed and no process is writing.
        authorization(p); w.settled = head(w.path); saveTree(root, w); return taskSummary(t);
      }
      authorization(p); current(t); clean(t.root);
      if (w.settled !== head(w.path)) throw new Error("Close the worker, then settle this exact revision before integrating.");
      if (!isAncestor(root, w.base, head(t.root))) throw new Error("Worker base is not integrated in the target task.");
      if (!isAncestor(root, w.settled, head(t.root))) git(t.root, ["merge", "--no-ff", "--no-edit", w.settled]);
      w.integrated = { head: w.settled, commit: head(t.root) }; saveTree(root, w);
      return taskSummary(t);
    }
    if (p.operation === "refresh") {
      authorization(p); clean(t.root); noPendingWorkers(t);
      if (branch(t.root) !== t.branch || head(t.root) !== required(p.expectedHead, "expectedHead")) throw new Error("Task checkout changed since inspection.");
      const target = await fetchTarget(exec, t, signal);
      const fork = git(t.root, ["merge-base", target, "HEAD"]);
      assertScope(t.root, fork, head(t.root), t.paths);
      if (!isAncestor(root, target, head(t.root))) git(t.root, ["merge", "--no-ff", "--no-edit", target]);
      t.base = target; delete t.gates; delete t.review; saveTask(root, t);
      return taskSummary(t);
    }
    if (p.operation === "review") {
      const sha = current(t, required(p.expectedHead, "expectedHead")); clean(t.root); noPendingWorkers(t);
      t.review = { head: sha, verdict: required(p.verdict, "verdict"), evidence: required(p.evidence, "review evidence").slice(0, 2000) };
      saveTask(root, t); return taskSummary(t);
    }
    if (p.operation === "verify") {
      const sha = current(t, required(p.expectedHead, "expectedHead")); clean(t.root); noPendingWorkers(t);
      if (!t.checks.length) throw new Error("No verification commands registered; do not report a verified state.");
      if (p.fresh || t.gates?.head !== sha || t.gates.runtime !== process.version) t.gates = { head: sha, passed: 0, runtime: process.version, at: new Date().toISOString() };
      saveTask(root, t);
      for (let i = t.gates.passed; i < t.checks.length; i++) {
        const c = t.checks[i];
        const result = await exec(c.command, c.args, { cwd: t.root, timeout: 900_000, signal });
        current(t, sha); clean(t.root); noPendingWorkers(t);
        if (result.code !== 0 || result.killed) throw new Error(`Gate ${i + 1}/${t.checks.length} failed: ${c.command} ${c.args.join(" ")}\n${(result.stderr || result.stdout).slice(-6000)}`);
        t.gates.passed = i + 1; t.gates.at = new Date().toISOString(); saveTask(root, t);
      }
      return taskSummary(t);
    }
    if (p.operation === "publish") {
      authorization(p);
      if (t.delivery === "local" || t.route !== "pr") throw new Error("Publishing requires PR/ship delivery with the PR route.");
      const sha = ready(t, required(p.expectedHead, "expectedHead")); checkRemote(t);
      if (t.branch === t.target) throw new Error("Cannot open a PR from the target branch.");
      await run(exec, t, "git", ["push", t.remote!, `${sha}:refs/heads/${t.branch}`], signal);
      const remote = await run(exec, t, "git", ["ls-remote", "--heads", t.remote!, `refs/heads/${t.branch}`], signal);
      if (remote.split(/\s/)[0] !== sha) throw new Error("Remote branch does not match the verified candidate.");
      if (!t.pr) {
        const matches: PullRequest[] = JSON.parse(await run(exec, t, "gh", ["pr", "list", "--repo", t.repo!, "--head", t.branch, "--base", t.target, "--state", "all", "--json", PR_FIELDS], signal));
        if (matches.length > 1) throw new Error("Multiple PRs match; reconcile their identity rather than creating another.");
        if (!matches.length) {
          await run(exec, t, "gh", ["pr", "create", "--repo", t.repo!, "--head", t.branch, "--base", t.target, "--title", required(p.title, "PR title"), "--body", required(p.body, "PR body")], signal);
          const created: PullRequest[] = JSON.parse(await run(exec, t, "gh", ["pr", "list", "--repo", t.repo!, "--head", t.branch, "--base", t.target, "--state", "open", "--json", PR_FIELDS], signal));
          if (created.length !== 1) throw new Error("PR creation result is ambiguous; resume after inspecting remote state.");
          matches.push(created[0]);
        }
        validPR(t, matches[0], sha); t.pr = { number: matches[0].number, url: matches[0].url }; saveTask(root, t);
      }
      const pr = await readPR(exec, t, signal); validPR(t, pr, sha);
      if (pr.state !== "OPEN") throw new Error(`PR is ${pr.state}; do not republish a completed branch.`);
      if (p.body) await run(exec, t, "gh", ["pr", "edit", String(pr.number), "--repo", t.repo!, "--body", p.body], signal);
      if (pr.isDraft) await run(exec, t, "gh", ["pr", "ready", String(pr.number), "--repo", t.repo!], signal);
      const confirmed = await readPR(exec, t, signal); validPR(t, confirmed, sha);
      if (confirmed.state !== "OPEN" || confirmed.isDraft) throw new Error("PR is not confirmed ready/open.");
      t.published = sha; saveTask(root, t); return taskSummary(t);
    }
    if (p.operation === "land") {
      authorization(p);
      if (t.delivery !== "ship") throw new Error("Landing requires explicit ship authorization; PR completion is not merge permission.");
      if (t.landed) return taskSummary(t);
      const sha = ready(t, required(p.expectedHead, "expectedHead"));
      const target = await fetchTarget(exec, t, signal);
      if (t.route === "direct") {
        mustIncludeTarget(t, sha, target);
        await run(exec, t, "git", ["push", t.remote!, `${sha}:refs/heads/${t.target}`], signal);
        const landed = await fetchTarget(exec, t, signal);
        if (!isAncestor(root, sha, landed)) throw new Error("Remote target does not include the candidate.");
        t.landed = { head: sha, commit: sha };
      } else {
        let pr = await readPR(exec, t, signal); validPR(t, pr, sha);
        if (pr.state !== "MERGED") {
          if (pr.state !== "OPEN" || pr.isDraft) throw new Error("Only a ready, open task PR can land.");
          mustIncludeTarget(t, sha, target);
          await run(exec, t, "gh", ["pr", "merge", String(pr.number), "--repo", t.repo!, `--${t.mergeMethod}`, "--match-head-commit", sha], signal);
          pr = await readPR(exec, t, signal); validPR(t, pr, sha);
        }
        if (pr.state !== "MERGED" || !pr.mergeCommit?.oid) return { ...taskSummary(t), state: "pending-merge", next: "GitHub has not confirmed a merge. Resume land later; do not clean up yet." };
        const landed = await fetchTarget(exec, t, signal);
        if (!isAncestor(root, pr.mergeCommit.oid, landed)) throw new Error("PR merge commit is not on the remote target.");
        t.landed = { head: sha, commit: pr.mergeCommit.oid };
      }
      saveTask(root, t); return taskSummary(t);
    }
    // Cleanup is content-based and rerunnable. No blanket prune, force removal, stash or reset.
    authorization(p);
    if (root !== t.root) throw new Error("Run cleanup from the task checkout, not from a worker being removed.");
    const accepted = t.landed?.head ?? current(t, required(p.expectedHead, "expectedHead"));
    for (const w of trees(root).filter(w => w.task === id)) {
      if (!w.integrated || w.integrated.head !== w.settled || !isAncestor(root, w.integrated.head, accepted)) throw new Error(`Worktree has no durable integration proof: ${w.path}`);
      const listed = listedTrees(root).find(x => resolve(x.path) === w.path);
      if (listed) {
        checkTree(root, w); clean(w.path);
        if (head(w.path) !== w.integrated.head) throw new Error("Worker advanced after integration; preserve it.");
        const ignored = git(w.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).split("\0").filter(Boolean);
        const discard = p.discardIgnored?.length ? scope(p.discardIgnored) : [];
        if (ignored.some(f => !owns(discard, f.replace(/\/$/, "")))) throw new Error(`Ignored files require inspection and explicit discardIgnored paths: ${ignored.slice(0, 20).join(", ")}`);
        git(root, ["worktree", "remove", w.path]);
      } else if (existsSync(w.path)) throw new Error("Unregistered path still exists; preserve it for inspection.");
      const ref = `refs/heads/${w.branch}`;
      const found = refHead(root, ref);
      if (found && found !== w.integrated.head) throw new Error("Worker branch advanced; preserve it.");
      if (found) {
        if (listedTrees(root).some(x => x.branch === w.branch)) throw new Error("Worker branch is checked out elsewhere.");
        git(root, ["update-ref", "-d", ref, found]);
      }
      w.removed = true; saveTree(root, w);
    }
    if (!t.landed) return { ...taskSummary(t), next: "Worker artifacts retired. Task branch retained until landing." };
    const remoteTarget = await fetchTarget(exec, t, signal);
    if (!isAncestor(root, t.landed.commit, remoteTarget)) throw new Error("Remote no longer contains the recorded landing; preserve task branch.");
    clean(t.root);
    if (branch(t.root) !== t.target) {
      if (branch(t.root) !== t.branch || head(t.root) !== t.landed.head) throw new Error("Checkout changed after landing; preserve it.");
      if (listedTrees(root).some(w => w.branch === t.target && resolve(w.path) !== t.root)) throw new Error("Default branch is checked out elsewhere; leave that active checkout untouched.");
      if (refHead(root, `refs/heads/${t.target}`)) git(t.root, ["switch", t.target]);
      else git(t.root, ["switch", "-c", t.target, `refs/remotes/${t.remote}/${t.target}`]);
    }
    git(t.root, ["merge", "--ff-only", `refs/remotes/${t.remote}/${t.target}`]);
    if (t.branch !== t.target) {
      const ref = `refs/heads/${t.branch}`;
      const local = refHead(root, ref);
      if (local && local !== t.landed.head) throw new Error("Task branch has additional commits; preserve it.");
      if (listedTrees(root).some(w => w.branch === t.branch)) throw new Error("Task branch is checked out elsewhere; preserve it.");
      if (local) git(root, ["update-ref", "-d", ref, local]);
      const remote = await run(exec, t, "git", ["ls-remote", "--heads", t.remote!, ref], signal);
      if (remote) {
        if (remote.split(/\s/)[0] !== t.landed.head) throw new Error("Remote task branch advanced; preserve it.");
        // Exact compare-and-delete: this lease cannot rewrite history or delete a newer tip.
        await run(exec, t, "git", ["push", t.remote!, `--force-with-lease=${ref}:${t.landed.head}`, `:${ref}`], signal);
        if (await run(exec, t, "git", ["ls-remote", "--heads", t.remote!, ref], signal)) throw new Error("Remote branch deletion is not confirmed.");
      }
    }
    t.cleaned = true; saveTask(root, t); return taskSummary(t);
  });
}
