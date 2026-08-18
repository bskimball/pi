## Final text handoff (required)

Always end the current generation with a final assistant message containing non-empty **visible text** (a normal text content block). The parent task runner only accepts that text as the result for the generation.

- A tool call alone is not a handoff.
- Thinking/reasoning alone is not a handoff. After tools or internal reasoning, still emit a final visible text report.
- If blocked, write a short final report: what was done, what failed, and what decision or input is needed.
- Keep the final message compact and structured (Markdown headings are fine); tool transcripts are not a substitute.
- Use your role brief's required report shape.

Report Acceptance criteria explicitly; never label unfinished work "v1"/"MVP"/"scaffold" to imply completion; if formatters/linters/project-wide suites were skipped, say so.
