---
description: Deploy an approved, verified revision through Stevedore; Git closeout stays task-scoped
argument-hint: "[target or extra instructions, e.g. 'staging' or 'production at <commit>']"
deterministic:
  run: |
    set -e
    echo "session_cwd=$(pwd)"
    if git rev-parse --show-toplevel >/dev/null 2>&1; then
      echo "git_toplevel=$(git rev-parse --show-toplevel)"
      echo "git_branch=$(git branch --show-current 2>/dev/null || true)"
      echo "git_head=$(git rev-parse --verify HEAD 2>/dev/null || true)"
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
Deploy the approved project revision using the stevedore subagent: $@

Delegate verification, build, and deployment execution to Stevedore. The lead resolves scope and permissions, provides a self-contained brief, and relays any `need_decision`; it does not run the deployment itself.

## Scope and permission
- `/deploy` authorizes deployment to the confirmed target and delegation to Stevedore. It is not `/ship`: Git checkpoint/integration commits, pushes, PR landing, and branch/worktree cleanup require task-specific permission already granted or obtained before those actions.
- When Git closeout is needed, read the shipping skill and use its task-scoped helper under that permission. Carry the task id, owned paths, destination, and exact revision into the brief. A deployment script that needs a commit/push does not itself grant Git permission; detect push-triggered deployments before any Git mutation.
- Preserve unrelated staged, unstaged, untracked, and ignored files in their original checkout. The snapshot is discovery evidence, not approval to adopt the dirty tree. Re-read live state when the snapshot is stale or truncated.
- Extra instructions/target: $@. Without an explicit environment, use only an unambiguous documented project default. Resolve and name the actual account, project, environment, and database before remote mutation; ask if ambiguous.
- Stay in the explicitly identified project, not a sibling worktree, the Pi agent config tree, or a project inferred from history. The Pi config tree is a target only when explicitly requested. Separate version bumps, release publication, and local installation need their own authorization.

## Resolve
1. Resolve the native absolute repository/worktree path from `git_toplevel` (otherwise `session_cwd`) in the snapshot. Read its instructions and canonical deployment pipeline. If multiple worktrees make the intended source ambiguous, ask once. Criterion: exact project and target identified.
2. Select the approved full commit SHA from the request/current task, preferring its recorded landed revision after `/ship`. Do not silently substitute another HEAD or deploy an outdated commit while intended changes remain uncommitted. Resolve those changes through authorized scoped checkpoints first, or stop with `need_decision`. Criterion: intended changes and excluded work accounted for.
3. Use a clean checkout at that SHA, or an existing immutable artifact proven to come from it, without moving or discarding unrelated work. Before creating an isolated checkout, follow the shipping skill's ownership rules. For non-Git projects, identify an immutable artifact/digest or reproducible source snapshot instead of inventing a commit. Criterion: source provenance established and selected deployment cwd explicit.

## Delegate
Call `task` once with `agent: stevedore`, the selected absolute deployment `cwd`, and a self-contained prompt. The brief must contain:
- Project path, branch/full SHA or artifact identity, approved deployment target and canonical pipeline.
- Shipping task id and existing Git permissions when applicable; otherwise explicitly state that Git mutations are not authorized.
- Owned changes, the full observed dirty-file inventory and preserved exclusions, plus the clean checkout/artifact selected for deployment.
- Applicable exact-revision verification evidence, relevant environment/dependency changes, migration requirements, and extra instructions.

Instruct Stevedore to:
1. Confirm cwd, repository identity, source SHA/artifact, live status, and target against the brief. Stop on drift; do not expand scope to new dirty files.
2. Run the canonical lint, format-check, typecheck, test, and build gates needed for the selected revision and deployment environment. Reuse prior evidence only for the same revision and applicable environment. A failed required gate blocks deployment; report it to the owner rather than choosing a weaker command.
3. Keep source checks non-mutating during deployment. Mechanical fixes require an explicitly authorized owned scope; if a fix is authorized, checkpoint it through Shipping as permitted, invalidate old review/check evidence, and verify/build the new revision before continuing. Never deploy a partial staged index or substitute a dirty tree for the verified source.
4. If authorized Git steps are necessary, use Shipping's scoped checkpoints/integration/publication/landing workflow. Preserve unrelated index entries; never use `git add -A` or `git add .`. Do not merge PRs or delete artifacts merely because deployment was requested.
5. Confirm the actual account/project/environment/database before deploying. Follow the canonical migration/rollout order: required migrations must precede code that depends on them, including when a push triggers rollout. Verify migration state/schema; stop with `need_decision` for an unapproved destructive or incompatible migration plan.
6. Deploy the verified revision/artifact through the canonical pipeline. Re-check source identity before rollout; on retries inspect prior deployment/migration state before repeating mutations.
7. Verify the live target: observed deployment version/artifact identity, health, and at least one changed contract when applicable. An accepted CI/deploy command is pending until the rollout is confirmed; report pending/failed honestly rather than claiming it is live.

Wait for the report or relay `need_decision`. Do not infer new permissions from a blocked prerequisite.

## Report
- Exact project/worktree and deployed source SHA/artifact; task and Git delivery state when applicable.
- Checks/review used, their revision, and anything failed, skipped, or unverified.
- Account/project/environment, deployment command and observed rollout ID/URL/status.
- Migration results and ordering; live health/changed-contract evidence.
- Final Git status, unrelated work preserved, any authorized cleanup, and remaining blockers.

Git publication, landing, cleanup, deployment, and local installation are separate outcomes. State what actually completed.

## Pre-step snapshot

The deterministic pre-step supplies session cwd, repository, branch, full commit SHA, status, worktrees, and dirty counts. Reconcile this discovery snapshot with live state before acting.
