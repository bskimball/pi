---
description: Match a playbook, copy its steps into todos, then execute under the active mode
argument-hint: "[goal, or 'new task. <goal>']"
---
Route and run: ${@:-the current task}.

Match one playbook, copy its steps into the todo list first, then execute under the already-active `/mode` card. Do not switch modes. Do not treat this as a sixth behavior mode.

## Scope
In scope: matching Investigation, Bug fix, Feature, Refactor, Prototype, or Unattended; writing those steps as the first todos; executing them until the playbook's done criterion or a user-owned gate.
Out of scope: changing `/mode`; git actions beyond the effective git level (see `opening-a-pr.md`); landing/cleanup without `ship` permission for this task; rewriting pushed history; enumerating specialists in the user-facing reply; importing Cursor pstack skills (`architect`, `arena`, `swarm`).
Arguments: the goal, plus any constraint that pins a playbook (`don't change any code yet`, `repro first`, `im stepping away`). Bare `do it` / `continue` / `keep going until done` continues the current playbook. `new task` (or an explicit subject change) re-matches instead of continuing.

## Route
1. If the user said `new task`, or the new subject is not the current playbook's remaining work, re-match. Criterion: one playbook named; continuing the prior playbook only when this turn is the next step of the same goal.
2. Read the matched playbook file in full before writing todos. Playbooks live at `<agent-dir>/prompts/poteto/`. Agent dir is `PI_CODING_AGENT_DIR` if set, otherwise `~/.pi/agent`. Resolve them there, not against the project cwd:
   - Read-only question, "how does X work", "are we sure", "don't change any code yet" → `investigation.md` in that directory
   - Reported defect to reproduce and fix → `bug-fix.md`
   - New or changed behavior → `feature.md`
   - Behavior-preserving structure change → `refactor.md`
   - Throwaway sketch to settle a design or empirical fork → `prototype.md`
   - User stepping away, "run until done", "going to bed", or a falsifiable overnight predicate → `unattended.md`
   Large or cross-cutting work that no single playbook covers: stay on Feature or Unattended (Unattended when they are leaving), and design extra phases *after* that playbook's copied steps.
   For Bug fix, Feature, Refactor, and Unattended, also read `opening-a-pr.md` in that directory. It owns branching, commits, PRs, and issues. Criterion: the file for the matched playbook (and `opening-a-pr.md` when it applies) was read this turn.
3. After that read, `todo_write` before any edit, shell, or dispatch. Write the list in this order: the `opening-a-pr.md` Preflight step (when it applies), then the playbook's numbered steps copied in verbatim, then any task-specific items, then the `opening-a-pr.md` Closer steps (when it applies). A skipped step stays listed as `skip: <reason>`. Criterion: every playbook and git step is visible in the list, including skips.
4. Execute the remaining steps under the active mode card. The mode owns the outcome, not each step: Apex does the steps here; Orchestrate uses one pipeline for the outcome; Fusion keeps sequential steps on one sidekick. A new worker needs disjoint paths or a new contract. This prompt does not override specialist routing, Fusion's closed roster, Work's crew, or the review and verification gates in SYSTEM.md and the mode card. Criterion: each step's completion criterion in the playbook file is met or skipped with a reason.
5. Continue later turns against the same playbook until its done criterion, the user says `new task`, or a user-owned gate blocks. `continue` does not open a new playbook. Criterion: the todo list still names the matched playbook until that playbook is done.

Pin overrides match: "don't change any code yet" forces Investigation; "repro first" is a Bug fix constraint, not politeness; a named predicate plus "stepping away" forces Unattended.

Prototype, not a question, when an empirical fork (behavior, timing, layout, output, perf) can be observed by running something. Reserve a question for a product or preference call no experiment can settle.

Inconclusive is not a pass. Wrong-surface verification is not a pass. Green compile/CI is not by itself the playbook's proof.

Git follows `opening-a-pr.md` and the shipping skill. Invoking `/poteto` authorizes this run to branch, make scoped checkpoints, push its task branch, open a ready PR, and file issues for adjacent bugs on an authenticated GitHub destination. An explicit `ship when ready` in the goal (or a later `/ship`) extends this to landing and task-owned cleanup. `local only` / `don't push` or `don't commit` takes precedence. No permission to rewrite pushed history, bypass checks, sweep unrelated branches, or deploy/install is implied. The authorization covers this playbook run only. Internal worker branches feed one outcome PR, not separate PRs.

## Report
Lead with the matched playbook and whether this turn started or continued it.
Then the playbook's own reply shape.
Name skipped steps and their reasons.
State what was verified, on which surface, and what was not.
When git steps ran: use the shipping receipt—task, selected delivery target, commits, PR URL/observed state, remote landing proof, cleanup, preserved work and next step. Published, landed and installed are different states.
If a later turn can `continue`, name the next remaining playbook step.

Keep going until the matched playbook's done criterion, a user-owned gate, or the user says `new task`.
