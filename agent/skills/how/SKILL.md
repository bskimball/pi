---
name: how
description: Explain existing code architecture, runtime flow, or ownership with code pointers. Use for code walkthroughs; use why for historical rationale and blast-radius for change risks.
---

# How

Answer the question read-only. Find the entry point, trace relevant calls and data, and identify ownership boundaries and non-obvious behavior. Cite the files and symbols supporting the explanation. Stop when the requested flow is clear; a narrow question needs no subsystem survey.

For a broad question, divide investigation into useful slices and reconcile their findings. Work inline by default; the active mode controls delegation. This skill requires no fanout or separate explainer.

Lead with the answer. Add a flow, file map, gotchas, or diagram only when useful. Optional [explorer](references/explorer-prompt.md) and [explainer](references/explainer-prompt.md) templates support complex investigations or handoffs; ordinary answers need neither template.

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack/skills/how
