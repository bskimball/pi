# Pi configuration

Personal configuration for [Pi](https://github.com/earendil-works/pi-mono) — a customized coding-agent setup with a fleet of specialist sub-agents, TUI extensions, and slash commands for browser automation and deployment.

Credential-bearing local configuration files (`agent/auth.json`, `agent/models.json`, `agent/mcp.json`, `web-search.json`, plus any `.env`/`.env.*`) are excluded by `.gitignore`. Three of them — `agent/models.json`, `agent/mcp.json`, and `web-search.json` — have a tracked `*.example.json` minimal template with environment-variable references instead of real secrets; `agent/auth.json` and any `.env` files have no example and are populated by `/login` or your own shell environment. See [CONFIGURATION.md](CONFIGURATION.md) for the local parameter reference and links to authoritative upstream Pi documentation, and [CONTEXT.md](CONTEXT.md) for the local extension architecture (seams, tool receipts, agent catalog, sync-vs-async task internals).

## Overview

This repo layers several things on top of a stock Pi install:

- **A `task` tool, persistent async `task_*` tools, and a roster of specialist sub-agents** (`agent/agents/`) whose prompts are adapted from [Amp](https://ampcode.com/)'s published agent and sub-agent prompts, with additional custom agents added.
- **Extensions** (`agent/extensions/`) that provide the task/orchestration tooling, web search, MCP presentation, background-process management, a custom "Apex" TUI presentation layer, and crash logging.
- **Slash commands and prompt templates** — native `/browser` and `/deploy` commands are registered by `agent/extensions/prompt-commands.ts`; simpler Markdown templates such as `/brainstorm` live in `agent/prompts/`.
- **Skills** (`agent/skills/`) for image generation and background processes.
- **A theme** (`agent/themes/apex-dark.json`) selected via `agent/settings.json`.
- **Tracked `*.example.json` minimal templates** for the three gitignored configs that have one — see [Example and template files](#example-and-template-files).

## Sub-agents and Orchestration Tools

Pi's main agent delegates bounded units of work to specialist sub-agents through synchronous and asynchronous task tools:

- **`task`** — synchronous task delegation: spawns a specialist sub-agent, streams activity back into the parent session, and blocks until returning a single final report.
- **`task_start` / `task_status` / `task_list` / `task_send` / `task_wait` / `task_abort` / `task_close` / `task_reply`** — asynchronous RPC sub-agent management: starts persistent isolated sessions in the background, steers or sends follow-ups mid-flight, handles UI extension requests, and retrieves or waits for results while keeping the lead context free.

Each task spawns a separate `pi` process with the specialist's own system prompt, model, thinking level, and tool set.

**`task_start` is the preferred delegation path** (see `agent/SYSTEM.md`): it returns a worker handle immediately so the lead agent can keep working, monitor, or dispatch other tasks in parallel. `task` (synchronous, blocking) is reserved for cases needing a single bounded result in-line before continuing. The async lifecycle is: `task_start` to launch a worker (counts against a cap of 3 concurrent live workers) → do other work or poll with `task_status` / `task_list` → `task_send` to steer or follow up → `task_wait` to block until the current generation settles → **`task_close` to reap the worker**. A worker normally holds its concurrency slot until closed, so `task_close` is required lifecycle hygiene once a worker's result has been collected. `task_reply` answers a worker's interactive UI dialog request (select/confirm/input/editor) by request id.

**Model fallback differs between the two tools.** Each agent file declares a primary model plus an ordered fallback chain (`modelAttempts()`). The synchronous `task` tool retries through that full chain on failure. `task_start` currently spawns using only the first resolved model in the chain — declared fallbacks are not retried at spawn time (source comment: "v1: use first model only for spawn; fallbacks can be retried on hard fail later").

`task_send` has two delivery modes with different queueing semantics:

- **`steer`** — queued at the next **model-call boundary**: it cannot interrupt inference or an in-flight tool call, and is delivered after the current assistant turn finishes its tool calls, just before the next LLM call.
- **`follow_up`** — delivered only after the worker fully **settles** (no more tool calls or pending steering).

A `prompt`-mode send is only allowed once a worker is settled or failed; use `steer`/`follow_up` while it's still running.

The task tool and the sub-agent prompts are **based on Amp's prompts and sub-agents**. Amp ships a small set of built-in sub-agents (an orchestrator, a search/oracle reviewer, a librarian, and fast workers); the reference prompts live under `reference/amp-prompts/` and are used as behavioral and structural templates. On top of that foundation this configuration adds a broader roster of purpose-built specialists:

| Agent | Role |
| --- | --- |
| `advisor` | Strategic planner consulted before consequential approaches, when stuck, or when changing direction. Advisory only. |
| `artisan` | Bold visual-design and frontend specialist for substantial UI implementation, design judgment, exploratory refinement, diagrams, slides, and data visualization. |
| `inspector` | Fast, cheap read-only UI verifier for bounded browser interaction, responsive checks, screenshots, and focused visual regression analysis after implementation. |
| `librarian` | Remote source-code researcher for external libraries, framework internals, and cross-repository investigation. |
| `machinist` | Workhorse coding specialist for large implementation chunks, backend logic, refactors, migrations, bug fixes, and tests. |
| `oracle` | Deep independent code reviewer and debugger for difficult bugs, conflicting evidence, and high-stakes decisions. |
| `picasso` | Image-generation specialist for concept art, UI renderings, illustrations, icons, logos, textures, and diagrams. |
| `scout` | Fast, cheap local codebase reconnaissance for broad scans, architecture mapping, and context gathering. |
| `scribe` | Editorial writing specialist for blog posts, articles, documentation, launch copy, and long-form prose. |
| `stevedore` | Fast ops specialist for deploys and CLI chores: lint, format, build, git, and platform CLIs. |

Shared norms that apply to every specialist (smallest-correct-change discipline, browser rules, evidence, dirty-worktree safety, etc.) live in [`agent/agents/_shared.md`](agent/agents/_shared.md). Worker-mode semantics are separate: `_shared-sync.md` describes fire-and-forget `task` runs, while `_shared-async.md` describes persistent RPC workers with steering, follow-ups, and UI requests. [`agent/agents/_handoff.md`](agent/agents/_handoff.md) is appended for both modes and requires a non-empty visible final report for each generation. Each agent file also declares its primary model plus a fallback chain: the synchronous `task` tool retries through that chain on failure, so a `task` call keeps running even if a provider is unavailable. Async fallback behavior is implemented in the current working tree and should be documented once that lifecycle-sensitive change is finalized.

## Extensions

Custom TUI and orchestration extensions live in `agent/extensions/`:

- **`apex/amp-task.ts` & `apex/async-task.ts`** — implements `task` and persistent async RPC subagent tools (`task_start`, `task_status`, `task_list`, `task_send`, `task_wait`, `task_abort`, `task_close`, `task_reply`). Supports isolated sessions, background execution, steering/follow-up messaging, interactive UI dialog handling, hard/idle/turn guards, and rich task presentation (specialist badges, mission, model, thinking level, turn count, live tool activities, durations, and bounded final reports). `task` retries the agent's declared model fallback chain on failure; `task_start` spawns with only the first resolved model (no fallback retry at spawn time).
- **`apex/apex-ui.ts`** — the "Apex" presentation layer: styled built-in `read`/`bash`/`edit`/`write` rows, bounded output previews, diffs, a context footer, and a working animation. Supports emergency opt-out via `PI_APEX_UI=0` and logs rendering failures to `agent/pi-render.log`.
- **`apex/lib/` shark surfaces** — the mark carries state rather than just opening the session; see [The shark](#the-shark).
- **`web-search.ts`** — provides native Exa web search and page fetching tools (`web_search`, `fetch_content`, `get_search_content`) with caching and domain filtering.
- **`prompt-commands.ts`** — registers the native `/browser` and `/deploy` slash commands directly via `pi.registerCommand()`, without external plugins. It does not register or discover Markdown prompt templates; those are handled by upstream Pi's own prompt-template loading (see [Slash commands](#slash-commands)).
- **`mcp-adapter.ts`** — composes Apex's MCP presentation with the root `pi-mcp-adapter` dependency on one `ExtensionAPI`. Do not also add `pi-mcp-adapter` to `agent/settings.json` packages; independent package loading would initialize a second MCP extension and bypass this shared presentation wrapper.
- **`bg-process.ts`** — background-process management (`bg_start`, `bg_status`, `bg_list`, `bg_kill`) for dev servers and watchers.
- **`todo-list.ts`** — the session plan (`todo_write`, `todo_read`). `todo_write` replaces the whole list on each call and enforces at most one `in_progress` item; statuses are `pending`, `in_progress`, `blocked`, `completed`, `cancelled`. `blocked` marks work waiting on a user decision, another agent, or an external service: it stays open and never counts toward done, and the collapsed view anchors on it when nothing is in progress so the only open item can't hide behind completed rows. `todo_read` returns a bounded serialization of every item — status, exact content text, and note — so the plan and its exact wording survive compaction; items are addressed by content text, not by id. Scoped to the lead agent: specialists run non-interactively and report once, and no agent definition grants them these tools. The threshold for writing a plan lives in `agent/SYSTEM.md`. Render behavior is guarded by `agent/extensions/apex/lib/todo-list-preview.mjs` (run it with `node --experimental-transform-types`).
- **`continual-memory.ts`** — small evidence-backed durable notes outside the chat (`memory_list`, `memory_write`). Kinds: `memory` (facts/preferences/failures) and `prompt` (narrow policy addendums only). Session-local entries resume via custom session entries; global entries live under `agent/harness/global.json` (gitignored). Injected as a compact overview each turn via `before_agent_start`. Manual only — never rewrites `SYSTEM.md`.
- **`crash-logger.ts`** — records fatal JavaScript/stream errors and nonzero exits to `agent/pi-crash.log`, distinguishing main and sub-agent processes. Routine shutdowns and exit code zero are ignored; at 1 MiB the complete active log is atomically renamed, with one rotated generation retained.
- **`lsp/`** — a single on-demand `lsp` tool for semantic navigation (`definition`, `references`, `hover`, `document_symbols`, `workspace_symbols`, `diagnostics`, `read_symbol`) backed by language servers already on `PATH` (TypeScript/JavaScript, Python, Go, PHP). It never installs servers and runs no always-on analysis; servers spawn per session and are disposed on `session_shutdown`. Bare commands resolve on `PATH` only — never from the project directory — so an untrusted repo can't inject a binary. Optional config at `agent/lsp.json` or a trusted `.pi/lsp.json`.

No extensions are currently loaded as npm packages; `agent/settings.json` `packages` is empty. (`pi-sticky-input` was dropped at Pi 0.84.1 in favor of the built-in `tuiMode: "fullscreen"`.)

## Slash commands

`/browser` and `/deploy` are native commands registered in code by `agent/extensions/prompt-commands.ts` (`pi.registerCommand()`), because both need executable pre-steps — a deterministic browser-connect step and a git worktree snapshot, respectively — that plain prompt-template expansion can't do. Simpler prompt templates live under `agent/prompts/*.md` (e.g. [`/brainstorm`](agent/prompts/brainstorm.md)); see [CONFIGURATION.md](CONFIGURATION.md#prompt-template-markdown-agentpromptsmd-upstream-pi) for the template frontmatter/argument format.

`/orchestrate [on|off]` is also native, registered by the same extension: it toggles a **sticky strict-orchestrator mode**. While on, every turn's system prompt gets an appended block (via `before_agent_start`) that revokes the lead's inline allowance — no self-written edits (machinist/artisan own all implementation), no broad self-reading (scout owns discovery), routine post-implementation browser and screenshot verification goes to the read-only inspector, mandatory fresh-eyes review, and the non-negotiable gates with zero inline exemptions. Artisan remains responsible when verification requires design judgment, exploratory refinement, or implementation changes. The toggle persists across session resume via a custom session entry and shows an `orchestrator` footer status while active. A one-shot prompt template couldn't do this because template expansion only rides on a single message.

`agent/prompts/inactive/` keeps the original Markdown-template versions of [`browser.md`](agent/prompts/inactive/browser.md) and [`deploy.md`](agent/prompts/inactive/deploy.md) for reference; they are not discovered as commands (non-recursive prompt-template discovery skips the `inactive/` subdirectory) and are superseded by the native implementations above.

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

Skills live in `agent/skills/` and are freeform directories beyond the required `SKILL.md`:

- [`background-process/SKILL.md`](agent/skills/background-process/SKILL.md) — documents the `bg_*` tools (from `bg-process.ts`) for long-running commands like dev servers and watchers.
- [`generate-image/SKILL.md`](agent/skills/generate-image/SKILL.md) — image generation via a bundled helper script, [`generate_image.py`](agent/skills/generate-image/generate_image.py), with an automatic model fallback chain.

## Theme

`agent/themes/apex-dark.json` is a custom dark theme selected via `agent/settings.json` (`"theme": "apex-dark"`) and hot-reloads when edited while active. See [CONFIGURATION.md](CONFIGURATION.md#themes-agentthemesjson-upstream-pi) for the tracked field/format reference.

## The shark

The configuration has one visual identity — a shark in deep space — used as the Observatory landing mark, not as a live animation during work.

The mark itself is **drawn, not photographed**: `tools/shark-art/encode-shark.py` renders a parametric side profile (smooth body curves plus straight-edged fin polygons) into truecolor half-block cells, where each glyph carries two rows of pixels. It emits generated TypeScript (`lib/shark-art.ts`) — regenerate it, never hand-edit. `lib/pixel-art.ts` decodes the shared cell format and gates on truecolor, falling back to glyph art elsewhere.

Surfaces that still use the identity:

| Surface | What it shows |
| --- | --- |
| **Observatory splash** (`lib/observatory.ts`) | The full mark, on a fresh chat only. |
| **Star field** (`lib/star-field.ts`) | Two facts in one row: the *shape* is seeded from the workspace path, so every project has its own constellation that is stable across launches; the *density* is context usage, with stars burning out faintest-first as the window fills. |

Compaction uses Pi's built-in spinner only. Live async workers show through the normal task status cards and `task_*` tools. Apex keeps no extension-owned animation clocks for either surface (see [CONTEXT.md](CONTEXT.md#apex-stability-constraints)).

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
