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
