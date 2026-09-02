---
description: Review for over-engineering only — list what to delete or shrink, do not implement
argument-hint: "[path or current diff]"
---
Review ${@:-the current uncommitted diff} for unnecessary complexity only.

Audit changes solely for over-engineering, excess abstractions, and dead code without editing files or expanding into broader cleanup. Route bugs, security vulnerabilities, and performance issues to a normal review.

## Scope
- No arguments: inspect the current uncommitted diff (`git diff` plus untracked files that belong to the change).
- Arguments provided: inspect only the specified paths or commit range.
- Stay strictly inside the target slice; nearby code outside the change is out of scope.

## Hunt
1. Read the code and diff first to understand intent and context before evaluating cuts. Criterion: target files and diff context read; no reduction proposed without verifying context.
2. Apply the simplification ladder, stopping at the first replacement that holds: skip unrequested speculative work, reuse existing repository code, use the standard library, use native platform capabilities, use an already-installed dependency, or retain the minimum readable implementation. Criterion: each candidate tested against the ladder in order.
3. Identify reducible complexity: dead code, unused flexibility, speculative features, hand-rolled code duplicative of stdlib or platform, single-implementation interfaces, single-product factories, unconfigured options, single-caller layers, bloated statements, and wrappers around a source of truth that should be edited directly. Criterion: identified items match defined simplification categories.
4. Protect essential logic: retain trust-boundary input validation, data-loss error handling, accessibility basics, user-requested behaviors, and single smoke tests that pin non-trivial logic. Treat extra lockdown beyond framework or starter defaults as eligible for removal, including extra lockdown added during the current conversation. Criterion: essential boundary defenses and user-mandated features preserved.

## Report
List findings ordered from largest reduction to smallest, formatted as exactly one line per finding:

`<file>:L<line>: <tag> <what to cut>. <replacement>.`

Tags:
- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer readable statements. Show the shorter form.

If there is nothing to cut, output `Lean already.` and stop. Do not score or project line or dependency savings.

Wait for approval before implementing any suggested cuts.
