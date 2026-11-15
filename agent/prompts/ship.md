---
description: Land and clean up the current task; 'ready' previews completed tasks for approval
argument-hint: "[task id | ready]"
---
Finish and ship: ${@:-the current task}.

Read the shipping skill at `<agent-dir>/skills/shipping/SKILL.md` (agent dir = `PI_CODING_AGENT_DIR`, else `~/.pi/agent`; not the project cwd) and follow its tracked workflow. Keep the active execution mode.

This authorizes scoped checkpoint/integration commits, publication, landing, and cleanup for the identified task only — not deployment, installation, version bumps, history rewriting, unrelated issue closure, or a repository-wide branch sweep. Narrower constraints in my arguments win.

Start with `shipping status`. If the argument is `ready`, show the completed task candidates and their blockers, then ask me once to approve the set before mutations. Otherwise resolve the current or named task; ask once if scope or destination is ambiguous. For untracked older work, inventory and establish ownership first — a missing record is not permission to adopt everything.

Reuse exact-revision evidence and resume from the first incomplete step; I should not have to enumerate worktrees or PRs. End with the skill's final receipt, including anything intentionally left alone.
