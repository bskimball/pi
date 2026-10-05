---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Multiple LLM reviewers challenge changes from independent angles."
disable-model-invocation: true
---

# Interrogate

Invoke explicitly with `/skill:interrogate`.

Review code changes independently, with the same intent, rubric, and code-quality lens for each reviewer. Use configured model defaults unless the user asked for multi-model or specific-model review. With explicit multi-model authorization, model diversity supplies an additional adversarial signal, not assigned personas.

## Pi routing

Dispatch subagents through the active mode's delegation path. Fusion: use `task_start` sidekick units (agent `sidekick`), one per explorer/reviewer/investigator, with disjoint read-only scopes and compact reports; never use other agents unless the user named them. Apex / Pi (regular) / Apex Orchestrate: use `task`, with `scout` for exploration/reading, `oracle` for review/judgment, and `librarian` for external/remote sources; parallel means multiple task calls in one message. Work: spawn no subagents; run the method inline. Subagents use configured model defaults except for user-requested model overrides described in Step 3.

The deliverable is a synthesized verdict. Do NOT auto-apply changes.

## Step 1, Determine Scope

Identify what to review from context:

- If the user points at specific files or a diff, use that
- If on a feature branch, run `git diff main...HEAD` (or the appropriate base branch) for the full changeset
- If the user's message references recent work, gather the relevant files

Package the diff (or file contents) plus any surrounding context files the reviewers need to understand the code.

## Step 2, State the Intent

Before spawning reviewers, state the intent explicitly. Derive this from:

- The user's message
- Commit messages
- PR description if one exists
- The code itself

Write one clear paragraph. If you're unsure about the intent, ask the user before proceeding.

## Step 3, Spawn Reviewers

Dispatch 2-3 reviewers using Pi routing above. Give each the common intent, rubric, and code-quality lens. In Fusion, partition into disjoint read-only code scopes and supply surrounding context in the briefing. In Apex / Pi / Apex Orchestrate, independent reviewers may examine the same target. In Work, apply the lenses inline and report one inline review, not a fictitious panel.

Only when the user asked for a multi-model / specific-model review, pass distinct `model` overrides. Read `agent/models.json` in the Pi configuration and pick 2-3 from different providers in models.json, or the specific models the user requested, using `provider/id` identifiers. Do not substitute an unrequested model if a requested model is unavailable; report the limitation. Otherwise leave `model` unset. Report actual model identities only when known.

Read `references/reviewer-prompt.md` and fill in the template with:
1. The stated intent
2. The diff or file contents
3. The review rubric from `references/rubric.md`
4. The code-quality lens from `references/code-quality-review.md`

Every reviewer receives the filled template with its assigned scope, so each applies the code-quality lens. Preserve the same intent and rubric across scopes.

## Step 4, Synthesize

As results come back, build a unified picture. Disjoint scopes or inline passes do not establish independent consensus on unshared code; note that limitation rather than treating silence as agreement:

1. **Parse all findings** from the reviewers
2. **Identify consensus**. Findings raised by 2+ reviewers independently are highest signal.
3. **Identify lone-reviewer findings**. Still worth reading, but weight accordingly.
4. **Deduplicate**. Different reviewers may describe the same issue differently. Merge these and note which reviewers raised it.
5. **Note disagreements**. If one reviewer flags something and another explicitly says the opposite, that's useful context for the verdict.

## Step 5, Lead Judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator.

Read `references/lead-judgment.md` for the full framework.

Categorize every finding using these buckets:

- **Act on**. Real issues affecting correctness, security, or maintainability given the actual goals. These would block a real PR.
- **Consider**. Legitimate points, but you're not sure they outweigh the cost of addressing them right now. Worth the user's attention.
- **Noted**. Technically valid but not actionable. Context-dependent, premature optimization, or low-impact given the current stage.
- **Dismissed**. Wrong, nitpicky, or missing context. Brief explanation why.

For each finding, include:
- Which reviewer(s), and actual models if known, raised it
- The category (act on / consider / noted / dismissed)
- A one-line rationale for the categorization

## Output Format

Present the verdict in this structure:

### Intent
> [The stated intent paragraph from Step 2]

### Reviewers
- Reviewer [label]: [actual model if known, otherwise configured default / inline], [N findings] (one bullet per reviewer)

### Act On
[Findings that should be addressed. For each: description, which reviewers raised it, why it matters.]

### Consider
[Findings worth thinking about. For each: description, which reviewers raised it, tradeoff involved.]

### Noted
[Valid but low-priority. Brief list.]

### Dismissed
[Rejected findings with brief rationale.]

### Agreement Map
[Where did reviewers agree, where did they diverge, and what does the pattern of agreement/disagreement tell us?]

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate
