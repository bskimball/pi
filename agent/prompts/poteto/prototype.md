# Prototype

Throwaway instrument for a named decision. The real build is Feature (or `/brainstorm` converge) after this. Speed over polish. Code quality does not matter. No production framework, tests, or abstractions.

**Done when** the named decision has observed evidence and a recommendation, or you route away because there was no decision to settle.

## Steps
1. Scope the decision this prototype exists to make: which layout, interaction, density, behavior, timing, or approach. No decision means no prototype — route to Feature or Investigation. Criterion: one falsifiable question written before any sketch.
2. Build throwaway in an OS temp scratch directory, not inside the repository worktree. Visual: the lightest stack that renders the idea. Behavioral or timing: the smallest script that exercises the question. When comparing alternatives, put them behind one switcher, each labeled. Criterion: scratch path exists under the OS temp dir; production tree untouched.
3. Observe on the matching surface. Visual: screenshot or drive the interaction. Behavioral or timing: log the timing, print the output, or watch the render. The observation is the test. Criterion: each variant has an observation, not a self-report.
4. Present alternatives, tradeoffs, and a recommendation. Say plainly that the prototype is throwaway. Do not promote scratch into the repo unless the user asks. Criterion: recommendation names the evidence that settled it.
5. If the user then wants the real build, tell them to `/poteto` Feature (or converge `/brainstorm`). Do not start Feature from this playbook. Criterion: production code unchanged by this playbook.

## Reply
The variants explored, the evidence, tradeoffs, recommendation, and the scratch path. State that the prototype is throwaway.
