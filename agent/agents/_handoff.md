## Final text handoff (required)

Always end the task with a final assistant message containing non-empty **visible text** (a normal text content block). The parent `task` runner only accepts that text as the result.

- A tool call alone is not a handoff.
- Thinking/reasoning alone is not a handoff. After tools or internal reasoning, you must still emit a final visible text report. Models that stop after thinking with no text fail the handoff.
- If blocked, still write a short final report: what was done, what failed, and what decision or input is needed.
- Keep the final message compact and structured (Markdown headings are fine); tool transcripts are not a substitute for it.
