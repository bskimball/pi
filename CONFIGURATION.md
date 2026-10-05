# Configuration reference

Local parameter documentation and authoritative upstream references for the
config/markdown formats used in this repo. Two kinds of format are covered:

- **Upstream Pi** — defined by the installed `@earendil-works/pi-coding-agent`
  package (`node_modules/@earendil-works/pi-coding-agent/docs/`). Documented
  here at summary level with a link to the authoritative doc; do not treat this
  file as a full replacement for those docs.
- **Local custom** — defined by this repo's own extensions
  (`agent/extensions/*.ts`) and not part of upstream Pi. Documented here in
  full, sourced directly from the implementation.

Package versions are declared in `package.json` and locked in `package-lock.json`.
Native MCP requires Pi 0.99.0 or newer; this configuration uses Pi 0.99.1.
When in doubt, compare the installed version and read
`node_modules/@earendil-works/pi-coding-agent/docs/*.md` directly.

## Contents

- [Ignored secret configs and their example files](#ignored-secret-configs-and-their-example-files)
- [`agent/mcp.json` (upstream Pi, MCP servers)](#agentmcpjson-upstream-pi-mcp-servers)
- [`agent/models.json` (upstream Pi, custom providers/models)](#agentmodelsjson-upstream-pi-custom-providersmodels)
- [`web-search.json` (local custom, web-search extension)](#web-searchjson-local-custom-web-search-extension)
- [`jev.json` (local custom, Jev extension)](#jevjson-local-custom-jev-extension)
- [`agent/settings.json` (upstream Pi)](#agentsettingsjson-upstream-pi)
- [Agent markdown (`agent/agents/*.md`, local custom)](#agent-markdown-agentagentsmd-local-custom)
- [Prompt template markdown (`agent/prompts/*.md`, upstream Pi)](#prompt-template-markdown-agentpromptsmd-upstream-pi)
- [Skill markdown (`agent/skills/**/SKILL.md`, upstream Pi)](#skill-markdown-agentskillsskillmd-upstream-pi)
- [Themes (`agent/themes/*.json`, upstream Pi)](#themes-agentthemesjson-upstream-pi)
- [Extensions (`agent/extensions/*.ts`, upstream Pi)](#extensions-agentextensionsts-upstream-pi)

---

## Ignored secret configs and their example files

Three local config files hold live credentials and are excluded from git via
`.gitignore`. Each has a tracked `*.example.json` sibling with the same shape
and placeholder/env-only values, safe to commit:

| Active (ignored) | Example (tracked) |
|---|---|
| `agent/mcp.json` | `agent/mcp.example.json` |
| `agent/models.json` | `agent/models.example.json` |
| `web-search.json` | `web-search.example.json` |

To restore on a new machine, copy the example to the active filename and fill
in real values (see [README.md](README.md#restore-on-a-new-machine)):

```bash
cp agent/mcp.example.json agent/mcp.json
cp agent/models.example.json agent/models.json
cp web-search.example.json web-search.json
```

The `*.example.json` naming was chosen (over e.g. `.sample`) because most
editors and JSON tooling recognize `.json` as the trailing extension and apply
JSON syntax highlighting/validation; `git check-ignore` confirms the active
filenames stay ignored while the `*.example.json` files remain trackable
(verified during this change; see Validation in the task summary).

Do not put real keys in the example files. Use `$ENV_VAR` placeholders or
obviously-fake literals.

---

## `agent/mcp.json` (upstream Pi, MCP servers)

**Authoritative doc:** `node_modules/@earendil-works/pi-coding-agent/docs/mcp.md`.
For scripting, read the same package's `docs/cli.md` section "How codemode works"
and the local `agent/skills/mcp-scripting-recipes/SKILL.md`.

**Location:** `~/.pi/agent/mcp.json` (global, ignored). Trusted projects can use
`.pi/mcp.json`; their same-name servers replace global entries. Native Pi does
not read the retired `mcp-adapter.json` or adapter cache/approval files.

**Root shape:** `{ "mcpServers": { "<name>": { /* server */ } },
"autoEnableCodemode": true }`. The latter is optional and defaults to true.
Server names accept letters, digits, `_`, and `-`.

| Server fields | Notes |
|---|---|
| `command`, `args`, `env`, `cwd` | Stdio; command is one executable, arguments are separate strings. Relative cwd resolves against the session directory. |
| `url`, `headers`, `oauth` | Streamable HTTP. Legacy SSE is unsupported. |
| `type` | Optional: inferred from command or URL. Accepted explicit values are `stdio`, `http`, `streamable-http`. |
| `timeout` | Positive per-request seconds, default 60; progress notifications reset it. |
| `enabled` | Default true; false retains the definition without connecting. |
| `exposure` | Default `codemode`; also `codemode-deferred`, `deferred`, `direct`, `hidden`. |
| `toolExposure` | Overrides exposure for exact tool names or `*` patterns. |
| `oauth` fields | `clientId`, `clientSecret`, `callbackPort`, `callbackUrl`, `scope`; see upstream for callback constraints. |

`env`, `headers`, and OAuth client secrets can resolve `${NAME}` or a whole-value
`!command`. Use environment references for credentials. Context7 uses
`headers.Authorization: "Bearer ${CONTEXT7_API_KEY}"`, not adapter bearer fields.
HTTP servers without an Authorization header can use OAuth; approve sign-in
through `/mcp login <server>` or `pi mcp login <server>`. Native tokens live in
ignored `agent/mcp-auth.json`; adapter credential-store entries are not imported.

**Tools and rendering:** native tools use `mcp__<server>__<tool>` names (sanitized
or shortened where necessary), default to codemode exposure, and keep Pi's native
rendering. Codemode discovers them with `searchTools`/`describeTool` and calls
`tools[exactName](args)`. `tool_search` can load undeclared tools for direct calls.
The retired adapter's `mcp` gateway, namespace proxies, `mcpScript`, and bundled
skill are no longer registered.

**Validation and reload:** `pi mcp list` connects every enabled server, lists its
tools, and exits nonzero on errors. Run `/reload` or start a new session after
configuration changes. `/mcp` manages native connection state, exposure, and sign-in.
Servers connect at startup; normal server log messages go to `agent/mcp.log`
(rotated as `agent/mcp.log.1`).

**Example:** `agent/mcp.example.json` contains the configured Chrome stdio server
and Context7 HTTP server with an environment-only credential reference. The Chrome
server targets the dedicated debug browser on port 29300. Its npm version stays
pinned because `npx -y` may download and execute it. Review that pin deliberately.
The old ignored adapter config/runtime files remain inert for rollback.

---

## `agent/models.json` (upstream Pi, custom providers/models)

**Authoritative doc:** `node_modules/@earendil-works/pi-coding-agent/docs/models.md`.
Summarized here; consult that file for the OpenAI-compatibility (`compat`) and
Anthropic-compatibility (`compat`) field tables, which are extensive and not
duplicated in full below.

**Location:** `~/.pi/agent/models.json` (global only; no project-level
variant). **Reload behavior:** reloads every time `/model` is opened — edits
apply mid-session, no restart needed.

### Root shape

```jsonc
{ "providers": { "<provider-id>": { /* ProviderConfig */ } } }
```

### Provider fields

| Field | Required | Description |
|---|---|---|
| `name` | No | Human-readable provider label. |
| `baseUrl` | conditional | API endpoint. Non-built-in providers with `models` need a `baseUrl`, set at provider or model level. |
| `api` | conditional | One of `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`. Non-built-in providers with `models` need this at provider or model level. |
| `apiKey` | No | See Value Resolution below. Omit to rely on `/login`/`auth.json`/CLI `--api-key`. |
| `oauth` | No | Dynamic OAuth provider type; currently only `"radius"`. |
| `headers` | No | Custom headers; same value resolution as `apiKey`. |
| `authHeader` | No | `true` auto-adds `Authorization: Bearer <apiKey>`. |
| `models` | No | Array of model configs (see below). |
| `modelOverrides` | No | Per-model overrides for built-in or extension-registered models on this provider — see doc for exact overridable field list. |
| `compat` | No | Provider-level API-compatibility overrides; merges with model-level `compat`. |

### Value resolution (`apiKey`, `headers`)

| Form | Example | Behavior |
|---|---|---|
| Shell command | `"!op read 'op://vault/item/key'"` | Executes at request time; no built-in caching/TTL/retry — wrap slow/rate-limited commands yourself. |
| Env interpolation | `"$MY_KEY"`, `"${MY_KEY}"` | Missing var = unresolved value. |
| Escapes | `"$$literal"`, `"$!literal"` | Literal `$`/`!` without triggering interpolation/exec. |
| Literal | `"sk-..."` | Used as-is. Plain uppercase strings are literals, not env refs — use `$MY_KEY` for env vars. |

`/model` availability checks use configured-auth presence only; they do not
execute shell commands.

### Model fields

| Field | Required | Default | Description |
|---|---|---|---|
| `id` | Yes | — | Passed to the API. |
| `name` | No | `id` | Human label; used for `--model` matching and secondary detail text (footer/status bar still show `id`). |
| `api` | No | provider's `api` | Per-model override. |
| `baseUrl` | No | provider's `baseUrl` | Per-model endpoint override. |
| `headers` | No | provider's `headers` | Per-model custom headers; uses the same value resolution as provider headers. |
| `reasoning` | No | `false` | Extended thinking support. |
| `thinkingLevelMap` | No | omitted | Maps pi thinking levels (`off`…`max`) to provider values; `null` hides/clamps a level, omitted keys use provider defaults through `high` and hide `xhigh`/`max`. |
| `input` | No | `["text"]` | `["text"]` or `["text","image"]`. |
| `contextWindow` | No | `128000` | Tokens. |
| `maxTokens` | No | `16384` | Max output tokens. |
| `cost` | No | all zero | Per-million-token rates, optional `tiers` for threshold-based alternate rates (see doc for tier semantics). |
| `compat` | No | provider `compat` | Model-level override, merged with provider-level. |

This repo's active `agent/models.json` also uses `providers.<id>.modelOverrides`
(e.g. `cloudflare-workers-ai`) and an `ollama` provider with a local `_launch`
model-array key that is not part of the documented schema above — treat any
undocumented key found in the active file as provider/tooling-specific rather
than assuming it is a typo; verify against the installed docs before editing.

### Example

`agent/models.example.json` mirrors the real shape (`providers.local-proxy`,
`providers.ollama`) with one placeholder model per provider and
`apiKey: "$LOCAL_PROXY_API_KEY"` instead of a real key.

---

## `web-search.json` (local custom, web-search extension)

**Loaded by:** `agent/extensions/web-search.ts` (`configPath()` /
`exaApiKey()`). This is a **local, hand-rolled extension**, not an upstream Pi
config format — there is no upstream schema to link to.

**Location:** `configRoot/web-search.json`, where `configRoot` is
`PI_CODING_AGENT_DIR` if set, else `$XDG_CONFIG_HOME/pi` if set, else
`~/.pi`. In this repo's default environment, no override is set and the file
lives at `~/.pi/web-search.json` (repo root). Upstream Pi commonly uses
`PI_CODING_AGENT_DIR` for the actual agent directory (for example
`~/.pi/agent`); if that variable is set, this extension follows it literally
and reads `~/.pi/agent/web-search.json` instead.

**Reload behavior:** `web_search` reads the credential fresh from disk on each
call via `readFileSync` (no caching), so edits apply immediately. The
`fetch_content` and `get_search_content` tools do not read or require this
credential file.

### Fields the extension actually reads today

| Field | Type | Description |
|---|---|---|
| `exaApiKey` | string | Exa API key. Supports the same `$VAR`/`${VAR}` env-interpolation the extension implements in `expandEnv()` (a literal value or a single `$VAR`/`${VAR}` reference — no `!command` support, unlike `models.json`/`mcp.json`). |

**`EXA_API_KEY` environment variable takes precedence over this file.**
Resolution order in `exaApiKey()`: `process.env.EXA_API_KEY` (trimmed, if
non-empty) → else parse `web-search.json` and read/expand `exaApiKey`. If
neither resolves, `web_search` fails with: *"Exa API key is required. Set
EXA_API_KEY or add exaApiKey to web-search.json."* `fetch_content` fetches
public URLs directly and does not require an Exa key.

### Fields present in the active file but not read by the current code

The active `web-search.json` in this repo (kept ignored/private) also
contains `provider`, `chromeProfile`, `searchModel`, `summaryModel`,
`workflow`, `curatorTimeoutSeconds`, `githubClone` (`enabled`,
`maxRepoSizeMB`, `cloneTimeoutSeconds`, `clonePath`), `youtube`, `video`, and
`shortcuts` keys. These are **not consumed anywhere in
`agent/extensions/web-search.ts`** as of this writing (verified by grep across
`agent/extensions/**/*.ts` — no matches outside the file itself). They read
like a superset schema from a prior/alternate web-search implementation.
Treat them as inert/legacy in the current extension; do not document them as
supported, and do not copy them into the example file. If they become
supported again, update the "fields actually read" table above from the
extension source, not from the shape of the active file.

### Example (`web-search.example.json`)

Contains only the field the extension currently reads
(`exaApiKey`), set to `"$EXA_API_KEY"` so the file works unmodified if the
env var is set, and is an explicit placeholder otherwise.

---

## `jev.json` (local custom, Jev extension)

**Loaded by:** `agent/extensions/jev/internal/client.ts` (config-root /
expansion pattern copied from `agent/extensions/web-search.ts`; never imported).
Reads the file fresh on each `jev` call, so key rotation needs no restart.

**Location:** `configRoot/jev.json` (`PI_CODING_AGENT_DIR`, else
`$XDG_CONFIG_HOME/pi`, else `~/.pi`). Ignored via `.gitignore`; there is no
tracked example file. Never paste the real key in chat, tool arguments,
results, logs, or session entries.

| Field | Type | Description |
|---|---|---|
| `apiKey` | string | Jev API key (Typesafe path). Literal or single `$VAR`/`${VAR}` reference. |
| `model` | string (optional) | Override. Defaults: `jev-1.13.0` direct, `typesafe/jev` on Cloudflare; remove it when switching providers. |
| `provider` | `"typesafe"` \| `"cloudflare-workers-ai"` (optional) | Backend selector, default `"typesafe"`. Cloudflare auth resolves per call from Pi's configured Cloudflare credential (stored credential or `CLOUDFLARE_API_KEY` / `CLOUDFLARE_ACCOUNT_ID`); no secrets stored in `jev.json`, no automatic fallback between providers. The gateway envelope `{result: {state, result, gatewayMetadata}}` is unwrapped (completed state required) before validation. |
| `skillRouter.enabled` | boolean | Opt-in skill Choice. Default `false`. |
| `skillRouter.threshold` | number `0.5`–`1` | Min winner probability. Default `0.55` (other features keep `0.8`). |
| `skillRouter.minConfidence` | number `0`–`1` | Min Choice confidence. Default `0.6`. |
| `skillRouter.minMargin` | number `0`–`1` | Min (top1 − top2), including `none_needed` as runner-up. Default `0.15`. |
| `skillRouter.deadlineMs` | integer `250`–`10000` | Per-turn deadline. Default `2500`. |
Unknown fields are ignored. Malformed JSON fails the call with an actionable
config error and no request sent. A missing file selects the Typesafe backend
and then requires the key. A missing file is not an error when the
environment supplies the key.

---

## `agent/settings.json` (upstream Pi)

**Authoritative doc:** `node_modules/@earendil-works/pi-coding-agent/docs/settings.md`
— the single most complete parameter reference already installed locally (model
& thinking, UI & display, network, warnings, compaction, branch summary, retry,
message delivery, terminal & images, shell, sessions, model cycling, markdown,
and resources/`packages`/`extensions`/`skills`/`prompts`/`themes` arrays, each
with type/default/description tables). This repo does not restate that table;
read the doc directly, it is not secret-bearing and does not need local
supplementing beyond what's below.

**Location:** `~/.pi/agent/settings.json` (global, tracked in this repo) with
optional `.pi/settings.json` project overrides (nested objects merge, project
wins). Not gitignored — contains no secrets, just preferences.

This repo's tracked `agent/settings.json` sets: `defaultModel`
(`gpt-6-sol`), `defaultProvider` (`openai-codex`),
`defaultThinkingLevel`, `lastChangelogVersion`, `packages`
(`npm:@ff-labs/pi-fff` for FFF fuzzy finding, `npm:pi-intercom` for the
`intercom` tool), `steeringMode`,
`transport`, `terminal.showTerminalProgress`, `editorPaddingX`, `theme` (`claude-dark`),
and `tuiMode`. Native MCP is built in and needs no package or external skill
registration; see the mcp.json section above.
`enabledModels` is intentionally omitted so `/model` and Ctrl+P see every configured
provider without a scope allowlist. Compaction is not overridden in this file; Pi-native defaults apply (`reserveTokens` 16384 for summary headroom, `keepRecentTokens` 20000 for the retained recent tail).

The active default and all GPT agent routes use `openai-codex` (for example
`openai-codex/gpt-6-sol`, `openai-codex/gpt-6-luna`, and
`openai-codex/gpt-6-astra`). Non-GPT agent routes still use configured providers
such as `claude-bridge/claude-opus-5-5`, `claude-bridge/claude-sonnet-5`, `antigravity/gemini-3.8-flash`, xAI,
OpenCode, and Cloudflare Workers AI fallbacks.

---

## Agent markdown (`agent/agents/*.md`, local custom)

**Not an upstream Pi format.** Parsed entirely by this repo's
`agent/extensions/task/runtime/agent-discovery.ts` (`parseAgentFile`), consumed by
`task/amp-task.ts` (sync `task` tool) and `task/async-task.ts` (async
`task_*` tools).

**Locations (project overrides global on name collision):**
- Global: `<Pi agent dir>/agents/*.md` (`agent/agents/*.md` here)
- Project: `<cwd>/.pi/agents/*.md`

Files starting with `_` are excluded from discovery (`_shared.md`,
`_shared-sync.md`, `_shared-async.md`, and `_handoff.md` here) — they are shared
text injected by convention, not agent definitions.

**Format:** YAML-like frontmatter block (`---\n...\n---`) parsed with regex
(not a real YAML parser — see caveats below), followed by the system-prompt
body.

### Frontmatter fields

| Field | Required | Type | Description |
|---|---|---|---|
| `name` | No | string | Agent identifier used in `task(agent: "...")`. Defaults to the filename without `.md`. |
| `description` | No | string | One-line role summary (defaults to empty string if omitted). |
| `model` | No | string | Primary model, e.g. `local-proxy/grok-4.5`. Bare model names (no `/`) inherit no provider qualification unless already qualified. |
| `fallbackModels` | No | list | YAML-style list (inline `[a, b]` or block `- item` form). Tried in order if the primary model fails; see `modelAttempts()` for the exact chain-building logic (explicit override at task-call time replaces only the primary, not the fallback chain). |
| `thinking` | No | string | Thinking level, e.g. `medium`. |
| `tools` | No | string | **Comma-separated string**, not a YAML list, e.g. `read, ffgrep, fffind, ls, bash, edit, write, task`. |
| `maxTurns` | No | number | Parsed with `Number(...)`; invalid values become `undefined`. |
| `timeoutSec` | No | number | Same parsing behavior as `maxTurns`. |
| `inheritSkills` | No | boolean | Defaults to `true`; only the literal string `"false"` in frontmatter disables it (passes `--no-skills` to the child). |

Body (everything after the closing `---`) is the agent's system prompt,
trimmed of leading/trailing whitespace.

### List field syntax (`fallbackModels`)

Either form works:

```yaml
fallbackModels:
  - openai-codex/gpt-5.6-sol
  - 'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code'
```

```yaml
fallbackModels: [openai-codex/gpt-5.6-sol, cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code]
```

Both single and double surrounding quotes on individual list items are
stripped.

### Parsing caveats (this is a regex parser, not YAML)

- Each scalar field is matched line-by-line with `^${key}:[ \t]*(.+)$` — multi-line
  scalar values are not supported.
- There is no schema validation; unknown frontmatter keys are silently
  ignored, and malformed frontmatter (no `---...---` block) makes the whole
  file fail to parse (`parseAgentFile` returns `undefined` and the agent is
  skipped, not a hard error).
- Do not assume upstream Pi frontmatter fields (e.g. anything from
  `prompt-templates.md`/`skills.md`) apply here — this is a completely
  separate, repo-local format read only by `agent-discovery.ts`.

### Shared files

`_shared.md` contains common specialist norms. The task implementation then
prepends one mode-specific fragment: `_shared-sync.md` for fire-and-forget
synchronous `task` workers, or `_shared-async.md` for persistent RPC workers
that support steering, follow-ups, and UI requests. `_handoff.md` is appended
for both modes and requires a non-empty visible final report for the current
generation. Project copies override global copies independently per file.
All four files are plain Markdown with no frontmatter.

---

## Prompt template markdown (`agent/prompts/*.md`, upstream Pi)

**Authoritative doc:** `node_modules/@earendil-works/pi-coding-agent/docs/prompt-templates.md`.

**Locations:** global `<Pi agent dir>/prompts/*.md`, project
`.pi/prompts/*.md` (after trust), package `prompts/` dirs, `settings.json`
`prompts` array, or `--prompt-template`. Discovery is **non-recursive** by
default.

### Frontmatter fields

| Field | Required | Description |
|---|---|---|
| `description` | No | Shown in autocomplete; falls back to the first non-empty body line if omitted. |
| `argument-hint` | No | Shown before description in autocomplete. `<required>` / `[optional]` convention. |

### Argument substitution in the body

| Token | Meaning |
|---|---|
| `$1`, `$2`, ... | Positional args |
| `$@` / `$ARGUMENTS` | All args joined |
| `${1:-default}` | Arg 1, or `default` if absent/empty |
| `${@:-default}` / `${ARGUMENTS:-default}` | All args, or `default` if absent/empty |
| `${@:N}` | Args from position N (1-indexed) |
| `${@:N:L}` | `L` args starting at N |

The filename (minus `.md`) becomes the `/name` command. This repo currently
has two live prompt templates: `agent/prompts/brainstorm.md`
(`argument-hint: "[topic]"`, uses `${@:-the current task}`) and
`agent/prompts/poteto.md` (`argument-hint: "[goal, or 'new task. <goal>']"`,
uses `${@:-the current task}`). Playbooks for `/poteto` live in
`agent/prompts/poteto/*.md` and are **not** slash commands — discovery is
non-recursive, so that subdirectory is disclosed reference the router reads
after match. Complexity review moved to the `simplify` skill
(`agent/skills/simplify/SKILL.md`);
`/browser` and
`/deploy` are **not** prompt templates — they are native commands registered
in code by `agent/extensions/prompt-commands.ts` via `pi.registerCommand()`
because they need executable pre-steps (git snapshotting, a deterministic
browser-connect step) that plain template expansion can't do. `/orchestrate`
is likewise native: it is a sticky per-turn system-prompt mode toggle
(`before_agent_start` + persisted custom entry), not a one-shot template. The previous
README wording implying `/browser`/`/deploy` are "registered in
`agent/settings.json` and defined under `agent/prompts/`" was inaccurate and
has been corrected (see README changes).

### Body structure

Slash prompts in this repo (live templates under `agent/prompts/*.md`, reference copies in `agent/prompts/inactive/*.md`, and native prompt builders that emit handoff bodies in `agent/extensions/prompt-commands/featured-commands.ts`) follow a unified structural skeleton:

```text
---
description: <one line: what it does, and the stance (e.g. do not implement)>
argument-hint: "<required>" or "[optional]"
---
<Invocation: one present-tense sentence naming the target, with the existing substitution token>

<Stance: 1–2 sentences. Mode, whether to edit, and the stop condition. Positive target behavior first.>

## Scope
What this run covers, how arguments change that, and what is out.

## <Procedure>
Ordered steps. Each step ends on a checkable completion criterion.
Use a single leading-word heading for the work this prompt does:
- brainstorm diverge phase: ## Diverge
- poteto: ## Route (playbook files under `prompts/poteto/` own per-kind steps)
- browser: ## Attach then ## Act (Attach reports connect status before Act begins)
- deploy: ## Resolve then ## Delegate

If the prompt has a gated second phase, give it its own heading immediately after (## Converge, ## Act, ## Delegate). Put the gate in the first sentence of that heading ("Only when I ask you to converge…").

## Report
The required output shape. Checkable. Exhaustive for that shape.

<Stop line: one sentence restating when to stop or wait.>
```

Native builders (`buildBrowserPrompt`, `buildDeployPrompt`) omit frontmatter and emit this same body beginning at the invocation line, appending disclosed runtime evidence blocks (`[Connect step]`, `## Pre-step snapshot`) after `## Report` and the stop line.

---

## Skill markdown (`agent/skills/**/SKILL.md`, upstream Pi)

**Authoritative doc:** `node_modules/@earendil-works/pi-coding-agent/docs/skills.md`
(implements the [Agent Skills standard](https://agentskills.io/specification)
with documented Pi-specific leniencies — notably, Pi does not require `name`
to match the parent directory).

**Locations relevant to this repo:** global `<Pi agent dir>/skills/`
(`agent/skills/` here) and global `~/.agents/skills/`; project
`.pi/skills/` and project `.agents/skills/` (trust-gated). In
`agent/skills/`, both root `*.md` files and `*/SKILL.md` directories are
discovered; in `~/.agents/skills/`, only `*/SKILL.md` directories (root `.md`
files are ignored there).

### Frontmatter fields

| Field | Required | Description |
|---|---|---|
| `name` | **Yes** | ≤64 chars, `a-z0-9-`, no leading/trailing or consecutive hyphens. Missing/invalid name emits a warning but does not block loading unless... |
| `description` | **Yes** | ≤1024 chars. Missing description is the one field whose absence blocks the skill from loading. |
| `license` | No | License name or reference to a bundled file. |
| `compatibility` | No | ≤500 chars, environment requirements. |
| `metadata` | No | Arbitrary key-value map. |
| `allowed-tools` | No | Space-delimited pre-approved tools (experimental). |
| `disable-model-invocation` | No | `true` hides the skill from the system prompt; only reachable via `/skill:name`. |

Unknown frontmatter fields are ignored. Name collisions across locations warn
and keep the first skill found.

Local skills live under `agent/skills/` as `*/SKILL.md` directories (freeform
beyond the required `SKILL.md`; `generate-image` ships `generate_image.py`).
`typesafe-ai/SKILL.md` is the vendor TypeSafe skill; local `typesafe-ai/PI.md`
pairs it with the existing Jev extension so in-session Choice/Score/Noul uses
the `jev` tool instead of a second client. `mcp-scripting-recipes` documents native
Pi codemode discovery, bounded composition, and error handling; its upstream
contract is in the installed Pi MCP and CLI docs.

---

## Themes (`agent/themes/*.json`, upstream Pi)

**Authoritative doc:** `node_modules/@earendil-works/pi-coding-agent/docs/themes.md`
— full list of the 51 required color tokens (core UI, backgrounds/content,
markdown, tool diffs, syntax highlighting, thinking-level borders, bash mode)
plus the optional `export` block and 4 supported color-value formats (hex,
256-color index, `vars` reference, `""` for terminal default). Not
reproduced here; read the doc when authoring or editing a theme.

**Location used here:** `agent/themes/apex-dark.json` and
`agent/themes/claude-dark.json`, selected via `agent/settings.json` `"theme"`
(currently `"claude-dark"`). Root shape: `{ "$schema"?, "name",
"vars"?, "colors", "export"? }`. Hot-reloads when the *currently active*
custom theme file is edited.

---

## Extensions (`agent/extensions/*.ts`, upstream Pi)

**Authoritative doc:** `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
— covers the full event lifecycle (`session_start`, `tool_call`,
`before_agent_start`, etc.), `ExtensionAPI`/`ExtensionContext` methods,
custom tools/commands/shortcuts, and extension loading/discovery rules. Not
reproduced here.

**Locations used in this repo:** `agent/extensions/*.ts` (flat files:
`web-search.ts`, `prompt-commands.ts`, `bg-process.ts`,
`crash-logger.ts`, `continual-memory.ts`, `read-guard.ts`,
`at-path-complete.ts`),
`agent/extensions/apex/`, `agent/extensions/task/`,
`agent/extensions/jev/`, and
`agent/extensions/lsp/` (declared directory extensions with private support
directories: Apex UI, task cards/runtime, Jev classifier, and
LSP navigation respectively).
Flat `*.ts` files remain standalone extensions. Todo and edit tools are
Apex-owned under `apex/internal/`. See `CONTEXT.md` for the local architecture
(seams, tool receipts, agent catalog, sync-vs-async task tools, Apex UI
stability rules) — that file documents *how these extensions are built*,
complementary to this file's focus on *config/markdown parameter shapes*.

No project-local `.pi/extensions/` exist in this repo; only global
`agent/extensions/` is used. `agent/settings.json` package-loads `pi-fff`; the
MCP integration is Pi-native (see the mcp.json section above). (`npm:pi-sticky-input` was dropped at Pi 0.84.1 in favor of the built-in
`tuiMode: "fullscreen"`.)

---

## Runtime and generated data

Avoid editing runtime/generated state during ordinary configuration work:
`agent/sessions/`, `agent/run-history.jsonl`, `agent/models-store.json`,
`agent/mcp-cache.json`, `agent/mcp-npx-cache.json`, `agent/trust.json`,
`exa-usage.json`, `.tmp/`, `node_modules/`, and `reference/`. Credential-bearing
active configs such as `agent/auth.json`, `agent/mcp.json`, `agent/models.json`,
and `web-search.json` may be edited intentionally when changing local setup,
but remain gitignored and must never be copied into tracked examples.
