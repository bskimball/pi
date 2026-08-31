---
description: Review for over-engineering only — list what to delete or shrink, do not implement
argument-hint: "[path or current diff]"
---
Review ${@:-the current uncommitted diff} for unnecessary complexity only. Do not edit files and do not start a broader cleanup.

This is a complexity pass, not a correctness pass. Route bugs, security holes, and performance issues to a normal review. Do not apply fixes.

## Scope

- No extra arguments: the current uncommitted diff (`git diff` plus untracked files that are part of the change).
- Paths or a commit-ish in the arguments: only that slice.
- Stay inside that slice. Nearby mess is out of scope unless it is the thing under review.

Read the code first. A shorter diff in the wrong place is not simpler.

## Hunt

Stop at the first replacement that holds, the same ladder used in implementation: skip unrequested speculative work; reuse what already lives in this repo; use stdlib; use a native platform feature; use an already-installed dependency; only then keep the minimum readable code.

Look for:

- dead code, unused flexibility, speculative features
- hand-rolled work the standard library already ships
- a dependency or custom widget doing what the platform already does
- an interface with one implementation, a factory for one product, config nobody sets, a layer with one caller
- the same logic in fewer readable statements
- a wrapper around a source of truth that should have been edited directly

Never flag: input validation at trust boundaries, error handling that prevents data loss, security measures, accessibility basics, anything explicitly requested, or a single smoke check that pins non-trivial logic.

## Report

One line per finding, biggest cut first:

`<file>:L<line>: <tag> <what to cut>. <replacement>.`

Tags:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer readable statements. Show the shorter form.

If there is nothing to cut, say `Lean already.` and stop. Do not score projected line or dependency savings.

Do not implement unless I ask.
