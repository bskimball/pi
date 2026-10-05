---
name: principles
description: Engineering principles for repeated failed fixes sharing a premise; trusting or reporting measured numbers; non-trivial or bulk work worth a tool or script; crash/retry-safe commands and loops; concurrent writers to shared state; designing types and signatures; branchy stateful logic; choosing core data structures before logic.
---

# Principles

Read only the reference file(s) matching the current situation, not all eight. Paths are relative to this skill directory.

- Repeated failed fixes sharing one premise -> [Attack the Premise](references/attack-the-premise.md).
- Trusting, reporting, or acting on a measured number -> [Explain the Number](references/explain-the-number.md).
- Non-trivial or bulk work worth a rerunnable tool or script -> [Build the Lever](references/build-the-lever.md).
- Commands, lifecycle steps, or loops amid crashes and retries -> [Make Operations Idempotent](references/make-operations-idempotent.md).
- Concurrent actors writing shared mutable state -> [Separate Before Serializing Shared State](references/separate-before-serializing-shared-state.md).
- Designing types, reviewing signatures, or writing typed code -> [Type System Discipline](references/type-system-discipline.md).
- Stateful, branchy logic or repeated shape assumptions -> [Model the Domain](references/model-the-domain.md).
- Choosing core types and data structures before logic or sequencing foundational work -> [Foundational Thinking](references/foundational-thinking.md).

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack
