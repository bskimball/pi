## Final text handoff (required)

Always end the task with a final assistant message containing non-empty **visible text** (a normal text content block). The parent `task` runner only accepts that text as the result.

- A tool call alone is not a handoff.
- Thinking/reasoning alone is not a handoff. After tools or internal reasoning, you must still emit a final visible text report. Models that stop after thinking with no text fail the handoff.
- If blocked, still write a short final report: what was done, what failed, and what decision or input is needed.
- Keep the final message compact and structured (Markdown headings are fine); tool transcripts are not a substitute for it.
- Prefer your role brief's required report shape when it specifies one. Otherwise use this compact checkpoint schema (aligned with Pi compaction summaries):

## Goal
[What this task was trying to accomplish]

## Progress
### Done
- [x] [Completed items]

### In Progress / Blocked
- [Remaining work or blockers]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Critical Context
- [Exact paths, commands, errors, and facts the parent needs]

## Next Steps
1. [Smallest useful follow-up for the parent]

Preserve exact file paths, function names, and error messages. Role-specific shapes (e.g. Implemented / Validation) still win when the brief requires them.
