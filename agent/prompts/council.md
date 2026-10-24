---
description: Convene Oracle, Advisor, and Artisan in parallel to evaluate or solve a problem
argument-hint: "[evaluate|solve] [problem]"
---
Convene the council on: ${@:-the current problem in this conversation}.

Invoking `/council` is my explicit request to consult all three members — Oracle, Advisor, and Artisan — in parallel. Evaluate is read-only; solve earns implementation only after the council is synthesized.

## Scope
- First word sets the mode: `evaluate` (also `review`, `assess`) evaluates only; `solve` (also `fix`, `implement`, `build`) evaluates, then implements the synthesized course. No leading verb means evaluate. The rest of the argument is the problem; with no problem, use the current task or conversation problem; with no identifiable problem, ask me one question instead of dispatching.
- The council is fixed: `oracle`, `advisor`, `artisan`. Do not silently substitute another agent for a member. If the active mode's roster makes a member unavailable, name the missing voice, proceed with the available members, and lower confidence accordingly.
- Council members advise; they do not edit. The lead owns the synthesis, any implementation, and the final answer. Keep the active mode's other rules unchanged.

## Convene
1. Build one shared evidence pack before dispatching: the problem verbatim, the decision or outcome needed, the relevant files, diff, or artifacts (read them first), constraints, and what a good answer must settle. Do not dispatch on a vague brief and make each member redo the same discovery. Criterion: every member receives the same pack, plus only its lens brief below.
2. Dispatch all three in parallel in a single turn — three `task` calls issued together, not sequential calls and not `task_chain`. Each brief is self-contained, names its agent, repeats "Do not edit any files," and asks for a compact report. Criterion: all three members are in flight before any report is read.
   - **Oracle** (`agent: oracle`) — correctness and evidence: the most likely root cause or best course, the decisive evidence for it, concrete failure paths and edge cases, and what remains unproven. Follow its verdict discipline (`BLOCK` / `PASS` / `ADVISORY`) when a concrete proposal is under evaluation.
   - **Advisor** (`agent: advisor`) — strategy and course: one clear recommendation, the highest-leverage assumption or decision the problem turns on, the viable options with their trade-offs, and a severity tag (`nit` / `concern` / `blocker`) on its central point.
   - **Artisan** (`agent: artisan`) — human-facing shape: how the solution reads to its user or operator — structure, hierarchy, interaction, and mental model — leading with the shape (component tree, call tree, file tree, or diagram) when three or more parts interact. When the problem has no human-facing surface, evaluate the legibility of the proposed structure, naming, and documentation shape instead, and state plainly where this lens does not apply rather than inventing UI.
3. Wait for all three reports. If one fails or times out, note the missing voice in the synthesis; do not re-dispatch the same brief — one narrowed retry is allowed only when that voice is load-bearing. Criterion: three reports in hand, or each absence explicitly accounted for.

## Synthesize
Reconcile the reports; do not concatenate them and do not vote-count. Separate genuine consensus from genuine disagreement, name which disagreement is load-bearing, and let evidence decide it: if one cheap fact would settle it, gather that fact (one focused read or check) before recommending rather than averaging the positions. Show the shape — the tree, diagram, or pseudocode that exposes the recommended structure — whenever three or more related parts matter to the decision.

## Solve
Only when I asked to solve. Implement the synthesized recommendation under the active mode's normal routing; council membership alone does not assign the writer. If an Oracle `BLOCK` or an Advisor `blocker` remains unresolved after synthesis, or Artisan surfaces a missing product or taste decision that would change the direction, stop before editing and ask me one question naming the exact trade-off. Otherwise carry the fix through implementation and verify the changed contract itself, not just the code around it.

## Report
Present, in this order:
- The problem in one line, and the mode (`evaluate` or `solve`).
- One tight bullet per member: its position, with Oracle's verdict or Advisor's severity where given.
- **Consensus** — where the council agrees, in one or two lines.
- **Disagreement** — the load-bearing split, the decisive evidence, and how it was settled; omit this section when there is none.
- **Recommendation** — a single course, not a menu, with the shape visual first when the structure carries the decision.
- **Next step** — the smallest action or the exact decision needed from me.
- **Unproven** — what the council could not establish.

In solve mode, append what changed and what was verified, distinguishing fixture or sample data from real data where relevant.

Stop after the report in evaluate mode. In solve mode, stop when the synthesized course is implemented and verified, or at the single blocking question above.
