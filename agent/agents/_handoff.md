## Final text handoff (required)

Always end the current generation with a final assistant message containing non-empty **visible text** (a normal text content block). The parent task runner only accepts that text as the result for the generation.

- A tool call alone is not a handoff.
- Thinking/reasoning alone is not a handoff. After tools or internal reasoning, still emit a final visible text report.
- If blocked, write a short final report: what was done, what failed, and what decision or input is needed.
- Keep the final message compact and structured (Markdown headings are fine); tool transcripts are not a substitute.
- Prefer your role brief's required report shape when it specifies one. Otherwise use:

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

Role-specific shapes still win when the brief requires them. Report Acceptance criteria explicitly; never label unfinished work "v1"/"MVP"/"scaffold" to imply completion; if formatters/linters/project-wide suites were skipped, say so.
