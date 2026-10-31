---
name: shipping
description: Task-scoped Git delivery and cleanup. Use before creating worker worktrees, when committing/pushing, opening or landing PRs, running /ship, recovering an interrupted closeout, or consolidating completed tasks. Separates local, PR, shipped, and installed outcomes; preserves unrelated and active work.
---

# Shipping

One outcome, one task branch, one landing point. Execution mode decides who works; this contract decides what delivery means. Use the `shipping` tool for repeatable mechanics, not one-off reset/copy/stash scripts. In Pi mode work inline; other modes retain their routing. This skill does not authorize delegation.

## Permission and destination

- **local:** local work/checkpoints only when commits are authorized. A normal implementation request alone is not commit permission.
- **pr:** branch, scoped commits, push that branch, create/update its ready PR. `/poteto` grants this for its run when a verified GitHub destination and `gh` authentication are available.
- **ship:** finish the selected task through landing on its verified default branch and cleanup of its owned temporary branches/worktrees. `/ship`, or “ship when ready” in the goal, grants this scope. It includes scoped local checkpoint/integration commits and exact-tip cleanup, not unrelated work.
- “Don't commit” skips mutating Git operations. “Don't push” / “local only” overrides ship/PR permission. Investigation/Prototype remain read-only unless the user separately requests delivery of existing work.
- `confirm:true` attests actual user authorization; it cannot create permission. Carry the scope, destination, task id and permission in specialist briefs. `/ship ready` inventories completed tasks and asks once for the exact set before mutating anything.
- Merge/delete only task-owned artifacts. Never rewrite pushed history, bypass hooks/checks/protections, close unrelated issues, sweep upstream branches, or kill another session. Build, version bump, installer replacement, deployment and release publication require their own request.

## Release-only handoff

Ship, install or cleanup may run in fresh specialist context through the existing task mechanisms (`context: "fresh"` where offered). Send a compact brief, not the implementation transcript: repo and branch with exact revision (or dirty-diff identity), owned changed paths, artifact refs, permission scope, verification evidence with its exact revision and relevant environment, and unresolved decisions. The brief grants no permission beyond the stated scope; do not clear context automatically or restate it to the user.

## Register before splitting work

1. Run `shipping status`. Resolve the exact Git root, configured push remote, GitHub owner/repo when applicable, and default branch from that remote or `gh repo view --repo OWNER/REPO --json defaultBranchRef`. Do not assume `origin` is the fork or fall back silently to `main`. Fetch the selected target before recording its base. If ambiguous, ask once. Criterion: one unambiguous destination.
2. Use one task branch/checkout per independent outcome. Reuse it for sequential work. Keep unrelated dirty work in its existing checkout; create a clean outcome worktree when needed. Inspect and explicitly adopt existing changes only when the user included them. Criterion: owned paths and excluded changes listed.
3. `shipping begin` records an immutable contract: `task` slug, `base` SHA (usually merge-base with the selected remote target), `target`, owned `paths`, `delivery`, `route` (`pr`, or `direct` only when direct default-branch delivery is authorized), `remote`, explicit `repo` for GitHub, canonical `checks` as `{command,args}` entries, and repository-supported `mergeMethod`. Non-local delivery needs `confirm:true`. Existing dirty paths need `includeExisting:true` plus authorization. Resume an existing id; begin never silently replaces it. Criterion: status identifies the task and destination.
4. Parallel writers get `worktree add` with `task`, owned `paths`, `branch`, explicit `startPoint`, and `task_start cwd` set to that returned path. Start from a committed integration checkpoint: a new worktree does not inherit dirty parent changes. Sequential work can reuse the outcome checkout after its prior writer settles. Existing worker trees can be adopted with `shipping attach` only after checking their owner, base, commits and dirty files. Criterion: every writer artifact is attributable to one task.

When the accepted outcome legitimately needs more paths or a corrected canonical check contract, use `shipping amend` with the complete paths/checks and explicit permission. It may add scope, not drop earlier paths, and invalidates review/gates. It cannot change the destination. Do not use it to weaken a failed gate.

If a worker was abandoned, created unsuccessfully, or explicitly excluded by the user, use `shipping release` with its path, reason in `evidence`, and `confirm:true`. It removes the worker from this task's obligations without deleting its files or branch; the receipt retains the exclusion. A live worker stays preserved, never silently cleaned.

The records live under the repository's common Git directory (`pi-shipping/`), not in tracked files or one session's transcript. Status can recover them from any linked worktree. A stale operation lock names its exited owner; confirm no operation is running before removing that exact lock. Never remove a live or unknown-owner lock.

## Converge each milestone

