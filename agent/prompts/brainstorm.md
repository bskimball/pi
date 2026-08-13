---
description: Enter divergent brainstorming mode — explore options, do not implement
argument-hint: "[topic]"
---
Enter brainstorming mode for: ${@:-the current task}

Stay divergent and do not implement or edit files yet:

- Generate several genuinely distinct options, not variations of one idea.
- Defer judgment while generating; capture even rough or unconventional directions.
- When options differ in structure, show each serious structural option in its native shape — types, signatures, call tree, file tree, component tree, pseudocode, or a Mermaid sequence/state. Do not make the user reconstruct architecture from bullet-point prose. If an option has three or more related parts and their relationships materially affect the choice, it needs a compact visual; a mere list of three items does not. Conceptual or naming alternatives stay in short prose.
- Put the visual first within that option, followed by its tradeoff in one or two short bullets. Keep shared context out of repeated visuals so the structural difference is immediately visible.
- For the strongest options, note the key tradeoff, risk, and what would make it the right choice.
- Surface hidden assumptions, constraints, and unknowns worth resolving before committing.
- End with the smallest question or experiment that would most cheaply narrow the choice.

Only converge on a recommendation if I ask. Do not write code or run consequential commands in this mode.

When I do ask you to converge and write the plan down, the bar is that it works as an execution spec rather than a design document: a competent engineer who never saw this conversation should be able to execute it top to bottom and make zero design decisions. Detail exists to remove their decisions, not to look thorough.

- Ground every claim. Paths, symbols, signatures, and current behavior must come from files you actually read this session; mark anything unconfirmed inline as `unverified — confirm first` rather than presenting a guess as settled.
- Make the approach the load-bearing section: ordered steps grouped by behavior, not one step per file. For each step give the concrete edit — verb, exact target, resulting behavior — name the existing helpers to reuse with their paths, and give exact signatures or literals for anything callers must match. For a rename or removal, list every callsite or the exact search that returns them.
- Order steps to minimize broken intermediate states where practical, and mark which steps are independent. Where a change is genuinely atomic — a schema migration, a coordinated signature change across producer and consumer — say so rather than pretending it splits.
- Include verification that exercises the new behavior specifically — a concrete input and its expected observable output — not just a build or the existing suite. Give exact commands and whatever they need to run.
- Pre-decide the fallback for any load-bearing assumption that could prove false, so the implementer never stalls once this conversation is gone.
- Omit ceremony sections. No Non-Goals, Out of Scope, Alternatives Considered, Risks and Mitigations, or Future Work. A scope boundary that genuinely matters is one inline sentence at the exact point of temptation. Drop a generic cleanup appendix too — but keep docs, generated artifacts, and repository-mandated gates as real steps wherever the repo or the acceptance contract requires them.
- Never reference this conversation ("the option we chose above"). State the choice and its reason inline.

When brevity and decision-completeness collide, completeness wins.
