# Jev extension

Agent-callable advisory classifiers (Choice / Score / Noul) over text state.
No generation, no tool execution, no worker dispatch. Deleting this directory
removes the feature cleanly; nothing outside it imports this code.

Question design and TypeSafe product docs live in the `typesafe-ai` skill
(`agent/skills/typesafe-ai/`, local pairing in `PI.md`). This extension remains
the in-session evaluator; the skill must not spawn a second client.

## Setup

Create `<config-root>/jev.json` in your editor (never paste the key in chat).
The config root resolves exactly like the Exa extension: `PI_CODING_AGENT_DIR`,
otherwise `XDG_CONFIG_HOME/pi`, otherwise `~/.pi`. With no overrides on Windows
this is `C:/Users/bskim/.pi/jev.json`. The file is read on each call, so key
rotation or provider switching needs no restart.

```json
{ "provider": "cloudflare-workers-ai" }
```

| Field | Type | Description |
|---|---|---|
| `provider` | `"typesafe"` \| `"cloudflare-workers-ai"` (optional) | Backend selector, default `"typesafe"`. No automatic fallback between providers. |
| `apiKey` | string (Typesafe only) | TypeSafe key. Literal or single `$VAR`/`${VAR}` reference. |
| `model` | string (optional) | Override. Defaults: `jev-1.13.0` direct, `typesafe/jev` on Cloudflare. Remove it when switching providers. |

**Typesafe path:** a non-empty `TYPESAFE_API_KEY` overrides file `apiKey`.
**Cloudflare path:** auth resolves per call from Pi's configured Cloudflare
credential via the injected model registry (stored credential or
`CLOUDFLARE_API_KEY` / `CLOUDFLARE_ACCOUNT_ID`); `jev.json` holds no secrets
in that mode. Unknown fields are ignored.

Cloudflare access also requires sufficient account balance or BYOK. HTTP 402,
code 2021 (`Insufficient balance; add money to your gateway or use BYOK`) indicates
a billing gate. The extension does not fund the account, modify billing, or retry
charges.

When your Typesafe key arrives, set `provider` to `typesafe`, remove any model
override, and supply `TYPESAFE_API_KEY` or `apiKey`. The agent-facing tool stays the
same; no code change is needed.

Typesafe environment presence check without printing the key:

```bash
node -e "console.log(process.env.TYPESAFE_API_KEY ? 'env present' : 'env absent; local file may supply it')"
git check-ignore -- jev.json
```

The second command must print `jev.json`.

## Tool

`jev({ state, questions, includeProbabilities? })`. One question for a one-off
classifier, or batch independent questions over the same state. Question shapes:

```json
{
  "state": "The customer was charged twice and requests a refund.",
  "questions": {
    "department": { "type": "choice", "instructions": "Which team handles this?",
      "criteria": { "billing": "Charges, refunds, duplicates", "shipping": "Delivery, delays" } },
    "refund": { "type": "noul", "instructions": "Does the customer request a refund?" },
    "severity": { "type": "score", "instructions": "How severe?",
      "criteria": ["routine", "urgent", "blocking"] }
  }
}
```

Answers echo `{model, answers, usage}` with native Jev counts (`input_tokens`,
`output_tokens`). Distributions appear only when
`includeProbabilities` is true. Noul has no confidence field: near 1 is yes,
near 0 is no, near 0.5 is uncertain — escalate, do not act. Client limits:
1–16 questions, 64,000 serialized characters, 30s timeout, no automatic retry
(a retry may incur another charge). On 429 the `retry-after` value is reported,
never slept on. On the Cloudflare route the gateway wraps the native body as
`{result: {state: "Completed", result: <native>, gatewayMetadata}, …}`; the
client unwraps it and rejects non-Completed states without polling. A
402 `Insufficient balance` means the gateway account needs funds or BYOK.

## Lifecycle hook

A `tool_result` listener watches every `task_wait` result. It never blocks or fails a wait. Three consecutive timeout heartbeats on the same worker+generation get a poll note (a later settle resets the count). Missing or invalid `reportStatus` on a settled body gets a one-line deterministic note. When a schema-valid report is long enough and a mission label is present, an extra Jev noul pair (`concrete_outcome`, `matches_mission`) may annotate a clearly empty or off-topic reply (`noul < 0.3`); that call is capped at 2.5s and errors are swallowed. Classifier calls incur extra Jev usage.

## Opt-in advisories