1. Run the slice's local check, then `shipping checkpoint` with the inspected `expectedHead`, Conventional Commit `message`, and `confirm:true`; use `path` for a worker. It stages only dirty paths inside the recorded scope and refuses unrelated staged files. Keep tests and fixes as small, coherent commits. Preserve outside dirt. Criterion: work is in an identifiable commit, or clearly reported uncommitted when permission is absent.
2. Accept the worker's required review, close the worker and stop its owned writers/watchers, then `shipping settle` for its exact HEAD (`confirm:true` also attests inactivity). This is an explicit attestation, not inferred from an idle timestamp. `shipping integrate` merges that commit into the task checkout and records source/target SHAs. Conflicts stop: route a scoped fix, complete or explicitly abort the Git operation, then resume. Criterion: all required worker revisions are integrated.
3. Use `shipping cleanup` with `expectedHead` and `confirm:true` to retire integrated worker trees before starting the next milestone. This retains the outcome branch until it lands. Inspect ignored files first; preserve local data. Cleanup requires explicit `discardIgnored` paths for disposable ignored artifacts such as `node_modules`; unlisted ignored files block removal. The helper refuses dirty/advanced/unproven worker artifacts. No whole-file copy, blanket reset, force worktree removal, or automatic cleanup on session/task shutdown. Criterion: workers retired or named as preserved with a reason.

If commit permission is absent, preserve worker trees or scoped patches until authorized. `worktree export` exports **uncommitted** changes, not branch commits; retained patches and reverse-apply checks are not proof of durable integration.

## Verify and deliver

1. Stop all selected writers. Use a clean outcome checkout. Record the actual required review with `shipping review`, exact `expectedHead`, `verdict` and evidence pointer. `not-required` needs a concrete explanation permitted by the active mode; it is not a review bypass. Run `shipping verify` for that same SHA. Checks are the canonical commands registered at begin; a failed gate stops and returns to its owner. Criterion: required review and all gates cover the exact candidate.
2. A retry resumes successful gates only for unchanged HEAD and Node runtime. Any source change needs a checkpoint and fresh verification; environment/dependency changes also require `shipping verify fresh:true`. Never weaken a gate or switch packaging paths to make shipping pass. For changed scope or a mistaken check contract, stop and explicitly reconcile it rather than silently changing the registered contract. Criterion: no borrowed evidence from another tree/revision.
3. **local:** stop with the commit and next authorized action. **pr/ship with PR route:** `shipping publish` pushes the exact candidate and creates/updates one ready PR using explicit `--repo`. Supply its Conventional Commit title and body (`Why`, `What changed`, `Scope`, optional `Tradeoffs`, `Blast Radius`, `Verification`). Existing PR identity must match the task. Criterion: remote branch and ready/open PR confirmed.
4. **ship only:** use `shipping authorize` to promote an existing local/PR task when the user now requests shipping; this cannot change its destination. Then `shipping land` for the exact verified SHA. Direct route permits only a normal fast-forward remote update. PR route uses the registered strategy and `--match-head-commit`; no admin bypass. If the target advanced, use `shipping refresh` to merge it into the task and invalidate review/gates, then review/verify again. A merge conflict remains for its owner. Criterion: remote target contains the confirmed landing commit, or state is explicitly `pending-merge`/blocked.
5. For GitHub merge queues, pending is not merged. Resume `land` after checks/queue completion; do not spin-poll or clean up pending work. Use required checks/current-base protection or a merge queue on shared repos. Criterion: actual merge evidence, not merely an accepted CLI command.
6. Run `shipping cleanup` from the task checkout. It safely fast-forwards the local default branch, removes exact task branch tips only after confirmed landing, and leaves a default branch checked out elsewhere untouched. Remote deletion uses an exact-SHA lease solely for compare-and-delete; it never rewrites history. It retains the outcome checkout directory, which may be the user's current session cwd. Retire a separate outcome directory only after moving/ending that session and explicit inspection. Criterion: selected artifacts removed or explicit leftovers, unrelated work preserved.

Issues close only when actually fixed: use `Fixes #N` on the task PR for automatic closure. Adjacent bugs remain separate issues, not cleanup targets. Release/install requests run the repository's canonical pipeline from the landed revision and report separate proof.

## Durable verify+land queue

- `shipping enqueue` (`task`, `expectedHead`, `confirm:true`) queues a detached Pi Durable job to verify and land an exact candidate. It requires existing `delivery: "ship"`, applicable exact-SHA `shipping review`, and explicit user authorization to verify+land; an implementation request is not permission to ship.
- The detached Pi Durable runner executes only the existing canonical `verify` checks and then existing `land` for that exact `expectedHead` — no `publish`, conflict resolution, or `cleanup`. It stops on check/land failures or if `HEAD` or review/approval changes.
- The queue survives Pi session exit and resumes the current repository on the next Pi project opening after a machine restart; it is not an always-on OS service.
- `shipping queue_status` (`task` optional) is read-only. `pending-merge` means the candidate has not landed. After inspecting a stopped or `pending-merge` job and confirming authorization, run an explicit `shipping enqueue` again to resume.

## Final receipt

Always state:
- Task, delivery target, repository/remote/default branch.
- Local commit and remote landing commit; PR URL and observed state when relevant.
- Checks/review and the exact revision they cover; failures or unverified surfaces.
- Worker trees/branches removed; active/unrelated artifacts preserved and why.
- Release/install/deploy status, including `not requested`.
- Next step if blocked, pending merge, local-only or PR-only.

“Published”, “landed”, “cleaned” and “installed” are distinct states. A completed implementation is not a completed ship.
