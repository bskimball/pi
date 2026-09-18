# Bug fix

Reproduce, root-cause, then ship the smallest change the evidence justifies. Belt-and-suspenders that "might help" is a hypothesis; it does not ship. When evidence refutes a hypothesis, revert what it motivated.

**Done when** the original repro no longer triggers on the same surface, or a user-owned prerequisite blocks reproduction.

## Steps
1. Reproduce on the matching surface yourself. UI: live page. API/CLI: the failing command. Do not hand the repro to the user first. Ask only with a specific reason the surface cannot be reached, after driving it as far as it goes. If it will not fire, synthesize the trigger or instrument until it does. Honor an explicit "repro first" constraint before any fix. Criterion: failing output or screenshot captured, or `skip: <why the surface is unreachable>`.
2. Form candidate hypotheses and rule them out until one mechanism survives. Each pass takes the split that cuts the most remaining space and gets runtime evidence. Do not guess program state; instrument and read it running. Criterion: surviving mechanism named with the evidence that confirmed it; discarded hypotheses listed.
3. Plan the smallest fix that addresses that mechanism. Inspect direct callers of the function you will touch; patch the shared routing point only when the broken invariant belongs to every caller. Criterion: one-sentence fix plan; owned paths named.
4. Apply the fix under the active mode. Review the actual diff before calling it done. Criterion: diff exists; no extra speculative guards or unrelated cleanup.
5. Verify on the same surface as step 1. The original repro now fails to reproduce. Unit tests show branch behavior, not bug absence. Inconclusive or wrong-surface is not a pass. Criterion: passing repro output or live-page evidence, or an explicit not-pass with what remains.
6. If the user asked to open a PR, stop and say so; do not open one as this playbook's closer. Criterion: no push/PR unless this goal contained that ask.

## Reply
What was broken, root cause, fix, how you verified. Paste failing-then-passing repro output when it is short; otherwise quote the decisive lines.
