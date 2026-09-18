# Feature

New or changed behavior, built from a named data shape. You own the design. The active mode owns who types.

**Done when** the requested behavior is proven on the matching surface (live page, contract exercise, or the check the user named).

## Steps
1. Ground in the affected subsystem. Read the code that will change; do not speculate. Criterion: current types, callsites, and owner named from files you read.
2. Name the data shape first: types, signatures, module boundaries, or state machine — before logic. Show that shape. Criterion: a visual or signature block exists; implementation has not started.
3. Write the throughput checkpoint as four todo items. A dimension that does not apply keeps its item with `n/a: <reason>`:
   - **Blocking first steps.** Gates that must finish before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers that may run in parallel. Shared writes serialize.
   - **Shared mutable state.** Split the target when two writers would touch the same file, branch, or object. Serialize only for a real invariant.
   - **Smallest safe decomposition.** If one worker (or the lead inline) is best, name why.
   Criterion: all four items are on the list; the checkpoint chooses decomposition within the already-active mode.
4. Implement against the named shape under the active mode. Surgical edits. No dual APIs for a draft from this conversation. Criterion: the shape from step 2 is visible in the diff.
5. Verify the changed contract itself, not only the path around it. UI: one live-page pass of the new behavior. API: exercise the new behavior with a concrete input and observable output. Inconclusive or wrong-surface is not a pass. Criterion: that proof was run this session.
6. Do not open a PR unless the user asked. Criterion: shared-state git actions still gated.

## Reply
What you built, the shape you chose and why, the throughput checkpoint, open decisions. Lead with the shape when three or more parts changed.