Three additional advisory features are available. All are disabled by default, so
an existing installation makes no extra API calls and changes no behavior until a
feature is enabled in the same `jev.json` used by [Setup](#setup):

```json
{
  "skillRouter":     { "enabled": true, "threshold": 0.8, "deadlineMs": 2500 },
  "codeJudge":       { "enabled": true, "threshold": 0.8, "deadlineMs": 2500, "maxChars": 16000 },
  "routingAdvisory": { "enabled": true, "threshold": 0.8, "deadlineMs": 2500 }
}
```

The loader in `internal/feature-config.ts` never throws. A missing, unreadable, or
malformed file silently produces the all-disabled defaults. Invalid fields fall
back individually without discarding valid siblings in the same block.

| Field | Range | Default |
|---|---:|---:|
| `enabled` | boolean | `false` |
| `threshold` | `0.5`–`1` | `0.8` |
| `deadlineMs` | `250`–`10000` | `2500` |
| `maxChars` (code judge only) | `1000`–`60000` | `16000` |

Numeric values are clamped to their ranges. Each enabled evaluation is chained to
the turn's abort signal and bounded by that feature's `deadlineMs`. A timeout, HTTP
error, or malformed answer fails open: no advisory is added and the turn continues.
Prompts shorter than 24 characters are not evaluated; longer prompt text is capped
at 8,000 characters before it is sent to Jev.

All output is advisory. These features do not block or gate work, load a skill,
revert an edit, dispatch a worker, or switch a model.

Automatic matches are shown as truthful custom-message/custom-entry receipts labeled
**Jev suggestion**; they are not fake tool calls. Turn-level skill/risk suggestions
are one model-visible custom message, replacing the former duplicate system-prompt
suffix while preserving the same advisory text exactly once. Code findings remain
one annotation on the originating tool result; their receipt is a display-only
custom entry and therefore adds no model context. No-match results stay quiet except
for the footer:

```text
jev skill=writing-for-agents · 3 guards · 4 calls, 3,190 tok
jev judge 2 on route-strategy.ts · 5 calls, 4,102 tok
jev no findings · 6 calls, 4,986 tok
```

The counts are per-session totals for automatic calls only. Session start clears
counts, correlations, and the footer. The footer and receipt chrome are cosmetic;
when custom chrome is disabled, turn suggestions use Pi's bounded plain custom-message
fallback and code entries use the extension's bounded plain entry renderer. Neither
path starts or steers an extra model turn.

### Skill router

The skill router (`internal/skill-router.ts`) runs on `before_agent_start`. It sends
the user prompt and discovered skill catalog as one Choice question: each skill's
description is an option, with `none_needed` reserved for requests that have no
clear match. If a real skill wins with probability at or above `threshold`, the extension adds
one model-visible `Jev suggestion` custom message naming the match. The lead still
decides whether to read and use that skill; nothing is loaded automatically.

Skills whose frontmatter sets `disable-model-invocation: true` are excluded and can
never be suggested. The catalog is capped at 31 skills because the client allows 32
Choice options and one is reserved for `none_needed`.

### Routing advisory

The routing advisory (`internal/routing-advisory.ts`) asks four independent Noul
questions over the same turn:

- `crosses_trust_boundary`
- `weakens_safety_control`
- `sounds_easier_than_it_is`
- `scope_is_underspecified`

Guards at or above `threshold` are combined into one advisory line. They report
stakes only; they do not recommend an agent or model.

There is deliberately no complexity Score. On the request “just add a quick flag
to skip the confirmation prompt on destructive bash commands,” a complexity Score
returned `1.29` (“routine”), which could encourage routing to a cheaper model, while
the guard Nouls returned `0.95`, `0.97`, and `0.81`. Difficulty and stakes are
orthogonal, so this feature reports stakes instead of grading difficulty.

### Clean-code judge

The clean-code judge (`internal/code-judge.ts`) runs after a successful `edit` or
`write` result for a judgeable code file. It sends file content, truncated at
`maxChars` on a newline boundary, with five Noul questions:

| Question | Polarity | Fires when |
|---|---|---:|
| `speculative_abstraction` | bad | `noul >= threshold` |
| `dead_or_unreachable` | bad | `noul >= threshold` |
| `duplicated_logic` | bad | `noul >= threshold` |
| `naming_reveals_intent` | good | `noul <= 1 - threshold` |
| `single_responsibility` | good | `noul <= 1 - threshold` |

Findings are combined into one reviewer-hint line on the tool result and displayed
as a `Jev suggestion` receipt. No findings means no annotation or receipt; the footer
says `no findings`.

The judge skips prose (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`), JSON, YAML, TOML,
lockfiles, `.min.js`, `.d.ts`, paths under `node_modules`, and all tests: filenames
matching `*.test.*` or `*.spec.*`, and paths containing `test/`, `tests/`, or
`__tests__/`. Test scaffolding would otherwise create avoidable false positives.

### Local evaluation telemetry

Automatic evaluations append bounded, rotating JSONL metadata to
`<agent-dir>/logs/pi-jev.jsonl` (`pi-jev.jsonl.1` is the previous segment). The
active segment rotates near 1 MB. Logging fails soft and stores no prompts, code,
patches, error bodies, credentials, or absolute target paths. Every record includes
a stable `workspaceId`: the first 24 hexadecimal characters of SHA-256 over the
normalized workspace cwd (case-folded on Windows). The cwd itself is never logged.
Records otherwise contain only timestamps, ephemeral session/evaluation/suggestion
IDs, sources, outcome (`success`, `no-match`, `timeout`, `error`, `cancelled`, or
known `skipped`), elapsed
milliseconds, available token counts, configured thresholds, skill decision reason
(`selected`, `none_needed`, `below_threshold`, or `unusable`), bounded winner key and
probability, candidate count, selected skill/finding IDs, known skip reason, and
correlation tool-call IDs.

`read-after-suggestion` means a later successful `read` targeted the exact discovered
`SKILL.md`. `edit-after-finding` means a later successful edit/write targeted the
same file as a finding. Only the latest pending suggestion per target is eligible,
so one action never credits older superseded suggestions. These are follow-through
proxies only: they do **not** prove causal adoption, correctness, or improvement.

Summarize the active and rotated records without changing them. Pass the target
workspace cwd as the first argument (for example, run this from a shell with
`node - "$(pwd)"` to scope to the current workspace):

```bash
node - "$(pwd)" <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const targetCwd = path.resolve(process.argv[2] || process.cwd());
const normalized = targetCwd.split(path.sep).join("/");
const canonical = process.platform === "win32" ? normalized.toLowerCase() : normalized;
const workspaceId = crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 24);
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const files = ["pi-jev.jsonl.1", "pi-jev.jsonl"]
  .map((name) => path.join(agentDir, "logs", name))
  .filter(fs.existsSync);
const rows = files.flatMap((file) => fs.readFileSync(file, "utf8")
  .split(/\r?\n/).filter(Boolean).map(JSON.parse))
  .filter((row) => row.workspaceId === workspaceId);
const evaluations = rows.filter((row) => row.event === "evaluation");
const counts = (values) => Object.fromEntries([...new Set(values)].sort()
  .map((value) => [value, values.filter((item) => item === value).length]));
const timed = evaluations.filter((row) => Number.isFinite(row.elapsedMs));

console.log({
  workspaceId,
  files: files.length,
  events: rows.length,
  outcomes: counts(evaluations.map((row) => row.status)),
  skillDecisionReasons: counts(evaluations.map((row) => row.skillDecision?.reason).filter(Boolean)),
  selected: rows.filter((row) => row.event === "suggestion" && row.skill).length,
  selectedThenRead: rows.filter((row) => row.event === "read-after-suggestion").length,
  found: rows.filter((row) => row.event === "suggestion" && row.source === "code-judge" && row.findings?.length).length,
  foundThenEdited: rows.filter((row) => row.event === "edit-after-finding").length,
  avgLatencyMs: timed.length ? Math.round(timed.reduce((sum, row) => sum + row.elapsedMs, 0) / timed.length) : 0,
  tokens: evaluations.reduce((sum, row) => sum + (row.inputTokens || 0) + (row.outputTokens || 0), 0),
});
NODE
```

### Design and measured checks

The routing advisory and clean-code judge use Nouls only. In a matched synthetic
pair, over-engineered and clean code separated at `0.93`/`0.87` versus
`0.29`/`0.09` on the relevant Nouls, while the equivalent Score had confidence
`0.51` and `0.25`. Those Score results were too uncertain to threshold on.

When both per-turn features are enabled, the skill router and routing advisory share
one Jev call. Jev evaluates all questions in a request in parallel, so the second
feature adds questions without adding another network round trip.

Live spot checks with `jev-1.13.0` produced these results:

- “Just add a quick flag to skip the confirmation prompt on destructive bash
  commands so I stop getting interrupted.” selected `none_needed` at `0.95`, so
  the skill router stayed silent. The routing advisory reported three guards at
  `0.95`, `0.97`, and `0.81`; `scope_is_underspecified` at `0.70` stayed below the
  default threshold.
- An over-engineered factory/strategy sample reported `speculative_abstraction` at
  `0.93` and `dead_or_unreachable` at `0.87`. `duplicated_logic` at `0.45` and
  `single_responsibility` at `0.53` did not fire. The clean single-function
  equivalent produced no annotation.
- Each call used roughly 700–800 input tokens.

These are a handful of spot checks on synthetic samples, not a calibration study.
Evaluate thresholds against the intended workload and consequences before relying
on them operationally.
