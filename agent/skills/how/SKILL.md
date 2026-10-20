---
name: how
description: "Explain how existing code works: subsystem architecture, runtime flow, walkthroughs before a change, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\"). Read-only. Not for design motivation (why) or change breakage (blast-radius)."
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

## Pi routing

The active mode owns delegation. Run this method inline unless that mode's own rules call for or permit delegating; this skill never requires fanout. Any delegated explorer or explainer gets a disjoint read-only scope and returns a compact report. This method supplements the active mode and `/poteto` playbooks; it grants no permissions beyond them.

## Step 1. Assess Complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. One explainer explores and explains in a single pass. Go to Step 2b.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): explore 2 to 4 angles first, then explain. Go to Step 2a.

When in doubt, take the simple path.

## Step 2a. Explore (complex questions only)

Decompose the question into 2 to 4 exploration angles, each a distinct slice of the subsystem. Explore them inline, or delegate per Pi routing above when the active mode allows. Each angle gets a distinct read-only scope and a compact report.

Each explorer gets the prompt in `references/explorer-prompt.md` with its angle filled in. Then go to Step 3.

## Step 2b. Direct Explain (simple questions)

Use one read-only explainer pass that explores and explains in one pass, inline or delegated using Pi routing above.

Build its prompt from `references/explainer-prompt.md` without the explorer-findings section. Go to Step 4.

## Step 3. Synthesize (complex questions only)

Once every angle is covered, synthesize the findings into one explanation, inline or through a read-only explainer per Pi routing above.

Build its prompt from `references/explainer-prompt.md` with every explorer's findings filled in.

## Step 4. Present

Present the explainer's output to the user. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output Format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack/skills/how
