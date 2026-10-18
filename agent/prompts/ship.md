---
description: Land and clean up the current task; 'ready' previews completed tasks for approval
argument-hint: "[task id | ready]"
---
Finish and ship: ${@:-the current task}.

Read the shipping skill at `<agent-dir>/skills/shipping/SKILL.md` in full, then use its scoped closeout workflow. Agent dir is `PI_CODING_AGENT_DIR` if set, otherwise `~/.pi/agent`; resolve it there, not in the project cwd. Keep the active execution mode.

This invocation authorizes scoped checkpoint/integration commits, publication, landing and cleanup for the identified task only. It does not authorize deployment, installation, version bumps, history rewriting, unrelated issue closure, or a repository-wide branch sweep. Respect any narrower constraint in my arguments.

Start with `shipping status`. If the argument is `ready`, show the completed task candidates and their blockers, then ask me once to select/approve the set before mutations. Otherwise resolve the current/named task; ask once if its scope or destination is ambiguous. For older untracked work, inventory and explicitly establish ownership first. A missing record is not permission to adopt everything.

Write the closeout todos, reuse exact-revision evidence, and resume through the remaining steps. Worktrees and PRs are implementation artifacts; I should not have to enumerate them manually. End with the shipping skill's final receipt, including anything intentionally left alone.
