# Investigation

Read-only. Cited explanation or recommendation, not a code change.

**Done when** the question is answered from observed evidence, or the premise is rejected with reasons.

## Steps
1. Restate the question and the smallest scope that would answer it. Criterion: one sentence question; named subsystems or files if already known.
2. Gather evidence in the active mode (Apex reads locally; Orchestrate may scout; Fusion dispatches the sidekick; Work may clerk/researcher). Start from the rawest reachable artifact — live logs, rows, traces, git history, or source — rather than pre-digested summaries or docs, and when a suspected cause or belief is stated, test or falsify it directly with a runnable query or script instead of prose reasoning. Do not edit, format, or "while we're here" change files. Criterion: every claim maps to a raw file, command, or source observed this run, and any stated belief was directly tested against it.
3. If the request is a choice between alternatives, write a tradeoffs table and a recommendation with reasons. If it is "how does this work", use Overview / Key Concepts / How it works / Where things live / Gotchas, dropping empty sections. Criterion: the reply matches one of those two shapes.
4. If the investigation was meant to precede a code change, stop after the answer and name Bug fix or Feature as the next `/poteto` match. Do not start that playbook unless the user already asked to change code. Criterion: no edits; next playbook named only when a change is the natural follow-up.

## Reply
The investigation output. For "are we sure?" include a real judgment. Push back when the premise is wrong.
