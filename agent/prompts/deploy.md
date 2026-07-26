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
Ship the current project using the `stevedore` subagent — do not run the deploy yourself.

## Resolve the worktree first (mandatory)

Use the deterministic pre-step output above. Before delegating:

1. Set **absolute worktree path** = `git_toplevel` when present, otherwise the session `session_cwd`. On Windows use a native path (`C:/Users/...`), never a bash-only path.
2. Confirm you are shipping **this** worktree (branch + dirty files from the snapshot), not a sibling worktree, not `~/.pi`, and not some other project inferred from conversation alone.
3. If `git worktree list` shows multiple worktrees and the intended one is ambiguous, stop and ask me — do not guess.
4. Treat the dirty tree as the release contents. Inventory **all** modified, staged, and untracked project files from the snapshot. Do not ship a partial subset of the conversation's "recent files" while leaving related dirty files behind.

## Delegate

Call the `task` tool once with:
- `agent`: `stevedore`
- `cwd`: the absolute worktree path from step 1 (**required** — always pass it explicitly)
- a complete self-contained brief (stevedore has no conversation access)

Build the brief from:
- Absolute working directory (repeat the same path you passed as `cwd`)
- Branch / HEAD from the snapshot
- Full dirty-file inventory (or "clean") from the snapshot — not a selective subset
- Anything relevant from our conversation (what changed, which env, known gotchas)
- Extra instructions: $@
  - If no extra instructions were provided, use the project's default deploy target.

The brief must tell stevedore to:
1. Work only inside the provided absolute `cwd` / worktree. Refuse if `pwd` / `git rev-parse --show-toplevel` does not match.
2. Re-run `git status --short --branch` and reconcile against the inventory in the brief. If the tree changed, use the live status and report the delta.
3. Discover the project's own lint/format/typecheck/test/build/deploy scripts and use those.
4. Run lint and format checks, fixing only mechanical issues.
5. Run build/tests; a red build blocks deploy.
6. **Worktree completeness for release:**
   - Default: deploy the **entire current worktree** (all current project changes on disk), not a hand-picked subset.
   - If commit and/or push is part of shipping (explicitly requested by me, or required by the project's release path), stage and commit the **full intended project change set**. Prefer `git add -A` scoped to the repo after reviewing status. Never partially stage "some of the feature" while leaving related project files dirty.
   - Exclude only true noise/secrets/generated artifacts (e.g. `node_modules/`, build output already ignored, `.env*`, credentials, local scratch). If unsure whether a dirty file belongs in the release, stop with `need_decision` instead of omitting it silently.
   - After any commit: re-run `git status`. If project files that should have shipped are still dirty/untracked, fix the staging and amend only if the commit has not been pushed and the brief allows it; otherwise make a follow-up commit or stop and report. Do not report success with a partial commit.
7. Deploy to the stated target; if the target is ambiguous, contact you (supervisor) instead of guessing — answer its ask, don't let it stall.
8. Verify the deploy and report back in its structured format, including final `git status` after the operation.

If stevedore contacts you with `need_decision`, relay the question to me if you can't answer it from context.

When it finishes, give me a short summary: worktree path + branch, pre-flight results, whether the full dirty set was included, what was deployed where, verification, final git status, and any follow-ups.
