---
name: writing-for-agents
description: Write or revise skills, agent briefs, and AGENTS.md or CLAUDE.md instructions with concise scope and progressive disclosure.
---

# Writing for agents

Write instructions that change useful decisions. Assume the agent can already code, search, explain, and exercise judgment; retain project-specific contracts and non-obvious recipes rather than restating those capabilities.

- Put purpose, scope, essential invariants, and completion conditions near the action they govern. Match procedural detail to the actual risk.
- Keep skill names and descriptions concise: these are loaded for discovery even when the body is not. Use specific triggers rather than synonym lists or broad catches such as every non-trivial task.
- Load conditional detail through a clear pointer naming when to read it. Keep a simple skill self-contained; create references only when they prevent irrelevant material being loaded.
- Prefer one authoritative statement per rule. Let configuration, tool schemas, and executable scripts own facts that are cheap to look up. Document the reason or gotcha the environment cannot explain.
- State desired behavior directly. Reserve prohibitions and fixed sequences for concrete failure modes. An example, past incident, or preference is not automatically a universal requirement.
- Scale workflow to the request. A small edit needs no mandatory plan, new helper script, specialist panel, extra approval, or exhaustive report. Existing user authorization still applies.
- Keep terms consistent and write complete, plain sentences. Compact language should save reading effort, not require decoding invented labels.

For Pi skill frontmatter and discovery, read [SKILL-MECHANICS.md](SKILL-MECHANICS.md). Preserve invocation policy unless a change is requested. Verify links and discovery metadata after editing; use realistic behavior checks when the change is substantial enough to justify them.
