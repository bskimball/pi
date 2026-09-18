---
description: Match a playbook, copy its steps into todos, then execute under the active mode
argument-hint: "[goal, or 'new task. <goal>']"
---
Route and run: ${@:-the current task}.

Match one playbook, copy its steps into the todo list first, then execute under the already-active `/mode` card. Do not switch modes. Do not treat this as a sixth behavior mode.

## Scope
In scope: matching Investigation, Bug fix, Feature, Refactor, Prototype, or Unattended; writing those steps as the first todos; executing them until the playbook's done criterion or a user-owned gate.
Out of scope: changing `/mode`; opening, pushing, or merging a PR unless the user asked in this goal; enumerating specialists in the user-facing reply; importing Cursor pstack skills (`how`, `architect`, `arena`, `swarm`).
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
   Large or cross-cutting work that no single playbook covers: stay on Feature or Unattended (Unattended when they are leaving), and design extra phases *after* that playbook's copied steps. Criterion: the file for the matched playbook was read this turn.
3. After that read, `todo_write` before any edit, shell, or dispatch. First items are the playbook's numbered steps copied in verbatim. A skipped step stays listed as `skip: <reason>`. Task-specific items go after those steps. Criterion: every playbook step is visible in the list, including skips.
4. Execute each remaining step under the active mode card. Who runs a step is the mode's problem (Apex inlines; Orchestrate delegates slices; Fusion assigns the sidekick). This prompt does not override specialist routing, Fusion's closed roster, Work's crew, or the review and verification gates in SYSTEM.md and the mode card. Criterion: each step's completion criterion in the playbook file is met or skipped with a reason.
5. Continue later turns against the same playbook until its done criterion, the user says `new task`, or a user-owned gate blocks. `continue` does not open a new playbook. Criterion: the todo list still names the matched playbook until that playbook is done.

Pin overrides match: "don't change any code yet" forces Investigation; "repro first" is a Bug fix constraint, not politeness; a named predicate plus "stepping away" forces Unattended.

Prototype, not a question, when an empirical fork (behavior, timing, layout, output, perf) can be observed by running something. Reserve a question for a product or preference call no experiment can settle.

Inconclusive is not a pass. Wrong-surface verification is not a pass. Green compile/CI is not by itself the playbook's proof.

Do not open, push, or merge a PR as a playbook closer. Shared-state git actions stay behind the user's explicit ask.

## Report
Lead with the matched playbook and whether this turn started or continued it.
Then the playbook's own reply shape.
Name skipped steps and their reasons.
State what was verified, on which surface, and what was not.
If a later turn can `continue`, name the next remaining playbook step.

Keep going until the matched playbook's done criterion, a user-owned gate, or the user says `new task`.
