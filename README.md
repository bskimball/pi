# Pi configuration

Personal configuration for [Pi](https://github.com/earendil-works/pi-mono) — a customized coding-agent setup with a fleet of specialist sub-agents, TUI extensions, and slash commands for browser automation and deployment.

Credential-bearing local configuration files (`agent/auth.json`, `agent/models.json`, `agent/mcp.json`, `web-search.json`, plus any `.env`/`.env.*`) are excluded by `.gitignore`. Three of them — `agent/models.json`, `agent/mcp.json`, and `web-search.json` — have a tracked `*.example.json` minimal template with environment-variable references instead of real secrets; `agent/auth.json` and any `.env` files have no example and are populated by `/login` or your own shell environment. See [CONFIGURATION.md](CONFIGURATION.md) for the local parameter reference and links to authoritative upstream Pi documentation, and [CONTEXT.md](CONTEXT.md) for the local extension architecture (seams, standalone rule, presentation ownership, agent catalog, sync-vs-async task internals). [AGENTS.md](AGENTS.md) is the canonical description of this architecture for the agent itself; this file exists for a human reading the repo.

## Overview

This repo layers several things on top of a stock Pi install:

- **A `task` tool, persistent async `task_*` tools, and a roster of specialist sub-agents** (`agent/agents/`) whose prompts are adapted from [Amp](https://ampcode.com/)'s published agent and sub-agent prompts, with additional custom agents added.
- **Extensions** (`agent/extensions/`) — task/orchestration tooling, an "Apex" TUI presentation layer, background-process and PowerShell tools, web search, a local MCP adapter, a knowledge-graph query tool, crash logging, and a few small guards.
- **Slash commands and prompt templates** — native `/orchestrate` switches the lead into sticky, delegation-only mode; `/browser` and `/deploy` handle browser automation and full-worktree shipping; `/graphify` hands off to the graphify skill; simpler Markdown templates such as `/brainstorm` live in `agent/prompts/`.
- **Skills** (`agent/skills/`) for browser automation, background processes, image generation, graphify, architecture review, and MCP scripting.
- **A theme** (`agent/themes/apex-dark.json`) selected via `agent/settings.json`.
- **Tracked `*.example.json` minimal templates** for the three gitignored configs that have one — see [Example and template files](#example-and-template-files).

## Sub-agents and Orchestration Tools

Pi's main agent delegates bounded units of work to specialist sub-agents through synchronous and asynchronous task tools:

- **`task`** — synchronous task delegation: spawns a specialist sub-agent, streams activity back into the parent session, and blocks until returning a single final report.
- **`task_start` / `task_status` / `task_list` / `task_send` / `task_wait` / `task_collect` / `task_abort` / `task_close` / `task_reply`** — asynchronous RPC sub-agent management: starts persistent isolated sessions in the background, steers or sends follow-ups mid-flight, handles UI extension requests, and retrieves or waits for results while keeping the lead context free.
- **`task_chain` / `mission`** — one-shot sequential and DAG-aware schedulers. `mission` starts ready nodes concurrently, substitutes bounded dependency reports through `{{nodeId}}`, skips failed dependency branches, closes every node worker, and returns wall-clock/worker-time/slot-utilization telemetry.

Each task spawns a separate `pi` process with the specialist's own system prompt, model, thinking level, and tool set.

Use synchronous `task` for one-shot barriers whose report is needed before proceeding. Reserve `task_start` for persistent work that benefits from steering, follow-up generations, or overlap with useful lead work. The async lifecycle is: `task_start` → optional `task_send` → `task_wait` while follow-up remains likely, or **`task_collect` for the final wait + report + close**. `task_wait` timeouts and Esc interruptions detach only the waiter. Worker handles are runtime-local; after a process restart use `task_rebind` before assuming a historical `task_N` is valid. `task_reply` answers a worker's interactive UI dialog request.

Both synchronous and asynchronous tasks use the agent's ordered model fallback chain for clean availability failures. The bounded subprocess cap defaults to 3 and can be configured installation-wide with `PI_TASK_MAX_WORKERS=1..8`; the same value governs synchronous fan-out, async live workers, and mission concurrency.

`task_send` has two delivery modes with different queueing semantics:

- **`steer`** — queued at the next **model-call boundary**: it cannot interrupt inference or an in-flight tool call, and is delivered after the current assistant turn finishes its tool calls, just before the next LLM call.
- **`follow_up`** — delivered only after the worker fully **settles** (no more tool calls or pending steering).

A `prompt`-mode send is only allowed once a worker is settled or failed; use `steer`/`follow_up` while it's still running. Live `task_start` / `task_chain` workers also appear as the Agents tab on the above-editor todo dock (`alt+a` / `/agents`); see [CONTEXT.md § Todo dock](CONTEXT.md#todo-dock).

The task tool and the sub-agent prompts are **based on Amp's prompts and sub-agents**. Amp ships a small set of built-in sub-agents (an orchestrator, a search/oracle reviewer, a librarian, and fast workers); the reference prompts live under `reference/amp-prompts/` and are used as behavioral and structural templates. On top of that foundation this configuration adds a broader roster of purpose-built specialists:

| Agent | Role |
| --- | --- |
| `advisor` | Strategic planner consulted before consequential approaches, when stuck, or when changing direction. Advisory only. |
| `artisan` | Bold visual-design and frontend specialist for substantial UI implementation, design judgment, exploratory refinement, diagrams, slides, and data visualization. |
| `inspector` | Fast, cheap read-only verifier for bounded live-browser interaction, responsive checks, console/network evidence, screenshots, and focused visual regression analysis after implementation. |
| `librarian` | Remote source-code researcher for external libraries, framework internals, and cross-repository investigation. |
| `machinist` | Workhorse coding specialist for large implementation chunks, backend logic, refactors, migrations, bug fixes, and tests. |
| `oracle` | Deep independent reviewer of actual code and diffs, plus debugger for difficult bugs, conflicting evidence, and high-stakes decisions. |
| `picasso` | Image-generation specialist for concept art, UI renderings, illustrations, icons, logos, textures, and diagrams. |
| `scout` | Fast, cheap local codebase reconnaissance for broad scans, architecture mapping, and context gathering. |
| `scribe` | Editorial writing specialist for blog posts, articles, documentation, launch copy, and long-form prose. |
| `stevedore` | Fast ops specialist for deploys and CLI chores: lint, format, build, git, and platform CLIs. |
| `verifier` | Fast read-only integrated checker for lint, format checks, typecheck, tests, and builds after writers settle. |

Shared norms that apply to every specialist (smallest-correct-change discipline, browser rules, evidence, dirty-worktree safety, etc.) live in [`agent/agents/_shared.md`](agent/agents/_shared.md). Worker-mode semantics are separate: `_shared-sync.md` describes fire-and-forget `task` runs, while `_shared-async.md` describes persistent RPC workers with steering, follow-ups, and UI requests. [`agent/agents/_handoff.md`](agent/agents/_handoff.md) is appended for both modes and requires a non-empty visible final report for each generation. Each agent file also declares its primary model plus a fallback chain. Both task modes retry only clean provider/model availability failures; async workers replace the failed RPC session and replay only before visible output or tool execution, preventing duplicate work.

## Extensions

Custom TUI and orchestration extensions live in `agent/extensions/`. Pi discovers an extension two ways: a bare `*.ts` file directly in `agent/extensions/`, or a directory whose `package.json` declares `pi.extensions`. Everything else under a directory — `internal/`, `runtime/`, `presentation/`, `observatory/`, `test/` — is private support code, never loaded as a second extension.

```text
agent/extensions/
├── apex/            → apex-ui.ts          UI layer (Observatory, tool receipts, edit, todo)
├── task/            → amp-task.ts, async-task.ts   sync `task` + async task_* RPC workers
├── lsp/             → index.ts            language-server navigation
├── bg-process.ts    + bg-process/         bg_start/status/list/kill
├── powershell.ts    + powershell/         direct PowerShell child process
├── crash-logger.ts  + crash-logger/       crash/lifecycle logs, terminal restore, segmenter shield
├── continual-memory.ts + continual-memory/  memory_list / memory_write
├── prompt-commands.ts + prompt-commands/  /browser, /deploy, /orchestrate
├── graphify.ts                            local knowledge-graph query + /graphify handoff
├── mcp-adapter.ts                         pi-mcp-adapter bridge (stock MCP rendering)
├── read-guard.ts                          duplicate-image + downscale guard
├── user-profile.ts                        private user context injection
├── web-search.ts                          Exa search + fetch_content
├── at-path-complete.ts                    scoped @ listing for gitignored paths
└── test/                                  cross-extension tests
```

`apex/package.json`, `task/package.json`, and `lsp/package.json` each declare their entry points (`apex-ui.ts`; `amp-task.ts` + `async-task.ts`; `index.ts`).

This is enforced structurally, not just by convention: every extension's import closure must stay inside its own directory (Node built-ins, Pi's public packages, and declared dependencies are the only exceptions). There is **no `extensions/shared/`** — small helpers that look shareable (width-safe text layout, terminal-restore, process-tree-kill, agent discovery, segmenter safety, and similar) are duplicated per owner on purpose, because deleting an extension directory plus its entry file must remove the feature cleanly with no dangling imports elsewhere.

### Apex is the UI

`apex/` is the only general custom-presentation extension. Every other extension is headless (Pi's stock tool renderer) or renders a small amount of its own chrome.

```text
apex/apex-ui.ts
├── builtin-tools.ts
├── internal/edit/               unified edit tool + row edit planner
├── internal/todo/               todo_write / todo_read + docked todos/agents panel
├── internal/presentation/       receipts, diffs, headless-tool wraps, the PI_APEX_UI=0 gate
├── internal/runtime/            segmenter shield, last-phase, terminal-restore, agent discovery
└── observatory/                 blank-chat landing screen (see below)
```

Apex owns the Observatory startup header, styled receipts for the builtin `read`/`bash`/`edit`/`write` tools, the session todo dock (`todo_write`/`todo_read`, plus live async workers as an Agents tab), the unified edit tool, and receipt chrome for the otherwise-headless `graphify`, `web_search`, `fetch_content`, `get_search_content`, `bg_start`, `bg_status`, `bg_list`, and `bg_kill` tools. Settlement of a background job is shown as an Apex notice (`bg-process-settled`) rather than a raw custom-type block. `todo_write` replaces the whole list on each call and allows at most one `in_progress` item; the tools are lead-only. `PI_APEX_UI=0` is the installation-wide presentation opt-out: Apex-owned tools stay registered and executable, but custom chrome, receipts, and render hooks are stripped in favor of Pi's stock boxed renderer. The one exception is the todo dock, which stays mounted but switches to a plain, uncolored list with no Agents tab.

`task/` renders its own delegated-worker activity cards through a separate gate, `withTaskPresentation()`: `PI_TASK_UI=0` disables task cards alone, and `PI_APEX_UI=0` disables them too. Child workers are always spawned with `PI_APEX_UI=0` so they never paint their own chrome.

Headless extensions own execute only: `bg-process`, `powershell`, `mcp-adapter`, `web-search`, `continual-memory`, `read-guard`, `lsp`, `graphify`. Apex attaches receipt/notice chrome on top unless `PI_APEX_UI=0`.

There is no custom footer — Pi owns it. `prompt-commands` and `graphify` publish status text into it via `ctx.ui.setStatus(...)`.

### Extension notes

- **`task/amp-task.ts` & `task/async-task.ts`** — implements `task`, persistent async RPC tools including `task_collect`, and the `task_chain` / `mission` schedulers; see [Sub-agents and Orchestration Tools](#sub-agents-and-orchestration-tools) above. The deep async control plane lives in `task/runtime/worker-runtime.ts`; `async-task.ts` retains RPC transport and Pi tool adapters.
- **`apex/apex-ui.ts`** — see [Apex is the UI](#apex-is-the-ui) and [The shark / Observatory](#the-shark--observatory).
- **`bg-process.ts`** — `bg_start`/`bg_status`/`bg_list`/`bg_kill` for dev servers and watchers; support code in `bg-process/internal/`.
- **`powershell.ts`** — a direct `pwsh`/`powershell` child process tool, independent of the host shell; stock renderer; support code in `powershell/internal/`.
- **`crash-logger.ts`** — records fatal JS/stream errors and nonzero exits to `agent/logs/pi-crash.log`, and session/compaction lifecycle boundaries to `agent/logs/pi-lifecycle.log`; loads at module scope before the first paint, independent of `PI_APEX_UI`. See [Crash and stability](#crash-and-stability) below.
- **`continual-memory.ts`** — `memory_list`/`memory_write`; small evidence-backed durable notes outside the chat transcript. Kinds: `memory` (facts/preferences/failures) and `prompt` (narrow policy addendums only). Default write scope is global; local is this-session scratch. Global entries live under `agent/harness/global.json` (gitignored).
- **`prompt-commands.ts`** — registers `/browser`, `/deploy`, and `/orchestrate` directly via `pi.registerCommand()`. See [Slash commands](#slash-commands). `/todos` and `/agents` are registered by Apex (`todo-tools.ts`), not here.
- **`graphify.ts`** — see [Graphify](#graphify) below.
- **`mcp-adapter.ts`** — standalone bridge that boots the root `pi-mcp-adapter` dependency on this `ExtensionAPI`. MCP tools use Pi's stock renderer. Do not also add `pi-mcp-adapter` to `agent/settings.json` `packages`; a second package-loaded copy would initialize a duplicate MCP extension.
- **`read-guard.ts`** — blocks a repeated `read` of the same image path when mtime/size are unchanged; downscales image blocks in any tool result to a 1568px long edge; gives an advisory nudge on very large bash output. No text re-read guard.
- **`user-profile.ts`** — injects `agent/USER_PROFILE.local.md` (gitignored, capped at 8,000 characters) into the system prompt via `before_agent_start`, if the file exists.
- **`at-path-complete.ts`** — scoped `@dir/` autocomplete overlay that lists on-disk children, including gitignored folders such as `files/`. Bare `@foo` stays with FFF/stock fuzzy search.
- **`web-search.ts`** — native Exa web search and page fetching (`web_search`, `fetch_content`, `get_search_content`) with caching and domain filtering.
- **`lsp/`** — see [LSP](#lsp) below.

No extensions are currently loaded as npm packages; `agent/settings.json` `packages` is empty. The `pi-mcp-adapter` dependency is composed locally via `mcp-adapter.ts` instead of package-loaded. (`pi-sticky-input` was dropped at Pi 0.84.1 in favor of the built-in `tuiMode: "fullscreen"`.)

### Graphify

`graphify.ts` registers a headless LLM tool, `graphify`, that only queries an existing local knowledge graph (`query`/`path`/`explain` — it never builds or mutates one) and requires artifacts to already exist under `graphify-out` (or a configured `outputDir`). The `/graphify` slash command (including `/graphify build`) is a handoff: it tells the agent to load and follow `agent/skills/graphify/SKILL.md`, whose full build/update pipeline runs the upstream CLI as `graphify .` — never as `graphify build`.

### LSP

A single on-demand `lsp` tool for semantic navigation (`definition`, `references`, `hover`, `document_symbols`, `workspace_symbols`, `diagnostics`, `read_symbol`), backed by language servers already on `PATH` (TypeScript/JavaScript, Python, Go, PHP). It never installs servers and runs no always-on analysis; servers spawn per session and are disposed on `session_shutdown`. Bare commands resolve on `PATH` only, never from the project directory, so an untrusted repo can't inject a binary. Optional config at `agent/lsp.json` or a trusted `.pi/lsp.json`.

### Crash and stability

`crash-logger.ts` installs the segmenter shield (defends against a native ICU grapheme-segmentation crash on Windows), last-phase breadcrumbs per pid, and a terminal-restore watchdog for unclean session deaths, independent of `PI_APEX_UI`. Logs: `agent/logs/pi-crash.log`, `agent/logs/pi-lifecycle.log`, `agent/logs/pi-render.log`. See [CONTEXT.md](CONTEXT.md#long-session-and-subagent-stability) and [AGENTS.md](AGENTS.md#crash-and-stability-diagnostics) for the full mechanism; this README does not reproduce it.

## Slash commands

`/browser`, `/deploy`, and `/orchestrate` are native commands registered in code by `agent/extensions/prompt-commands.ts` (`pi.registerCommand()`), because they need executable pre-steps — a deterministic browser-connect step, a git worktree snapshot, and sticky session-mode switching, respectively — that plain prompt-template expansion can't do. `/graphify` is registered the same way, by `graphify.ts`. `/observatory` is registered by `apex/apex-ui.ts` (also bound to `alt+o`) and opens the Observatory portal in the interactive TUI. `/todos` (`alt+t`) and `/agents` (`alt+a`) are registered by `apex/internal/todo/todo-tools.ts` and collapse or switch the above-editor todo dock; see [CONTEXT.md § Todo dock](CONTEXT.md#todo-dock).

Simpler prompt templates live under `agent/prompts/*.md` (e.g. [`/brainstorm`](agent/prompts/brainstorm.md)); see [CONFIGURATION.md](CONFIGURATION.md#prompt-template-markdown-agentpromptsmd-upstream-pi) for the template frontmatter/argument format.

`agent/prompts/inactive/` keeps the original Markdown-template versions of [`browser.md`](agent/prompts/inactive/browser.md) and [`deploy.md`](agent/prompts/inactive/deploy.md) for reference; they are not discovered as commands (non-recursive prompt-template discovery skips the `inactive/` subdirectory) and are superseded by the native implementations above.

### `/orchestrate`

Switches the current session between the default inline-capable lead and a **strict orchestrator** that delegates all detailed work to sub-agents. With orchestration on, the lead still decomposes the request, writes work orders, integrates results, verifies the outcome, and answers the user, but it does not edit files or perform broad implementation work itself.

```text
/orchestrate on       # enable strict delegation
/orchestrate off      # restore the normal inline allowance
/orchestrate          # toggle the current mode
```

Strict mode routes implementation to Machinist or Artisan, broad discovery to Scout, and routine post-implementation browser verification to Inspector. It also requires fresh-eyes review and applies the normal delivery gates without inline exemptions. The mode persists when the session resumes and displays `orchestrator` in the footer while active.

### `/browser`

Attaches to a **dedicated authenticated debug Chrome** and co-browses with you. Chrome's daily-profile remote debugging shows an **Allow** dialog on every new client; this command sidesteps that by using a separate profile with classic CDP on port **29300**:

```text
chrome --remote-debugging-port=29300 --user-data-dir=~/.pi/browser/chrome-profile
```

Google/Microsoft logins persist in this dedicated profile after a one-time sign-in. A deterministic pre-step runs `agent/bin/browser-connect.mjs connect` to idempotently attach, then the agent uses `agent-browser --cdp 29300` (snapshot/click/fill/batch) to drive the page. It never launches a ghost browser and never touches the daily Chrome profile.

```
/browser https://mail.google.com
/browser check staging dashboard
```

### `/deploy`

Delegates lint, format, verify, and deploy to the `stevedore` sub-agent instead of running the deploy inline. A deterministic pre-step captures the git worktree, branch, HEAD, and a dirty-file inventory, then the main agent hands `stevedore` a complete self-contained brief:

- Work only inside the resolved absolute worktree path.
- Discover and run the project's own lint/format/typecheck/test/build/deploy scripts.
- Treat the full dirty tree as the release contents (no partial subsets), excluding only true noise/secrets/generated artifacts.
- Deploy to the stated target, verify, and report back with final `git status`.

```
/deploy staging
/deploy wrangler, skip tests
```

## Skills

Skills live in `agent/skills/` and are freeform directories beyond the required `SKILL.md`. `agent/settings.json` also adds `../node_modules/pi-mcp-adapter/skills` to `skills`, which brings in the upstream `mcp-scripting` skill.

- [`agent-browser/SKILL.md`](agent/skills/agent-browser/SKILL.md) — browser automation through the dedicated debug Chrome on CDP port 29300; the same pathway `/browser` uses.
- [`background-process/SKILL.md`](agent/skills/background-process/SKILL.md) — the `bg_*` tools (from `bg-process.ts`) for long-running commands like dev servers and watchers.
- [`generate-image/SKILL.md`](agent/skills/generate-image/SKILL.md) — image generation via a bundled helper script, [`generate_image.py`](agent/skills/generate-image/generate_image.py), with an automatic model fallback chain.
- [`graphify/SKILL.md`](agent/skills/graphify/SKILL.md) — the full graphify build/update CLI pipeline (`graphify .` and friends); see [Graphify](#graphify) above for the query-only tool and `/graphify` handoff.
- [`improve-codebase-architecture/SKILL.md`](agent/skills/improve-codebase-architecture/SKILL.md) — scans for deepening opportunities and works through them interactively; `disable-model-invocation: true`, so it's invoked explicitly rather than picked automatically.
- [`mcp-scripting-recipes/SKILL.md`](agent/skills/mcp-scripting-recipes/SKILL.md) — local composition recipes (discovery-first resolution, bounded fan-out, partial failures, timeout budgeting) layered on top of the upstream `mcp-scripting` skill's API contract.

## Theme

`agent/themes/apex-dark.json` is a custom dark theme selected via `agent/settings.json` (`"theme": "apex-dark"`) and hot-reloads when edited while active. See [CONFIGURATION.md](CONFIGURATION.md#themes-agentthemesjson-upstream-pi) for the tracked field/format reference.

## The shark / Observatory

The configuration has one visual identity — a shark in deep space — used as the Observatory landing mark on a fresh chat, not as a live animation during work. Observatory is a blank-chat landing screen mounted by `apex/apex-ui.ts` as Pi's startup header (`ctx.ui.setHeader(...)`), not an above-editor widget, so with `quietStartup` it's the opening screen.

```text
agent/extensions/apex/observatory/
├── observatory.ts        composition, inventory, glyph shark tiers, selectors
├── observatory-orb.ts    focus/selection state
├── shark-art.ts          generated truecolor pixel bitmaps (ULTRA / WIDE / MID)
├── pixel-art.ts          half-block pixel renderer + truecolor detection
├── star-field.ts         background star rows
├── preview.mjs           full-screen harness
└── sky-preview.mjs       star-field-only harness
```

The mark itself is **drawn, not photographed**: `tools/shark-art/encode-shark.py` renders a parametric side profile (smooth body curves plus straight-edged fin polygons) into truecolor half-block cells, where each glyph carries two rows of pixels. The generated TypeScript lives at `agent/extensions/apex/observatory/shark-art.ts` — regenerate it via `tools/shark-art/`, never hand-edit that file. (`tools/shark-art/emit-ts.py` still writes the old `apex/lib/` path; that generator is stale.) `pixel-art.ts` decodes the shared cell format and gates on truecolor, falling back to glyph art elsewhere.

Two facts ride on the mark: the Observatory splash (`observatory.ts`) shows the full mark on a fresh chat only; the star field (`star-field.ts`) encodes the *shape* from the workspace path (so every project has its own constellation, stable across launches) and the *density* from context usage (stars burn out faintest-first as the window fills).

Preview harness — do not iterate on this surface through screenshots:

```
node --experimental-transform-types agent/extensions/apex/observatory/preview.mjs
node --experimental-transform-types agent/extensions/apex/observatory/preview.mjs 80
node --experimental-transform-types agent/extensions/apex/observatory/sky-preview.mjs
```

Compaction uses Pi's built-in spinner only. Live async workers show through the normal task status cards and `task_*` tools. Apex keeps no extension-owned animation clocks for either surface.

## Example and template files

Three of the gitignored, credential-bearing configs have a tracked example sibling — a **minimal supported template**, not a full mirror of the active file's shape, with placeholder/env-only values safe to read or copy:

| Active (gitignored) | Example (tracked) |
| --- | --- |
| `agent/mcp.json` | [`agent/mcp.example.json`](agent/mcp.example.json) |
| `agent/models.json` | [`agent/models.example.json`](agent/models.example.json) |
| `web-search.json` | [`web-search.example.json`](web-search.example.json) |

`agent/auth.json` has no example — it is populated by Pi's `/login` command, not copied.

Copying an example is a starting point, not a drop-in config: placeholders need real values, and the shapes are illustrative rather than exhaustive. `agent/mcp.example.json`'s server entry is a sample server, not a required one — replace or remove it for your own MCP servers. `agent/models.example.json`'s provider/model IDs are placeholders; if you copy it as-is, also check that `agent/settings.json`'s `defaultProvider`/`defaultModel` still name a provider and model that actually exist in your `models.json`. See [CONFIGURATION.md](CONFIGURATION.md) for field-by-field documentation of each format, and [Restore on a new machine](#restore-on-a-new-machine) below for how to turn an example into an active config.

## Restore on a new machine

1. Clone this repository as `~/.pi`.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Restore the ignored local configuration files from their tracked examples (see [CONFIGURATION.md](CONFIGURATION.md) for field details):

   ```bash
   cp agent/models.example.json agent/models.json
   cp agent/mcp.example.json agent/mcp.json
   cp web-search.example.json web-search.json
   ```

   Prefer leaving `$LOCAL_PROXY_API_KEY` and `$EXA_API_KEY` references in place and defining those environment variables. For MCP, `bearerTokenEnv` contains an environment-variable **name**: define `EXAMPLE_MCP_TOKEN`, or rename the field value and define the renamed variable. Do not paste a token into `bearerTokenEnv`. Literal secrets are supported by some formats but are discouraged.

   If `PI_CODING_AGENT_DIR` is set, `web-search.ts` reads `web-search.json` from that exact directory instead of the repo root; copy the example there.
4. Sign in to OAuth-backed providers again with Pi's `/login` command. `agent/auth.json` is intentionally ignored.
5. `agent/models.json` reloads automatically when `/model` is opened. The Exa credential config is re-read on each `web_search` call. `agent/mcp.json` changes apply on the next session start or `/reload` — restart Pi (or `/reload`) after changing it.

Before committing, review the staged files and run a secret scanner such as Gitleaks:

```bash
git diff --cached
gitleaks git --staged
```
