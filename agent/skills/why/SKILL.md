---
name: why
description: Investigate historical design rationale and tradeoffs using cited commits, PRs, and relevant records. Read-only; use how for runtime behavior and blast-radius for change risks.
---

# Why

Anchor the question in relevant code, then look for contemporary explanations. Code shows behavior; it does not establish author intent. Distinguish explicit rationale, supported inference, speculation, and unknowns. Cite evidence and preserve contradictions.

Start with focused repository history:

```bash
git blame -L <start>,<end> <file>
git log --oneline -20 -- <file>
git show <commit> -- <file>
# Use --follow when renames matter; expand patches only as needed.
git log --follow -p -- <file>
gh pr view <number> --json title,body,comments,reviews
```

Follow relevant links to PRs, tickets, docs, chat, or incident data when the local record does not answer the question. Discover tools and inspect their actual schemas before querying. All access is read-only. A direct answer in a commit or PR is a valid stopping point; inventorying every connected service is unnecessary.

Scale breadth to the question. A postmortem or broad history request may need several sources; a single guard or threshold often needs one. Report sources actually consulted and material access or evidence gaps. A seven-category coverage table is useful only for a requested comprehensive investigation.

Work inline by default; the active mode controls delegation. Optional resources:

- [Epistemics](references/epistemics.md): confidence calibration for ambiguous or conflicting evidence.
- [Source playbooks](references/source-playbook.md): choose only the relevant category recipe. Add [incident queries](references/sources/incident-postmortem.md) when an incident is a plausible lead, rather than for every defensive check.
- [Investigator](references/investigator-prompt.md) and [synthesizer](references/synthesizer-prompt.md): templates for substantial investigations or delegated handoffs.

Lead with the answer and evidence. Separate inference from documented rationale, name meaningful unknowns, and avoid empty report sections. If this investigation informs an authorized change, state the constraints the history establishes.

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack/skills/why
