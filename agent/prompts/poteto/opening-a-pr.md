# Opening a PR

Git policy for repository-changing playbooks (Bug fix, Feature, Refactor, Unattended). Investigation and Prototype do not mutate Git. Copy Preflight first and Closer last into the playbook todos.

Read `<agent-dir>/skills/shipping/SKILL.md` before preflight. It owns task registration, scoped checkpoints, worker integration, exact-revision verification, publication, landing, recovery and cleanup. Resolve agent dir from `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`, not the project cwd.

**Done when** the selected delivery target is met with a shipping receipt: local checkpoint, ready PR, or confirmed landing and task-owned cleanup. Implementation completion alone is not delivery completion.

## Permission level

Invoking `/poteto` grants this run's branch, scoped local commits, push to its task branch, ready PR and adjacent-bug issue creation on an authenticated GitHub destination. No AGENTS.md permission setting is needed.

- `pr`: default when the intended remote is GitHub and `gh auth status` succeeds. Resolve the remote explicitly; `origin` may be upstream rather than the user's fork.
- `local`: default otherwise, or when the user says “local only” / “don't push”. Branch and scoped commits only.
- `off`: “don't commit”; skip all mutating Git steps with `skip: git level off`.
- `ship`: an explicit “ship when ready” in this goal, or a later `/ship`, extends permission to landing this task on the selected default branch and cleaning its owned temporary artifacts. Without a usable authenticated destination, stop locally with the blocker. A narrower no-push/no-commit constraint wins.

These permissions cover this run, not unrelated tasks or upstream branches. Pushed-history rewriting, bypassing checks/hooks, and deployment/install/version bumps remain outside this permission. Normal PR-only invocation does not authorize merging or arming auto-merge.

## Preflight

1. Follow Shipping's Register steps: resolve the exact repository/remote/default branch; select one task branch and clean outcome checkout; register owned paths, base SHA and canonical checks with `shipping begin`. Reuse the current task branch when it belongs to this goal. If it belongs to another goal or necessary files contain unowned changes, isolate this goal instead of mixing them. On the default branch, create `<type>/<2–5-word-slug>` (`fix`, `feat`, or `refactor`; Unattended matches its work). If the goal names an issue, read it using explicit `gh issue view N --repo OWNER/REPO`. Criterion: task id, worktree, branch, base, destination, delivery level and linked issue stated, or a reasoned skip.

## Commits during the playbook

- Use Shipping's scoped checkpoints after local proof. Stage only owned paths; never `git add -A` or `git add .`. Never include secrets or another task's changes.
- Use `type(scope): imperative subject`, at most 72 characters. Keep coherent commits; add new corrective commits rather than rewriting checkpoint history that integration receipts depend on. Never rewrite pushed commits.
- For Bug fix, an approved repo regression can be committed before the fix as `test(scope): reproduce <bug>`. This does not authorize creating new test files by itself.
- Internal worker branches feed the outcome branch; they do not each get a PR. Retire durably integrated worker artifacts at each milestone, not in a later “merge everything” pass.

## Closer

2. Converge and verify. Settle selected writers, integrate their scoped commits and retire worker artifacts. Review the actual integrated diff and run the registered canonical checks against the final clean candidate. Preserve unrelated work; if it prevents clean verification, use a separate outcome checkout. Criterion: exact candidate SHA with applicable review and gate evidence, or an explicit blocker.
3. Deliver to the selected target. At `local`, report the checkpoint and next command; at `off`, report uncommitted work. At `pr`/`ship`, use Shipping's publication step and confirm the ready PR's repository, URL, state and head. Use the Shipping PR body headings. Criterion: remote evidence for the exact candidate, or an honest local-only result.
4. Record adjacent bugs. At `pr`/`ship`, search for duplicate open issues with explicit `--repo` before filing each evidenced out-of-scope bug, then link it under the task PR's Scope. At lower levels, draft the issue text instead. Close only issues actually resolved by this task, normally through `Fixes #N` on its PR. Criterion: each adjacent bug is filed, matched or drafted, or `skip: none found`.
5. Close at the selected boundary. At `ship`, run Shipping's landing and cleanup steps; queued auto-merge is pending, not landed. At `pr`, leave the outcome PR/branch for review; at `local`/`off`, preserve local work. Criterion: final receipt names the observed delivery state, exact commits, checks, cleanup, preserved work and next step. Do not babysit CI or merge at PR-only level.

## Reply

Use Shipping's final receipt, plus issues linked/filed/drafted and skipped playbook steps. Distinguish published, landed and installed. `/ship` resumes an existing PR task without starting another playbook or creating another PR.
