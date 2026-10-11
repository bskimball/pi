# Unattended

Drive to a checkable predicate without stopping. For "going to bed", "run until done", "keep going until X", or work the user will review later.

Prefer Fusion when the user is in Apex Regular and the run will outlive a normal interactive turn: offer `/mode fusion` once, then proceed in the current mode if they do not switch. Do not switch modes yourself.

**Done when** the predicate is met on the real artifact, or a genuine dead end / irreversible gate is surfaced.

## Steps
1. State the exit condition as a falsifiable predicate before the first iteration (repro gone, migration check reports zero old callers, tests named here green, pixel-diff zero). A duration is not a predicate. "Make it better" is not a predicate — ask for one if missing. Criterion: one checkable sentence the next session could re-run.
2. Write a working decision log under the OS temp dir at `pi-poteto/<task-slug>.tsv` (create that temp folder if needed). Header: `ts`, `phase`, `decision`, `why`, `evidence`, `result`. Append-only. Evidence is a pointer (commit, `file:line`, artifact path), not a paragraph. Do not put the log in the repository worktree. Do not commit it unless the user asked. Criterion: file exists with the header row before iteration 1; reply names the absolute path.
3. Each iteration: smallest change the evidence justifies, verify against the predicate, keep it if it advanced, discard it if it did not. Belt-and-suspenders that "might help" gets reverted. Mid-run reversible discoveries are yours; put unrelated fixes in their own remaining-todo, not a silent scope expand. Surface only irreversible actions, genuine product/preference calls, or a real dead end. Commit each `advanced` iteration on its own (per `opening-a-pr.md`) and log the short SHA as its evidence. A reverted iteration is never committed: restore only the paths you changed. Criterion: one log row per iteration with predicate state (`advanced` / `reverted` / `unchanged` / `INCONCLUSIVE`), plus a SHA for each `advanced` row unless the git level is `off`.
4. Inconclusive is not a pass. A plateau is not a stop: pivot the approach and keep the same predicate. Never relax the predicate to declare victory. Criterion: final row is `met` with evidence, or `dead-end` with what was tried.
5. Close with `opening-a-pr.md` at the effective git level once the final row is `met`. On `dead-end` or an early stop, unless the git level is `off`, make one `wip(scope): <state>` commit of the remaining verified work and do not push. Criterion: Closer steps done or skipped with a reason; a dead-end run ends local, with its `wip` SHA named or `skip: git level off`.

## Reply
The exit condition, iterations run, what landed, what was discarded, final predicate state, path to the decision log.
