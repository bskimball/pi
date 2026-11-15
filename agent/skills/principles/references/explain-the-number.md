Applies when: Apply before you trust, report, or act on a number you measured: a speedup, a regression, a throughput, a latency, or an eval result. Check that it measured the intended work; investigate the limiter when making causal claims.

# Explain the Number

A measured number is a claim about a system. Before relying on it, check that it measured the intended work and supports the stated claim. A causal explanation needs additional bottleneck evidence.

**Why:** A run that went wrong still prints a plausible number. Requests that failed, a cache that skipped the work, code that never ran, a side left on default settings, and run-to-run noise all produce results that look fine. An unexplained bottleneck limits a causal claim, even when a controlled comparison supports an observed difference.

**Pattern:**

- **Ask "why not double?"** Name the resource or code path that bounds the result, such as a core, a lock, the disk, the network, or the load generator itself. Use a profile or system counters when the claim needs a causal explanation; otherwise distinguish the observed result from a bottleneck hypothesis.
- **List what else the number could be measuring, and rule out each one with evidence.** The usual suspects are errors, skipped or cached work, an untuned side, noise, and a piece too small to matter end to end.
- **Keep the evidence with the number.** Put the run count, spread, and any established limiter in the notes or a linked artifact, so a reader can check the claim.

For a performance comparison, consult the relevant checks in `/skill:benchmark-checklist` and scale effort to the claim. For an eval result, check that trials performed the task and that the gap exceeds variation. Use additional models or scenarios only when the requested conclusion depends on them.

You skipped this when the evidence behind a number has no run count, no spread, or an unsupported causal explanation, or when the time saved is larger than the time the changed piece took.

Distinct from Prove It Works, which checks that an output is real. This checks that a measured number means what you say it means.
