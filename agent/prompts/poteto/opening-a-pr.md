# Opening a PR

Git policy for every playbook that changes the repository (Bug fix, Feature, Refactor, Unattended). Investigation and Prototype do not touch git. The router copies the Preflight step in as the first todo and the Closer steps in as the last todos.

**Done when** the work sits on its own branch as small Conventional Commits, and is either published as a ready PR (level `pr`) or reported as local-only with the exact next command.

## Permission level
Invoking `/poteto` is the user's permission for this run's git actions. There is no per-repo setting. Levels:
- `pr` (the default when `origin` is on GitHub and `gh auth status` succeeds): branch, commit, push the branch, open or update a ready PR, and file issues for adjacent bugs.
- `local` (the default otherwise): branch and commit only.
- `off`: no branch, commit, push, or PR. Skip every step below with `skip: git level off`.

The goal can lower the level. "Local only" or "don't push" lowers it to `local`, and "don't commit" lowers it to `off`. The playbooks call the result "the effective git level" (or just "the git level"). Some actions stay behind an explicit ask at every level: merging, force-pushing, deleting branches, rewriting pushed commits, and pushing to the default branch. Never use `--no-verify`.

## Preflight
1. Confirm the target is a git worktree and record the default branch name without the `origin/` prefix. Use `git symbolic-ref --short refs/remotes/origin/HEAD` (strip `origin/`), then `gh repo view --json defaultBranchRef`, then fall back to `main`. `<default>` below means that name. `<base>` means `git merge-base HEAD origin/<default>`, or the local `<default>` when there is no remote. Then pick the branch:
   - On the default branch, run `git switch -c <type>/<slug>`. `<type>` is `fix` for Bug fix, `feat` for Feature, and `refactor` for Refactor; for Unattended it matches the work. `<slug>` is 2–5 kebab-case words from the goal. Uncommitted changes carry over to the new branch and stay unstaged.
   - On a branch that belongs to this goal (matching name or open PR), stay on it.
   - On a branch with unrelated work, create the new branch from the default branch in a separate worktree (`worktree add`) and work there. Leave the other branch untouched.
   - If a file this goal must edit already has uncommitted changes you did not make, use a separate worktree. Do not mix those changes into your commits.
   - If the goal names an issue (`#N` or an issue URL), read it with `gh issue view N` and keep `N` for the closer.
   Criterion: branch name, default branch, worktree path, and any linked issue are stated, or `skip: <reason>`.

## Commits (during the playbook)
- Commit at each verified checkpoint, not at the end. Stage only paths this goal changed (`git add <paths>`). Never `git add -A` or `git add .`. Never stage secrets, temp artifacts, or files you did not change.
- Write titles in Conventional Commits form, `type(scope): subject`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf` as the type (`wip` only for an Unattended stop) and the changed area as the scope. Keep the subject imperative and no longer than 72 characters. Add a body only to say why when the diff does not show it.
- When a fix belongs in an unpushed commit, use `git commit --fixup <sha>`. Before the first push, run `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>`. Each commit should be landable and ordered to tell the story. Once the branch has an upstream (`git rev-parse @{u}` succeeds), add plain new commits and skip the rebase. Never rewrite pushed commits.
- Bug fix: when the repro lives in a repo test (an existing test file, or one the user approved), commit it first as `test(scope): reproduce <bug>`, then commit the fix. This does not authorize new test files.

## Closer
2. Tidy and check. Autosquash fixups (unpushed branches only), review `git log --oneline <base>..HEAD` and `git diff <base>...HEAD --stat`, and confirm the tree is clean apart from changes you did not make. If the goal names issue `N`, the commit that closes it ends with the trailer `Fixes #N`. Criterion: ordered commit list shown; no stray staged or unstaged changes from this goal.
3. Publish (level `pr` only; otherwise `skip: level local` and name the push command). If the current branch is `<default>` or HEAD is detached, stop at local and ask. Run `git push -u origin <branch>`. Check for an existing PR with `gh pr view --json number,url,state`. If one exists, push to it and update its body with `gh pr edit <n> --body-file <tmp>` when the scope changed. If not, run `gh pr create --base <default> --title "<conventional title>" --body-file <tmp>` without `--draft`. Write the body file under the OS temp dir. If a PR still opens as a draft, run `gh pr ready <n>`. If `gh` is missing, not logged in, or the remote is not GitHub, stop at local and say so. Criterion: `gh pr view <n> --json url,state,isDraft` was run after the write, and the reply quotes the URL and state from that output.
4. Issues for adjacent bugs. List bugs found outside this goal's scope. At level `pr`, first check for duplicates with `gh issue list --state open --search "<keywords>"`. Then file each new one with `gh issue create`, including a title, repro, and evidence, and link it under the PR's `## Scope`. Below `pr`, write the issue text in the reply instead. Criterion: each adjacent bug is filed, matched to an existing issue, or drafted, or `skip: none found`.
5. Stop. Do not merge, arm auto-merge, babysit CI, or delete the branch unless the user asked. Criterion: no merge, force-push, branch deletion, or pushed-history rewrite without an ask.

## PR body
Use these `##` headings, in this order. Drop an empty optional section. Keep the body under about 40 lines. A reviewer should understand the problem, scope, risk, and proof in under a minute.
- `## Why`: the problem and the approach in 1–3 sentences, with `Fixes #N` when an issue is linked.
- `## What changed`: 1–3 bullets. Name paths or symbols only when they carry the change.
- `## Scope`: what is covered, plus meaningful gaps and the issues filed for them.
- `## Tradeoffs` (optional): rejected alternatives a reviewer would ask about.
- `## Blast Radius`: who and what is affected, and why that is safe or risky.
- `## Verification`: 1–3 bullets with the real command or surface and its outcome. List only checks that ran this session.

## Reply
Branch, the commit list (`git log --oneline <base>..HEAD`), the PR URL and state from `gh pr view` or the local-only next command, and issues linked, filed, or drafted.
