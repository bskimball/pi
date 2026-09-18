# Refactor

The structure changes. The behavior does not. Distinct from Feature (adds behavior) and Bug fix (corrects it).

If cleanup reveals a missing feature or a real bug, split it out and ship the structural change first against the pinned contract. A redesign that adds behavior routes to Feature. Large cross-cutting structural work still uses these steps and adds phases after them.

**Done when** the pin still holds on the real artifact and reader load dropped somewhere, or the reshape was reverted.

## Steps
1. Pin the behavior contract before any structure moves. Characterization test, snapshot, or equivalence harness. If the area has no coverage, write the pin first. Typecheck and lint are not a pin. Criterion: a failing-if-behavior-changes check exists and is green on the current tree.
2. Name the structure the code is missing, then the target shape (module layout, types, call graph as if built today). Boring code stays when the shape is already clear and local. The reshape must delete branches or invalid states, not add indirection. Criterion: target shape shown; success measure is reduced reader load.
3. Subtract before you add. Delete dead code, collapse one-caller wrappers, drop redundant validators, remove orphan references, then introduce the new shape. Speculative cleanup that "might help" gets reverted. Criterion: subtraction landed or `skip: nothing dead`.
4. Move in small behavior-preserving steps, each keeping the pin green. For API reshapes, migrate every caller and delete the old API in the same wave. No compatibility shims, no parallel old-and-new paths. Criterion: pin green after each move.
5. Prove behavior unchanged on the real artifact, not "it compiles". Equivalence: script that diffs old-vs-new outputs, recorded baseline replayed, or smoke on the matching surface. Criterion: pin still green plus one real-artifact check.
6. Confirm the change is worth keeping. If the diff does not lower reader load somewhere, revert it. Criterion: reader-load delta named, or revert done.
7. Do not open a PR unless the user asked. Criterion: shared-state git actions still gated.

## Reply
The structure that changed, the pin you held it against, the equivalence proof, the reader-load delta, what shipped and what got reverted. No new behavior.
