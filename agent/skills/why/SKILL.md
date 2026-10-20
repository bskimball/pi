---
name: why
description: "Investigate why code is shaped as it is: design rationale, historical tradeoffs, regressions, postmortems, data-backed thresholds (\"why does X work this way\", \"why did we pick Y\"). Read-only; searches reachable historical sources and returns cited, confidence-calibrated findings. Not for runtime behavior (how) or change breakage (blast-radius)."
---

# Why

Investigate the motivation and intent behind code.

Companion to the `how` skill. `how` answers what the code does and how it works. `why` answers what forces led to its shape.

## Pi routing

The active mode owns delegation. Run this method inline unless that mode's own rules call for or permit delegating; this skill never requires fanout. Any delegated investigator gets one disjoint read-only source scope and returns a compact report. This method supplements the active mode and `/poteto` playbooks; it grants no permissions beyond them.

## Operating Posture

Operate as a **careful, cautious, and precise investigator**. Be honest about what you know vs what you're inferring. Read `references/epistemics.md` for the full confidence framework and phrasing guide. The synthesizer must follow it.

## Step 1. Understand the Target and the Question

Parse what the user is asking. The **target** is usually a chunk of code, a pattern, a feature, or a named design decision. The **question** is usually a design rationale, a tradeoff, a motivating edge case, an external constraint, dead code, or a broad history sweep.

If the target is vague ("why do we do it this way?" with no clear referent), make your best guess from conversation context (open files, recent edits, named symbols, what was just discussed). State your interpretation briefly so the user can redirect if you're off, then proceed.

## Step 2. Establish the Code Anchor

Before investigating, anchor the investigation in concrete code. You need:

- The relevant file path(s) and line range(s)
- The key symbols (function names, class names, constants)
- An initial commit list. The last few commits touching the target.
- PR numbers from merge commits (pattern `(#1234)` in the subject line)

Build this inline.

```bash
# Blame target lines for last-touch commits
git blame -L <start>,<end> <file>

# Full file history, with patches, through renames
git log --follow -p -- <file>

# Last N commits touching the file, PR numbers visible
git log --oneline -20 -- <file>

# Extract PR numbers from a commit message
git log -1 --format=%B <commit>
```

Pull PR bodies and discussion via `gh` for any substantive commits:

```bash
gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews
```

Capture this as seed context (file paths, symbols, commits, PR numbers, linked ticket IDs). Pass it to any investigators.

## Step 3. Investigate Sources

**Scale to the question.** A narrow question (one commit, one threshold, one guard) needs source control plus the one or two categories that plausibly hold the answer. A broad history sweep, regression, or postmortem question warrants every reachable category.

### Discovery

Before searching, discover reachable sources. Use whichever of these sources are reachable (MCP tools via `tool_search` when available, CLIs, `web_search`/`fetch_content`, git history). In Pi, native MCP discovery may instead be available through codemode's `searchTools` and schema inspection. Inspect real tool schemas or CLI help before calling them; do not guess tool names. Record authentication, access, retention, and missing-tool gaps.

Map each reachable source to one evidence category:

1. Source control history
2. Issue / ticket tracker
3. Long-form documents
4. Real-time team chat
5. Infrastructure observability
6. Error / exception tracking
7. Product analytics warehouse

Use git history when the target is in a repository, and `gh` for PR context when installed and authenticated. Record a gap if either is unavailable. For the other six, classify using source contents and the discovered interface. If a source could fit more than one category, choose the one matching its primary evidence. Record ambiguous cases in the coverage map.

Build a **coverage map** of the categories you searched, with the null results, and name the reachable categories you skipped as irrelevant. Document the null; don't hide it.

Search the chosen categories inline, or delegate one disjoint source scope per investigator per Pi routing above when the active mode allows. All investigation is read-only, including remote queries; access to a tool is not permission to mutate its source.

Each investigator (or inline pass) gets:
1. The base prompt from `references/investigator-prompt.md`
2. The category playbook `references/sources/<source>.md` for the selected source, adapted from the examples in `references/source-playbook.md`
3. The cross-cutting `references/sources/incident-postmortem.md` **if the target code looks defensive** (null checks, retry logic, timeout handling, rate limiting, feature flags, egress guards, OOM handlers)
4. The code anchor from Step 2 (file paths, symbols, commit hashes, PR numbers, ticket IDs)
5. The user's original question

### Investigator roster. One per reachable evidence category

