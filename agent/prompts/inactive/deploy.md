---
description: Delegate lint, format, verify, and deploy to the stevedore subagent
argument-hint: "[target or extra instructions, e.g. 'staging' or 'wrangler, skip tests']"
deterministic:
  run: |
    set -e
    echo "session_cwd=$(pwd)"
    if git rev-parse --show-toplevel >/dev/null 2>&1; then
      echo "git_toplevel=$(git rev-parse --show-toplevel)"
      echo "git_branch=$(git branch --show-current 2>/dev/null || true)"
      echo "git_head=$(git rev-parse --short HEAD 2>/dev/null || true)"
      echo "--- git status --short --branch ---"
      git status --short --branch
      echo "--- git worktree list ---"
      git worktree list
      echo "--- dirty summary ---"
      echo "modified_tracked=$(git diff --name-only | wc -l | tr -d ' ')"
      echo "staged=$(git diff --cached --name-only | wc -l | tr -d ' ')"
      echo "untracked=$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"
    else
      echo "git_toplevel="
      echo "NOT_A_GIT_REPO=1"
    fi
  handoff: always
  timeout: 30000
---
Ship the current project using the stevedore subagent: $@

Delegate all lint, format, test, build, and deployment execution to the stevedore subagent. Do not run the deploy directly or edit project files yourself.

## Scope
- Target: the active repository worktree identified in the pre-step snapshot.
- Arguments: extra deploy instructions or target environment ($@). If empty, use the project's default deployment target.
- In scope: resolving the absolute worktree path, auditing the complete dirty file inventory, assembling a self-contained brief, delegating via `task`, and answering or relaying `need_decision`.
- Out of scope: executing deploy commands directly in the supervisor session, shipping from an unverified worktree, deploying from `~/.pi` unless that is the explicit target, or omitting uncommitted project changes.

## Resolve
Use the deterministic pre-step snapshot to establish the release baseline before delegating:
1. Determine the absolute worktree path: set worktree path to `git_toplevel` when present, otherwise fallback to `session_cwd`. On Windows, use a native path (`C:/Users/...`), never a bash-only path (`/c/...`). Criterion: absolute native worktree path determined.
2. Confirm target repository identity: verify you are shipping this exact worktree (branch and dirty files from the snapshot), not a sibling worktree, not `~/.pi`, and not another project inferred from conversation history. Criterion: target worktree identity confirmed against snapshot.
3. Disambiguate worktrees: if `git worktree list` shows multiple worktrees and the release target is ambiguous, stop and ask the user; do not guess. Criterion: target worktree unambiguous or decision requested.
4. Inventory release contents: treat the dirty tree as the release contents. Inventory all modified, staged, and untracked project files from the snapshot. Never deploy a partial subset of recent files while leaving related dirty changes uncommitted or unreleased. Criterion: complete dirty inventory recorded.

## Delegate
Delegate deployment only after resolving the absolute worktree path and verifying the release inventory.

Call the `task` tool once with:
- `agent`: `stevedore`
- `cwd`: the absolute worktree path from Resolve (**required** — always pass it explicitly)
- `prompt`: a complete, self-contained brief (stevedore has no access to conversation history)

Build the brief from:
- Absolute working directory (repeat the same path passed as `cwd`)
- Branch and HEAD commit from the snapshot
- Full dirty-file inventory (or "clean") from the snapshot — not a selective subset
- Relevant conversation context (what changed, target environment, known gotchas)
- Extra instructions: $@ (if blank, instruct stevedore to use the project's default deploy target)

Instruct stevedore in the brief to:
1. Work exclusively inside the provided absolute `cwd` / worktree. Refuse execution if `pwd` or `git rev-parse --show-toplevel` does not match.
2. Re-run `git status --short --branch` and reconcile against the inventory in the brief. If the tree changed, use live status and report the delta.
3. Discover the project's own lint, format, typecheck, test, build, and deploy scripts from package configuration or repository conventions.
4. Run lint and format checks, fixing only mechanical issues.
5. Run build and tests; a failing build blocks deploy.
6. Enforce worktree completeness for release:
   - Default: deploy the entire current worktree (all current project changes on disk), not a hand-picked subset.
   - If commit or push is required or requested, stage and commit the full intended project change set (prefer repository-scoped `git add -A` after reviewing status). Never partially stage a feature while leaving related project files dirty.
   - Exclude only true noise, secrets, and generated artifacts (`node_modules/`, ignored build output, `.env*`, credentials, local scratch). If unsure whether a dirty file belongs in the release, stop with `need_decision` instead of omitting it silently.
   - After any commit: re-run `git status`. If project files that should have shipped remain dirty or untracked, fix staging and amend only if the commit has not been pushed and the brief permits; otherwise create a follow-up commit or stop and report. Never report success with a partial commit.
7. Deploy to the stated target. If the target is ambiguous, contact the supervisor with `need_decision` instead of guessing.
8. Verify the deployment and report results in structured format, including final `git status`.

If stevedore contacts you with `need_decision`, answer from context or relay the question to the user. Criterion: stevedore subagent dispatched with complete brief and explicit `cwd`.

## Report
When stevedore finishes, provide a structured summary:
- Worktree path and branch
- Pre-flight check results (lint, format, tests, build)
- Release completeness confirmation (verifying full dirty set was included)
- Target and deployment outcome (what was deployed where)
- Verification results and final `git status`
- Any follow-ups or open issues

Wait for stevedore to complete and report, or relay its questions if a decision is needed.

## Pre-step snapshot
The deterministic pre-step runs prior to this prompt and provides session cwd, git toplevel, branch, commit, short status, worktree list, and dirty file counts.
