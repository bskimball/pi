---
description: Enter divergent brainstorming mode — explore options, do not implement
argument-hint: "[topic]"
---
Brainstorm architectural and design options for: ${@:-the current task}.

Explore distinct solutions, surface structural trade-offs, and identify critical unknowns. Do not implement, edit files, or execute consequential commands.

## Scope
Cover architectural choices, component boundaries, interface designs, and key risks for the named topic or the current active task. Stay within option exploration; implementation, code authoring, and premature convergence remain out of scope until requested.

## Diverge
1. Generate several genuinely distinct options rather than variations of a single concept, deferring judgment during ideation. Criterion: at least three genuinely distinct options articulated.
2. Render structural options in their native shape (types, signatures, call tree, file tree, component tree, pseudocode, or Mermaid diagram) whenever three or more related parts materially affect the choice. Place the visual first within that option, followed by its trade-off in one or two short bullets, keeping shared context out of repeated visuals. Express conceptual or naming alternatives in concise prose. Criterion: every multi-part structural option leads with a visual.
3. Identify the key trade-off, primary risk, and justifying condition for each viable option, highlighting hidden assumptions, constraints, and dependencies. Criterion: trade-offs and risks explicitly paired with each option.
4. Conclude with the smallest question or experiment that would most cheaply narrow the choice. Criterion: a concrete, minimal probe or question identified.

## Converge
Only when I ask you to converge and write the plan down, author an execution spec that enables an engineer without context to execute from top to bottom while making zero design decisions. Detail exists to eliminate implementer decisions, not to look thorough.

1. Ground every claim in verified workspace facts. Read targets directly; mark any unconfirmed path, symbol, signature, or behavior as `unverified — confirm first`. Criterion: zero unverified assertions presented as settled fact.
2. Group the approach by behavior rather than by file. Specify concrete edits (verb, exact target, resulting behavior), name existing helpers to reuse with paths, provide exact signatures or literals callers must match, and list callsites or exact search queries for renames or removals. Criterion: every step specifies concrete targets, helpers, and caller contracts.
3. Sequence steps to minimize broken intermediate states, explicitly identifying independent steps and declaring genuinely atomic changes that cannot split. Pre-decide fallbacks for load-bearing assumptions that could prove false. Criterion: step dependencies, atomic boundaries, and fallback paths defined.
4. Specify behavior-focused verification that exercises the new behavior with concrete inputs and observable outputs, providing exact commands rather than relying solely on existing test suites. Criterion: concrete verification commands and observable expectations listed.
5. Omit ceremony sections (Non-Goals, Out of Scope, Alternatives Considered, Risks and Mitigations, Future Work, generic cleanup appendices). Place any vital scope boundary as a single inline sentence at the point of temptation, and include repository-mandated gates, docs, and generated artifacts as explicit steps. Criterion: ceremony sections eliminated; required repo gates retained.
6. State choices and rationales inline without referencing earlier conversation turns. When brevity and decision-completeness collide, completeness wins. Criterion: self-contained execution spec with all decisions resolved.

## Report
In divergent mode, present:
- Distinct options with visuals first for structural choices, followed by 1–2 bullet trade-offs.
- Key assumptions, constraints, and trade-offs across options.
- The smallest question or experiment to narrow the decision.

In convergent mode, present the complete execution spec with sequenced behavioral steps, exact targets, helper paths, verification commands, and fallbacks.

Wait for my instruction before converging, authoring plans, or modifying code.