Each category owns one source scope, with cross-source leads passed to the lead rather than duplicated.

Each entry names the category and the kind of "why" it uniquely surfaces. Use it to pick categories, to know what to expect back, and to name a gap when a category returns empty or is skipped.

1. **Source control investigator**. Git history, `gh` for PRs, code comments, tests. Always investigate when repository history is reachable; otherwise record the gap. Best at surfacing *implementation-time rationale captured during review*.

2. **Issue / ticket tracker investigator** (e.g. Linear, Jira, GitHub Issues, Plane, Shortcut MCP). Best at surfacing *the product or business forcing function*. Strongest when the why is external to engineering.

3. **Long-form documents investigator** (e.g. Notion, Confluence, Google Docs, Coda MCP). Best at surfacing *long-form design rationale*. Where the why is written out before it becomes code.

4. **Real-time team chat investigator** (e.g. Slack, Discord, Microsoft Teams, Mattermost MCP). Best at surfacing *real-time deliberation that never reached a doc*. Especially important when the source control, ticket, and doc paper trail is thin.

5. **Infrastructure observability investigator** (e.g. Datadog, New Relic, Honeycomb, Grafana, Splunk MCP). Infra/runtime view. Best at surfacing *infrastructure and runtime reality that motivated the code*. Strongest when the target reacts to an infra signal (timeouts, retries, rate limits, circuit breakers).

6. **Error / exception tracking investigator** (e.g. Sentry, Rollbar, Bugsnag, Airbrake MCP). Best at surfacing *the specific exceptions and error trajectories that motivated defensive or corrective code*. Strongest for catch blocks, null guards, type checks, retries, and other defenses.

7. **Product analytics warehouse investigator** (e.g. Databricks, Snowflake, BigQuery, ClickHouse, dbt, Redshift MCP). Product/data view. Best at surfacing *product and data reality that shaped the code*. Strongest for flag-gated code, experiment-driven ships, data migrations, and "where did this number come from" questions.

### When to skip an investigator

Every skip gets a written justification in the final "Sources Consulted" section. Two kinds:

- **No source is reachable for that category** in this environment. Flag this as a gap, not a choice. Example: "Real-time team chat skipped. No reachable source available, so the conversational record was not searchable."
- **The category cannot bear on this question.** Example: "Error / exception tracking skipped. Target is a build-time script with no runtime code path."

When a PR description or commit already answers a narrow question completely, answer from it and say the other categories were not searched for that reason.

## Step 4. Synthesize

Synthesize inline or delegate a read-only synthesizer using Pi routing above. Citation checks may use any reachable read-only source.

The synthesizer gets:
1. The findings, including any null results and any categories skipped with justification
2. The code anchor from Step 2 (file paths, symbols, commit hashes, PR numbers, ticket IDs)
3. The user's original question
4. The epistemics framework from `references/epistemics.md`
5. The synthesizer prompt template from `references/synthesizer-prompt.md`

## Step 5. Present

Take the synthesizer's output and present it to the user. You may lightly edit for clarity or add context from the conversation, but **do not rewrite the confidence language**.

## Output Format

The output structure is the one in `references/synthesizer-prompt.md`: The Question, The Code in Question, What We Found, What We Can Reasonably Infer, Competing Hypotheses, What We Don't Know, Sources Consulted, Confidence Summary. Adapt as needed, but keep the confidence separation intact, and keep Sources Consulted as one line per category, including the ones that returned nothing or were skipped, with the reason.

After the Sources Consulted block, if the user's `why` question is a precursor to actually changing this code, convert the lineage findings into a Preserve / Change / Avoid / Risk constraint set suitable for planning the change.

## Common Failure Modes to Avoid

- **Recency bias**. Assuming the most recent commit is authoritative. The current shape is often the accretion of many earlier decisions. Trace back.

## Reference Files

- `references/epistemics.md`. Confidence tiers and phrasing guide. The synthesizer must follow it.
- `references/investigator-prompt.md`. Base prompt template for investigator subagents.
- `references/source-playbook.md`. Index pointing at the category playbooks below.
- `references/sources/*.md`. One self-contained example playbook per category, plus cross-cutting `incident-postmortem.md`. Read the matching category file and adapt its queries to the reachable interface.
- `references/synthesizer-prompt.md`. Prompt template for the synthesizer subagent, including the output format.

Adapted from pstack (MIT, (c) 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack/skills/why
