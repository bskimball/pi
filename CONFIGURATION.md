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

Installed package version: `@earendil-works/pi-coding-agent@0.84.1` (see
`package.json`). Upstream docs can drift between versions; when in doubt, read
`node_modules/@earendil-works/pi-coding-agent/docs/*.md` directly.

## Contents

- [Ignored secret configs and their example files](#ignored-secret-configs-and-their-example-files)
- [`agent/mcp.json` (local custom, MCP servers)](#agentmcpjson-local-custom-mcp-servers)
- [`agent/models.json` (upstream Pi, custom providers/models)](#agentmodelsjson-upstream-pi-custom-providersmodels)
- [`web-search.json` (local custom, web-search extension)](#web-searchjson-local-custom-web-search-extension)
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

## `agent/mcp.json` (local custom, MCP servers)

**Loaded by:** `agent/extensions/mcp-adapter.ts`, which wraps the
`pi-mcp-adapter` npm package (`node_modules/pi-mcp-adapter`) on the same
`ExtensionAPI` as Apex's MCP presentation layer. Do not also add
`pi-mcp-adapter` to `agent/settings.json` `packages` — that would load a second,
unwrapped instance and bypass Apex's receipts.

Because the adapter is composed directly rather than loaded as a package, Pi
does not auto-discover its bundled skill directory. Register it explicitly via
`agent/settings.json` `skills` (this repo uses
`../node_modules/pi-mcp-adapter/skills`, resolved relative to `agent/`). That
exposes the authoritative `mcp-scripting` skill without installing a second
adapter instance through `packages`.

**Location:** `<Pi agent dir>/mcp.json` (`agent/mcp.json` here). This is one of
several files `pi-mcp-adapter` merges; see the package's own file-precedence
table in `node_modules/pi-mcp-adapter/README.md#file-layout` for the full list
(`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `.mcp.json`,
`.pi/mcp.json`, etc.). This repo only tracks `agent/mcp.json`.

**Reload behavior:** `/mcp disable|enable <server>` requires `/reload` to take
effect. Editing the file directly is picked up per the adapter's normal config
load/merge cycle (on session start / reload); it is not hot-reloaded mid-session
like `models.json`.

### Root shape

```jsonc
{
  "mcpServers": { "<name>": { /* ServerEntry */ } },
  "imports": ["cursor", "claude-code"],
  "settings": { /* McpSettings, optional */ }
}
```

`imports` is optional and may contain `"cursor"`, `"claude-code"`,
`"claude-desktop"`, `"codex"`, `"opencode"`, `"windsurf"`, or `"vscode"`.
It imports MCP definitions discovered from those hosts; see the adapter README
for discovery and merge precedence.

Full type definitions: `node_modules/pi-mcp-adapter/types.ts`
(`ServerEntry`, `McpSettings`, `McpConfig`). Full field docs with resolution
semantics: `node_modules/pi-mcp-adapter/README.md` ("Server Options" and
"Settings" sections).

### `mcpServers.<name>` (ServerEntry) — common fields

| Field | Type | Notes |
|---|---|---|
| `command` | string | Stdio transport executable. Mutually exclusive with `url`/`socket`. |
| `args` | string[] | Command arguments. |
| `env` | object | Env vars for the stdio process. Supports `${VAR}`/`$env:VAR` interpolation; a value starting with `!` runs a command at connect time (`!!` escapes a literal `!`). **Secret-bearing.** |
| `cwd` | string | Working directory; supports `~` and env expansion. |
| `url` | string | HTTP endpoint (StreamableHTTP w/ SSE fallback). Mutually exclusive with `command`/`socket`. |
| `socket` | string | Explicit `rmcp-mux` Unix socket path. Mutually exclusive with `command`/`url`. |
| `headers` | object | HTTP headers; same interpolation/`!command` rules as `env`. **Secret-bearing.** |
| `auth` | `"oauth" \| "bearer" \| false` | Auth mode for HTTP servers. |
| `bearerToken` / `bearerTokenEnv` | string | Static token or env var name. `bearerToken` supports interpolation and `!command`. **Secret-bearing.** |
| `oauth` | object \| `false` | `{ grantType, clientId, clientSecret, scope, redirectUri, clientName, clientUri }`. `clientSecret` is secret-bearing and supports `!command`. |
| `lifecycle` | `"lazy" \| "eager" \| "keep-alive" \| "lazy-keep-alive"` | Default `"lazy"`. See adapter README for exact semantics. |
| `idleTimeout` | number (minutes) | Overrides global `settings.idleTimeout`. |
| `requestTimeoutMs` | number | Overrides global `settings.requestTimeoutMs`; omitted/`<=0` uses the MCP SDK default. |
| `exposeResources` | boolean | Default `true`. |
| `directTools` | boolean \| string[] | Register tools individually instead of through the `mcp` proxy tool. |
| `includeTools` / `excludeTools` | string[] | Glob-capable allow/deny lists (exclude applied after include). |
| `debug` | boolean | Show server stderr. Default `false`. |
| `trace` | boolean | Metadata-only JSONL protocol tracing for this server. Never persists payloads/prompts/args/results/auth/URLs. |
| `disabled` | boolean | Only literal `true` disables a server; keeps it visible in config/status. |

### `settings` (McpSettings) — common fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `toolPrefix` | `"server" \| "short" \| "none" \| "mcp"` | `"server"` | Tool name prefixing scheme. |
| `idleTimeout` | number (minutes) | `10` | `0` disables. |
| `requestTimeoutMs` | number | SDK default | Global request timeout. |
| `showStatusIcon` | boolean | `true` | Plug icon in `/mcp` status text. |
| `hostConfigDiscovery` | `"off" \| "prompt" \| "on"` | `"off"` | Whether to discover other hosts' MCP configs. |
| `directTools` | boolean | `false` | Global default; per-server overrides. |
| `disableProxyTool` | boolean | `false` | Hide the `mcp` proxy tool once direct tools cover everything. |
| `autoAuth` | boolean | `false` | Auto-run OAuth on connect/tool call when a server needs auth. |
| `sampling` / `samplingAutoApprove` | boolean | `true` / `false` | MCP server sampling through Pi models. |
| `elicitation` | boolean | `true` (when UI available) | Allow servers to request user input. |
| `outputGuard` | boolean \| object | `true` | Caps inline text output (50 KiB/2000 lines) and `details.mcpResult` (16 KiB); see adapter README "Output Guard". |
| `trace` | object | — | `{ enabled, file, maxBytes, maxEvents }`. Opt-in metadata-only tracing. |
| `authRequiredMessage` | string | — | `${server}` is substituted. |
| `oauthDir` | string | — | Legacy plaintext `tokens.json` import dir only; persistent OAuth creds live in the OS credential store, not here. |

### Env / secret resolution

- `env`, `headers`, `bearerToken`, `oauth.clientSecret` values support
  `${VAR}` / `$env:VAR` interpolation, and a leading `!command` executes a
  command (stdin/stderr suppressed, 1 MiB stdout cap, 10s timeout,
  non-empty output required) to obtain the value at connect/auth time. Use
  `!!` to escape a literal leading `!`.
- OAuth tokens are stored in the OS credential store, not in this file or
  `oauthDir`.
- This repo's active `agent/mcp.json` currently defines a plain-text
  `CONTEXT7_API_KEY` header value rather than an env-var reference — that is
  why the file is gitignored. Do not "fix" this by editing the active file as
  part of documentation work; only the example file should model the safer
  `env`/`bearerTokenEnv` pattern.

### Example (`agent/mcp.example.json`)

Includes one stdio server (`chrome-devtools`, no secrets) and one HTTP server
using `bearerTokenEnv` instead of an inline header value, plus a minimal
`settings` block. The `chrome-devtools-mcp` package is pinned to a tested
version because `npx -y` downloads and executes that package when it is not
already cached. Review and update the pin deliberately.

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
(`grok-4.5`, provider-local id), `defaultProvider` (`local-proxy`),
`defaultThinkingLevel`, `lastChangelogVersion`, `packages` (empty — the
third-party MCP dependency used here is composed locally by `mcp-adapter.ts`
instead of loaded from this array; see the mcp.json section above for why),
`skills` (registers the `pi-mcp-adapter` bundled skill directory so
`mcp-scripting` is discoverable without loading the adapter twice),
`steeringMode`, `transport`, `terminal.showTerminalProgress`, `editorPaddingX`,
`theme`, `tuiMode`, and `enabledModels` (keeps `local-proxy/*` plus
`openai-codex/*`, `xai/*`, and other providers for optional manual selection).

Active default and subagent routes use `local-proxy` (for example
`local-proxy/gpt-5.6-luna`, `local-proxy/gpt-5.6-sol`, `local-proxy/grok-4.5`,
`local-proxy/claude-opus-5`, plus Cloudflare Workers AI fallbacks). Direct
`openai-codex/*` and `xai/*` provider routes remain enabled for manual
selection but are not the active default or agent frontmatter path.

---

## Agent markdown (`agent/agents/*.md`, local custom)

**Not an upstream Pi format.** Parsed entirely by this repo's
`agent/extensions/apex/lib/agent-discovery.ts` (`parseAgentFile`), consumed by
`apex/amp-task.ts` (sync `task` tool) and `apex/async-task.ts` (async
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
| `tools` | No | string | **Comma-separated string**, not a YAML list, e.g. `read, grep, find, ls, bash, edit, write, task`. |
| `maxTurns` | No | number | Parsed with `Number(...)`; invalid values become `undefined`. |
| `timeoutSec` | No | number | Same parsing behavior as `maxTurns`. |
| `inheritSkills` | No | boolean | Defaults to `true`; only the literal string `"false"` in frontmatter disables it (passes `--no-skills` to the child). |

Body (everything after the closing `---`) is the agent's system prompt,
trimmed of leading/trailing whitespace.

### List field syntax (`fallbackModels`)

Either form works:

```yaml
fallbackModels:
  - local-proxy/gpt-5.6-sol
  - 'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code'
```

```yaml
fallbackModels: [local-proxy/gpt-5.6-sol, cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code]
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
has one prompt template, `agent/prompts/brainstorm.md`
(`argument-hint: "[topic]"`, uses `${@:-the current task}`); `/browser` and
`/deploy` are **not** prompt templates — they are native commands registered
in code by `agent/extensions/prompt-commands.ts` via `pi.registerCommand()`
because they need executable pre-steps (git snapshotting, a deterministic
browser-connect step) that plain template expansion can't do. `/orchestrate`
is likewise native: it is a sticky per-turn system-prompt mode toggle
(`before_agent_start` + persisted custom entry), not a one-shot template. The previous
README wording implying `/browser`/`/deploy` are "registered in
`agent/settings.json` and defined under `agent/prompts/`" was inaccurate and
has been corrected (see README changes).

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

This repo has three local skills under `agent/skills/`:
`background-process/SKILL.md`, `generate-image/SKILL.md` (the latter ships a
helper script, `generate_image.py`, alongside `SKILL.md` — skills are freeform
directories beyond the required `SKILL.md`), and
`mcp-scripting-recipes/SKILL.md` (server-agnostic local recipes that complement
the adapter's authoritative `mcp-scripting` skill). The adapter skill itself is
loaded via `settings.skills`, not by copying it into `agent/skills/`.

---

## Themes (`agent/themes/*.json`, upstream Pi)

**Authoritative doc:** `node_modules/@earendil-works/pi-coding-agent/docs/themes.md`
— full list of the 51 required color tokens (core UI, backgrounds/content,
markdown, tool diffs, syntax highlighting, thinking-level borders, bash mode)
plus the optional `export` block and 4 supported color-value formats (hex,
256-color index, `vars` reference, `""` for terminal default). Not
reproduced here; read the doc when authoring or editing a theme.

**Location used here:** `agent/themes/apex-dark.json`, selected via
`agent/settings.json` `"theme": "apex-dark"`. Root shape: `{ "$schema"?, "name",
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
`mcp-adapter.ts`, `web-search.ts`, `prompt-commands.ts`, `bg-process.ts`,
`crash-logger.ts`, `todo-list.ts`, `continual-memory.ts`, `read-guard.ts`),
`agent/extensions/lsp/` and `agent/extensions/apex/` (directory-style
extensions: `apex-ui.ts`, `amp-task.ts`, `async-task.ts` plus a shared `lib/`
of helper modules that are imported directly rather than loaded as separate
extensions). See `CONTEXT.md` for the local architecture (seams, tool
receipts, agent catalog, sync-vs-async task tools, Apex UI stability rules) —
that file documents *how these extensions are built*, complementary to this
file's focus on *config/markdown parameter shapes*.

No project-local `.pi/extensions/` exist in this repo; only global
`agent/extensions/` is used. `agent/settings.json` `packages` is empty — the
third-party MCP dependency used here is composed locally instead:
`mcp-adapter.ts` boots `pi-mcp-adapter` (see the mcp.json section above for
why). (`npm:pi-sticky-input` was dropped at Pi 0.84.1 in favor of the built-in
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
