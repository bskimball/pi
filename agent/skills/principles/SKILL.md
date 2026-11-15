---
name: principles
description: Focused references for recurring failed fixes, measurement claims, repetitive automation, retryable operations, shared-state concurrency, and difficult type or domain modeling decisions.
---

# Principles

Read only the reference file(s) matching the current situation, not all eight. Paths are relative to this skill directory.

- Repeated failed fixes sharing one premise -> [Attack the Premise](references/attack-the-premise.md).
- Trusting, reporting, or acting on a measured number -> [Explain the Number](references/explain-the-number.md).
- Repetitive work worth a rerunnable tool or script -> [Build the Lever](references/build-the-lever.md).
- Commands, lifecycle steps, or loops amid crashes and retries -> [Make Operations Idempotent](references/make-operations-idempotent.md).
- Concurrent actors writing shared mutable state -> [Separate Before Serializing Shared State](references/separate-before-serializing-shared-state.md).
- Difficult type contracts or invalid state combinations -> [Type System Discipline](references/type-system-discipline.md).
- Stateful, branchy logic or repeated shape assumptions -> [Model the Domain](references/model-the-domain.md).
- Choosing core types and data structures before logic or sequencing foundational work -> [Foundational Thinking](references/foundational-thinking.md).

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack
