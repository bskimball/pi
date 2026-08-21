# AGENTS.md — Custom Pi Configuration

## Purpose

This directory (`~/.pi`) is the workspace for the user's custom Pi configuration. Requests here concern Pi itself — its agents, prompts, skills, extensions, models, MCP integrations, and themes — unless the user explicitly names another repository.

Do not redirect requests to an unrelated application repository based on terms such as "the app," "the UI," or references to earlier work. If the user explicitly names another project, locate it, read its repository instructions, and inspect its worktree before making changes.

## Layout

```text
agent/
├── SYSTEM.md              # base system prompt
├── settings.json          # model, theme (apex-dark), tuiMode, compaction
├── models.json / mcp.json # provider + MCP configuration
├── agents/                # specialist briefs (_shared*.md are composed in)
├── prompts/               # slash-command prompts (inactive/ = extension-owned)
├── skills/                # local skills
├── themes/                # apex-dark.json
├── harness/                # runtime state: global memory, model circuits
├── extensions/             # see below
└── pi-*.log               # render / crash / lifecycle traces
reference/                 # source material, not runtime data
```

## Extension Architecture

Pi discovers extensions two ways: a bare `*.ts` file in `agent/extensions/`, or a directory whose `package.json` declares `pi.extensions`. Everything under a directory that is not a declared entry point is private support code.

```text
agent/extensions/
├── apex/            → apex-ui.ts          the UI layer (Observatory, tool receipts, edit, todo)
├── task/            → amp-task.ts, async-task.ts   sync `task` + async task_* RPC workers
├── lsp/             → index.ts            language-server navigation
├── bg-process.ts    + bg-process/         bg_start/status/list/kill
├── powershell.ts    + powershell/         direct PowerShell child process
├── crash-logger.ts  + crash-logger/       crash/lifecycle logs, terminal restore, segmenter shield
├── continual-memory.ts + continual-memory/  memory_list / memory_write
├── prompt-commands.ts + prompt-commands/  /browser, /deploy, /orchestrate
├── graphify.ts                            local knowledge-graph query
├── worktree.ts   + worktree/               isolated Git worktree add/list/remove
├── mcp-adapter.ts                         pi-mcp-adapter bridge
├── read-guard.ts                          duplicate-image + downscale guard
├── user-profile.ts                        private user context injection
├── web-search.ts                          Exa search + fetch_content
└── test/                                  cross-extension tests
```

### Each Extension Stands On Its Own

This is the load-bearing invariant, enforced by `extensions/test/extension-discovery.test.ts`:

- **No cross-extension source imports.** Every file in an entry point's import closure must live under that extension's own directory. Shared-looking helpers (`safe-text-layout.ts`, `ui-common.ts`, `last-phase.ts`, `terminal-restore.ts`, `process-tree-kill.ts`, `tool-result.ts`, `agent-discovery.ts`, `segmenter-safety.ts`) are **intentionally duplicated** per owner. Do not refactor them into a `shared/` directory — the test asserts `extensions/shared` does not exist.
- **One entry point per extension, discovered once.** Support code lives in `internal/`, `runtime/`, `presentation/`, `observatory/`, or `test/` so it is never loaded as a second extension.
- **Deleting an extension directory + its entry file removes the feature cleanly**, with no dangling imports elsewhere.

When editing a duplicated helper, decide deliberately whether the change belongs to one owner or all of them, and apply it per owner.

### Apex Is The UI

`apex/` owns the interactive presentation layer; every other extension is either headless or renders its own chrome locally. Receipt modules for headless tools live under `apex/internal/presentation/`; see `CONTEXT.md` for presentation ownership detail.

- `PI_APEX_UI=0` is the installation-wide presentation opt-out: it disables Apex styling, chrome, and custom render hooks. Apex-owned tools remain registered and executable — execution and tool registration are unaffected. The one deliberate exception is the todo panel: it stays mounted and falls back to a plain, uncolored list instead of disappearing.
- Live async workers share that same above-editor dock as an Agents tab (`alt+a` / `/agents`; `alt+t` / `/todos` still collapse). Triggers and chrome-off behavior: [`CONTEXT.md` § Todo dock](CONTEXT.md#todo-dock).
- `task/` renders its own cards through its own gate: `PI_TASK_UI=0` disables task cards alone; `PI_APEX_UI=0` disables them too. Task children are spawned with `PI_APEX_UI=0` so workers never paint chrome.
- Headless by design (execute, not chrome): `bg-process`, `powershell`, `mcp-adapter`, `web-search`, `continual-memory`, `read-guard`, `lsp`, `graphify`. Apex attaches receipt chrome to several of these, skipped entirely when `PI_APEX_UI=0`.
- There is no custom footer. Pi owns the footer.

### Rendering Constraints

These come from real Windows Terminal failures and still apply to any custom rendering:

- No presentation timers: no `setInterval()` render loops, no `tui.requestRender()` on a timer. Pi owns render scheduling.
- Measure and truncate with the owning extension's `safe-text-layout.ts`, never `.length` and never Pi TUI `visibleWidth()`/`truncateToWidth()` in high-frequency custom rendering.
- Keep tool and task output bounded in both line count and character count.
- Sanitize dynamic text; keep ANSI styling simple and balanced; never splice styled strings by JS code-unit offsets.
- Use narrow BMP glyphs. No wide, ambiguous-width, or combining characters.
- Do not scan the full session during a render. Cache derived data outside the render path.

### Observatory Landing Screen

The blank-chat landing screen (shark wordmark + star field) lives in `agent/extensions/apex/observatory/`, mounted via `ctx.ui.setHeader(...)`. Full art tiers, wordmark rules, preview-harness commands, and rendering constraints are documented in [`agent/extensions/apex/observatory/README.md`](agent/extensions/apex/observatory/README.md) — read it before touching anything under `observatory/`.

### Crash And Stability Diagnostics

`crash-logger.ts` installs the segmenter shield, last-phase breadcrumbs, and terminal-restore watchdog independent of `PI_APEX_UI`. See `CONTEXT.md` § "Long-session and subagent stability" for the full mechanism.

Logs: `agent/pi-crash.log` (fatal JS), `agent/pi-render.log` (render failures), `agent/pi-lifecycle.log` (compaction, exits). Read these before blaming a provider or subagent on an unclean session death.

## Validation

```
npm run typecheck                                        # tsc --noEmit, whole config
npm run lint                                             # oxlint, .oxlintrc.json defaults
node --experimental-transform-types --test agent/extensions/test/*.test.ts
node --experimental-transform-types --test agent/extensions/lsp/test/*.test.ts
node --experimental-transform-types --test agent/extensions/apex/test/*.test.ts
node --experimental-transform-types --test agent/extensions/task/*.test.ts agent/extensions/task/runtime/test/*.test.ts
```

Run `extension-discovery.test.ts` after any change to extension layout, entry points, or imports.

## Reference Material

`reference/` holds source material, not runtime data.

- `reference/amp-prompts` — Amp Coding Agent prompts, used as behavioral and structural references when authoring Pi system prompts, agent briefs, and orchestration instructions.
- `reference/pi-tui` — Pi UI concept images and screenshots.

Treat these as references, not active configuration. Do not edit them, and do not create or replace concept images, unless the user explicitly asks.

## Rules

- Treat this directory as the active project when the request concerns custom Pi behavior or configuration.
- Inspect relevant configuration and implementation files before editing them.
- Make the smallest targeted change that satisfies the request; preserve existing user changes and conventions.
- Do not expose secrets, tokens, credentials, browser profiles, or authentication data.
- Do not edit generated or runtime data unless explicitly requested: caches, `agent/sessions/`, `agent/harness/`, `agent/models-store.json`, browser state, `node_modules/`, `graphify-out/`.
- Keep temporary artifacts outside this directory unless they are intentional Pi configuration assets.
