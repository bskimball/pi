---
name: shipping
description: Task-scoped Git delivery and cleanup. Use before creating worker worktrees, when committing/pushing, opening or landing PRs, running /ship, recovering an interrupted closeout, or consolidating completed tasks. Separates local, PR, shipped, and installed outcomes; preserves unrelated and active work.
---

# Shipping

Execution mode decides who works; this skill decides what delivery means. In Pi mode work inline; other modes keep their routing. This skill does not authorize delegation.

## Pick the lightest route

- **No delivery asked:** ordinary local edits need nothing here — no branch, commit, or record. Report "local only".
- **Simple:** the user asks to commit or push work in the current checkout (no worker worktrees, no landing). Use plain Git: stage only your own task paths by name, Conventional Commit message, never `git add -A` over others' dirt, push only if asked. Report the commit SHA and remote evidence.
- **Tracked (`shipping` tool):** isolated parallel writers, `/ship`, PR landing on a default branch, durable verify+land, or resuming an interrupted closeout. Follow the rest of this skill.

## Permission

- **local:** checkpoint commits only when commits are authorized. An implementation request alone is not commit permission.
- **pr:** branch, scoped commits, push that branch, create/update its ready PR. `/poteto` grants this for its run.
- **ship:** finish the selected task through landing on its verified default branch and cleanup of its own temporary branches/worktrees. `/ship` or "ship when ready" grants this — for that task only.
- "Don't commit" skips mutating Git; "don't push"/"local only" overrides PR/ship. Read-only work stays read-only.
- `confirm:true` attests actual user authorization; it cannot create permission. Carry scope, destination, task id, and permission in specialist briefs.
- Touch only task-owned artifacts. Never rewrite pushed history, bypass hooks/checks/protections, close unrelated issues, sweep branches, or kill another session. Build, version bump, install, deploy, and release need their own request.

## Tracked workflow

Records live under the repo's common Git dir (`pi-shipping/`) and are visible from any linked worktree. Every mutating operation takes the inspected `expectedHead` where revision-sensitive.

1. **Register.** `shipping status`, then resolve the Git root, the configured push remote, GitHub `owner/repo`, and the remote's default branch (`gh repo view --repo OWNER/REPO --json defaultBranchRef`) — never assume `origin` or `main`; fetch the target. Ask once if ambiguous. `shipping begin` records `task`, `base` SHA, `target`, owned `paths`, `delivery`, `route` (`pr`, or `direct` only when authorized), `remote`, `repo`, canonical `checks` (`{command,args}`, no shell scripts), and `mergeMethod`. Non-local delivery needs `confirm:true`; adopting existing dirty paths needs `includeExisting:true` plus authorization. Resume an existing id; begin never replaces one.
2. **Split writers.** One task branch/checkout per outcome; sequential work reuses it. Parallel writers get `worktree add` (task, paths, branch, explicit committed `startPoint`) and that path as `task_start cwd` — new worktrees don't inherit dirty parent changes. Adopt an existing worker tree with `shipping attach` after checking owner, base, commits, dirt.
3. **Adjust.** `shipping amend` adds paths or corrects checks with permission; it can't drop paths, change destination, or weaken a failed gate, and it invalidates review/gates. `shipping release` (path, reason in `evidence`, `confirm:true`) drops an abandoned/excluded worker from obligations without deleting it.
4. **Converge each milestone.** Local check → `shipping checkpoint` (`expectedHead`, Conventional `message`, `confirm:true`, `path` for a worker; stages only in-scope dirty paths). Accept review, stop the worker's writers/watchers, `shipping settle` its exact HEAD (`confirm:true` also attests inactivity), `shipping integrate` into the task checkout. Conflicts stop for a scoped fix. `shipping cleanup` retires integrated worker trees; list disposable ignored paths in `discardIgnored` (unlisted ignored files block removal). No blanket reset, whole-file copy, or force removal. Without commit permission, preserve worker trees; `worktree export` patches are not integration proof.
5. **Verify.** All writers stopped, clean outcome checkout. `shipping review` records the required review for the exact SHA (`not-required` needs a concrete mode-permitted reason). `shipping verify` runs the registered checks; a failure returns to its owner. Retries reuse gates only for unchanged HEAD and Node runtime; source changes need a new checkpoint, environment/dependency changes need `fresh:true`.
6. **Deliver.** *local:* stop with the commit. *pr/ship via PR:* `shipping publish` pushes the exact candidate and creates/updates one ready PR with explicit `--repo`, a Conventional title, and a body (Why, What changed, Scope, Verification; optional Tradeoffs, Blast Radius). *ship:* `shipping authorize` promotes an existing task when the user now asks to ship (destination unchanged), then `shipping land` for the verified SHA — direct route fast-forward only; PR route uses `--match-head-commit`, no admin bypass. If the target advanced, `shipping refresh` and review/verify again. A merge queue's pending state is not merged: resume `land` later, don't spin-poll.
7. **Clean up.** `shipping cleanup` from the task checkout fast-forwards the local default branch and deletes exact task branch tips (remote via exact-SHA lease) only after confirmed landing. It keeps the outcome checkout, which may be the session cwd.

Stale operation locks name their exited owner; remove one only after confirming nothing runs. Never remove a live or unknown-owner lock. Close issues only when fixed (`Fixes #N` on the task PR).

## Durable verify+land queue

`shipping enqueue` (`task`, `expectedHead`, `confirm:true`) queues a detached Pi Durable job that runs the registered `verify` then `land` for that exact SHA — no publish, conflict fix, or cleanup. It needs `delivery: "ship"`, an exact-SHA review, and explicit authorization to verify+land. It survives Pi exit and resumes on the next project opening after a restart; it stops on failure or if HEAD/review changes. `shipping queue_status` is read-only; re-`enqueue` to resume after inspecting a stopped or `pending-merge` job.

## Release-only handoff

Ship/install/cleanup may run in a fresh specialist context with a compact brief: repo, branch, exact revision (or dirty-diff identity), owned paths, artifact refs, permission scope, verification evidence with its revision and environment, unresolved decisions. The brief grants nothing beyond its stated scope.

## Final receipt

State: task and destination (repo/remote/default branch); local commit and landing commit; PR URL and observed state; checks/review and the revision they cover; worker trees/branches removed and anything preserved with why; release/install/deploy status (including `not requested`); next step if blocked, pending merge, local-only, or PR-only. "Published", "landed", "cleaned", and "installed" are distinct; a completed implementation is not a completed ship.
