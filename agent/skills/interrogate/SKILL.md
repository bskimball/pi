---
name: interrogate
description: Independent adversarial review of code changes, with synthesized findings and optional user-requested model diversity.
disable-model-invocation: true
---

# Interrogate

Invoke explicitly with `/skill:interrogate`. Review only; apply fixes when separately requested or already authorized.

1. Establish the target diff or paths and summarize intent from the request and repository context. Resolve only ambiguities that would materially change the review.
2. Use two independent reviewers for a panel review, or the user-requested count. Follow the active mode's delegation permissions and routing; when delegation is unavailable, provide a candid inline review rather than claiming independent consensus. A third reviewer is useful for a distinct risk or unresolved disagreement, not a required extra pass.
3. Give reviewers the same intent, relevant code context, [rubric](references/rubric.md), and [code-quality lens](references/code-quality-review.md). The [reviewer template](references/reviewer-prompt.md) is available for handoffs. Keep scopes bounded and read-only. Reviewers use configured defaults unless the user requests model diversity or specific models; inspect configured model identifiers before overriding and report unavailable requested models without silent substitution.
4. Deduplicate findings and verify material claims against actual execution paths. Agreement adds signal only when reviewers examined the same issue independently. A lone concrete finding can still be decisive. Apply pragmatic [lead judgment](references/lead-judgment.md) when findings conflict or need triage.

Lead with actionable correctness, security, or maintenance findings and file:line evidence. Identify reviewers and known model identities when relevant. Include tradeoffs or material disagreements; summarize dismissed findings only when the explanation matters. Empty categories, a full agreement map, and style nits are unnecessary. A clean review is a valid result.

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate
