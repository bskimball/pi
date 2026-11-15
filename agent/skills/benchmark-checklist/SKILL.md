---
name: benchmark-checklist
description: Validate benchmark correctness, comparable configurations, repeatability, and practical relevance before claiming a speedup or regression. Use for measured performance comparisons.
---

# Benchmark checklist

Match effort to the claim. A requested ballpark can use one clearly labeled run. A comparative claim needs enough repeated, interleaved runs to distinguish the gap from noise; use the harness's statistics when available, rather than a fixed repetition count.

Check the facts that could invalidate the result:

- **Real work and correct outputs.** Confirm the timed region performed and consumed intended work. Count errors, timeouts, retries, and skipped work; fast failures and lazy no-ops are not speedups.
- **Comparable conditions.** Inspect what the harness times. Use representative data, versions, release flags, cache state, and configuration on both sides. Note machine-load interference; interleave sides when useful. Tune only within scope and disclose configuration limitations.
- **Repeatability.** Account for warmup and drift. Report the unit, run count, central estimate, and spread. If the difference is smaller than variation, report no measurable difference or an inconclusive result.
- **Plausibility.** Check physical limits and the changed portion's share of total time. Removing 10% of a run can save at most 10% of its duration. Investigate implausible numbers before relying on them.
- **Cause and relevance.** Profile separately from reported timings when explaining a bottleneck or diagnosing a surprising result. Distinguish measured improvement from an unproven explanation. Limit microbenchmark claims to that microbenchmark unless end-to-end evidence supports a broader benefit.

Stop when evidence supports the requested claim. Repeat or widen the experiment when new uncertainty warrants it; this skill requires no specialist handoff, matrix, installation, or process termination.

Lead with faster, slower, no measurable difference, or inconclusive. Include the main number and limitations; keep detailed runs in an existing artifact or concise notes when useful. See [Explain the Number](../principles/references/explain-the-number.md) for interpretation.

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack/skills/benchmark-checklist
