---
name: blast-radius
description: "Find what a change could break elsewhere before it ships, and prove the one fact it is safe because of by running real code. Use for \"blast radius of X\", \"what could this break\", or a small diff you don't trust. Not for explaining code (how) or its history (why)."
---

# Blast radius

Find what a change breaks somewhere else, before it ships.

Companion to `how` and `why`. `how` says what the code does, `why` says why it is shaped that way, blast radius says what it breaks elsewhere. This method supplements the active mode and `/poteto` playbooks; it grants no permissions beyond them. Run it inline unless the active mode's own rules call for delegating; it never requires extra reviewers.

Listing callers is not the job; grep does that in a second. The job is the breakage grep won't show.

## Don't trust your own writeup

A blast-radius writeup that sounds right is worthless: it reads as convincing whether or not it is true. Find the one or two facts the safety depends on and prove them by running code.

### How sure are you

For each fact the change's safety depends on, get it as far down this list as is cheap, and say where it stopped.

1. You said so. Worthless on its own.
2. You pointed at the line: a real `file:line`, or the library's own source.
3. You showed the bad case can't happen: you walked the failure step by step and it never reaches.
4. You ran it: a script or test that calls the real code and fails loud if you are wrong.
5. You reproduced it in the running app.

Level 4 is usually one small script that imports the library the app ships and calls the exact function you worry about. Keep that script in the OS temp directory; add a test file to the repository only if the user opts in.

## Steps

1. Read the change: the diff, the symbols it adds, changes, and deletes, and what it now does differently, including the part the diff doesn't spell out. For the PR and commits, use Step 2 of [`why`](../why/SKILL.md).
2. Find the one fact it is safe because of, such as "this call only drops already-dead cache entries". If it holds, most risky cases clear at once. Spend your time here, not on a long list of maybes.
3. Look where grep stops. Read the source of the library you call, and check its pinned version and any local patch. Work out when things run: microtasks, unmount and teardown, framework differences. Follow what a symbol search misses: JSON an API returns, a DB column, a wire format, another language reading the same bytes, a feature flag, code three hops downstream.
4. Be honest about each risk: a real chance of happening and a real cost if it does. Keep confirmed risks apart from the ones you checked and cleared. Cite a real `file:line`; a search that finds nothing is still an answer; never invent a caller or an API.
5. Prove the one fact with an existing check or a focused exercise of real code, preferring the running app for user-visible behavior. Use a temporary script only when existing checks cannot exercise the contract. Follow the active mode's diagnostic-experiment rules; if execution is unavailable or outside authorization, mark the fact unproven.

## What to hand back

- **What it does.** What changed, including the non-obvious part.
- **The one fact it is safe because of.** State it, the level you reached, and the proof. If you couldn't prove it, write unproven.
- **Risks.** Each names how it breaks, the `file:line`, how likely and how bad, and how to check. Paste the proof for the ones that matter.
- **Cleared.** What you checked and why it is fine.
- **Before you merge.** The cheapest test or repro that catches the real bug, including the script you wrote. Recommend a repository test; don't add one unasked.

Run the prose through [`unslop`](../unslop/SKILL.md), cite real code, and strip anything private before it goes anywhere public.

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack/skills/blast-radius
