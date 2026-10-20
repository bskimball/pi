---
name: benchmark-checklist
description: "Vet a performance measurement (limiter, tuning, limits, errors, repeatability, relevance, did the work happen) before reporting or acting on it. Use when running a benchmark or reporting a measured speedup or regression. Not for finding slow code."
---

# Benchmark checklist

Use this when you produce a performance number: a PR's before and after, a regression claim, a tuning harness, or a library or config choice. [Explain the Number](../principles/references/explain-the-number.md) says why. Answer each question below with evidence from a run, not from a guess about the code.

This method supplements the active mode and `/poteto` playbooks. It grants no permissions beyond them: it does not authorize installing tools or stopping other processes.

For a quick ballpark the user asked for, one run is enough. Still check questions 4 and 7, and say that it is one run. Skip the rest unless that run looks wrong. A choice between options is never a ballpark.

## Before you run anything

- Write down the claim you expect to make, in the words you would ship ("export is 30% faster at p50 on the 60k-row dataset"). The questions test that sentence.
- Read the measurement script. Note what it times, what it counts, and what it ignores.
- Check machine load and core count with the host's tools (`uptime` and `nproc` on Linux; `uptime` and `sysctl -n hw.ncpu` on macOS; Task Manager for load and `Get-CimInstance Win32_Processor` for core counts on Windows). If the machine is busy, find out what is running. If you cannot stop it, interleave the sides so both see the same noise, and say so in the report.

## The questions

1. **Why not double?** Name the limiter. Profile in a run you do not report, because profilers and tracers slow the work down. Use CPU per process, a profiler for the runtime (`node --cpu-prof`, `py-spy`, `perf`, or the platform's own), I/O wait, and syscall counts where the OS offers them. Then map the hot spot to source. Watch the load generator too: if it saturates first, you measured the load generator. If a change did not move the number, the limiter explains why, so find it before you call the change useless.
2. **Was it tuned?** Run every side the way production runs it: release builds, production flags and env, batching and transaction settings, connection pools, caches as warm or cold as production sees them, and the same versions and data. If one side runs on defaults, you compared configurations, not implementations. A limiter that is a setting, such as a commit per row, a debug build, or a missing index, means that side is untuned. If tuning is within the requested scope, tune it and measure again before picking a winner. Otherwise report the configuration limitation without changing it or declaring a winner. Narrowing the claim to the code as it ships today does not fix this when the user is choosing what to adopt, because they adopt the option, not today's settings.
3. **Did it break limits?** Do the arithmetic. Compare bytes per second with disk and network bandwidth, and operations per second times the cost per operation with the cores you have. Compare the time saved with the time the changed piece took. Removing a piece that takes 10% of the run can make the run at most about 11% faster. A result past a limit means the run measured something other than the work, such as a cache, a no-op, or a bug.
4. **Did it error?** Count failures and non-success responses, and check that the outputs are correct, not just present. Errors behave differently from successes: rejections are often fast, timeouts and retries are slow. If the script does not count errors, add the count.
5. **Does it reproduce?** Run each side at least 5 times, alternating the sides (A, B, A, B, and so on) so warmup, lazy initialization, caches, and drift do not favor one side. Report the median and the range. Treat a gap smaller than the run-to-run variation as no measurable difference. When the call is close, use a rank-sum test or the harness's own statistics. Repeated runs, a version matrix, or subset isolation are a repeated experiment: follow the current Oracle requirement, where Oracle returns a diagnostic experiment plan (commands, repetitions, stopping conditions, allowed mutations, evidence to capture) for Machinist instead of running the matrix itself.
6. **Does it matter?** Next to any micro result, measure the end-to-end path a user waits on, with realistic data sizes and concurrency. Report the micro result as a share of the whole. A helper that takes 1% of a request can make the request at most 1% faster, however fast the helper gets.
7. **Did it even happen?** Confirm the work ran inside the timed region: the request reached the server, the rows were written, the bytes were read, and the code used the result. Lazy code (generators nobody iterates, promises nobody awaits, results the JIT can discard) and timeouts all produce numbers for work that never happened.

## Report

- Lead with the verdict: faster, slower, no measurable difference, or inconclusive.
- Give the number with its unit, the run count, the range, and the limiter. For example, "p50 41 ms → 33 ms, median of 7 runs per side, range 32 to 35 ms after, bound by JSON parsing on one core."
- Call the verdict inconclusive when you claim a difference but cannot name the limiter, when a side ran untuned, or when you could not check questions 4 and 7. Name the gap.
- Keep a PR body to one primary number, per [opening-a-pr](../../prompts/poteto/opening-a-pr.md). Put the runs, the range, and the limiter evidence in a linked artifact or a notes file.
- When a loop optimizes one metric, vet its harness with these questions before freezing it. The frozen harness should print error and work counts, so each keep-or-revert checks questions 4 and 7.

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack/skills/benchmark-checklist
