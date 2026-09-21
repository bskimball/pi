# Pi pairing — TypeSafe skill + local Jev

Local addendum. The vendor skill body in `SKILL.md` stays the TypeSafe source of truth (docs, primitives, cookbooks). This file is how that skill sits next to the existing Jev extension in this config.

Upstream snapshot: [typesafe-ai/skills](https://github.com/typesafe-ai/skills) `skills/typesafe-ai/`, plugin `0.5.7`, commit `65a39f3` (2026-09-12). MIT. After replacing `SKILL.md` from GitHub, restore the "In this Pi config" pointer and the extra description sentence; do not duplicate this file.

## Split

| Work | Owner |
| --- | --- |
| Question design, primitive choice, live docs, cookbooks, product TypeSafe integrations | `typesafe-ai` skill + [docs.typesafe.ai](https://docs.typesafe.ai/llms.txt) |
| In-session Choice / Score / Noul over text state | Existing `jev` tool (`agent/extensions/jev/`) |
| Product HTTP/SDK clients in an application the user is building | Follow live TypeSafe API/SDK docs; keep credentials server-side |

Do not add a second in-process classifier, a parallel TypeSafe HTTP client for session judgments, or a rewrite of `agent/extensions/jev/`. The agent-facing shape is already `jev({ state, questions, includeProbabilities? })`.

## Evaluate here

1. Design independent questions from the vendor skill (one coherent judgment each; Choice / Noul / Score by what the answer means).
2. Call `jev` with that `state` and `questions` map. Batch independent questions in one call.
3. Treat the result as advisory. Low Choice/Score confidence, or Noul near 0.5, needs more evidence or escalation — not automatic action.
4. Keep rules, lookups, weights, thresholds, and execution in code or in the surrounding agent workflow. Jev does not generate, run tools, or dispatch workers.

Setup, provider switch (`typesafe` vs `cloudflare-workers-ai`), limits, and key handling: `agent/extensions/jev/README.md` and `CONFIGURATION.md` § `jev.json`. Never paste API keys in chat.

## Product integrations

When the user is building TypeSafe into an app, follow the live HTTP/SDK pages from the vendor skill. That is a different runtime from this Pi `jev` tool. Do not copy `agent/extensions/jev/` into the user's app unless they ask.
