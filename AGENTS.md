# AGENTS.md — Custom Pi Configuration

## Purpose

This directory (`~/.pi`) is the workspace for the user's custom Pi configuration. Requests here concern Pi itself — its agents, prompts, skills, extensions, models, MCP integrations, and themes — unless the user explicitly names another repository.

Do not redirect requests to an unrelated application repository based on terms such as "the app," "the UI," or references to earlier work. If the user explicitly names another project, locate it, read its repository instructions, and inspect its worktree before making changes.

## Layout

```text
agent/
├── SYSTEM.md              # base system prompt
├── settings.json          # model, theme (currently claude-dark), tuiMode, compaction
├── models.json / mcp.json # provider + MCP configuration
├── agents/                # specialist briefs (_shared*.md are composed in)
├── prompts/               # slash-command prompts (inactive/ = extension-owned)
├── skills/                # local skills
├── themes/                # apex-dark.json, claude-dark.json
├── harness/                # runtime state: global memory, model circuits
├── extensions/             # see below
└── logs/                  # render / crash / lifecycle / lsp traces
reference/                 # source material, not runtime data
```

## Extension Architecture

Pi discovers extensions two ways: a bare `*.ts` file in `agent/extensions/`, or a directory whose `package.json` declares `pi.extensions`. Everything under a directory that is not a declared entry point is private support code.

```text
agent/extensions/
├── apex/            → apex-ui.ts          Apex UI (shark Observatory, braille indicator)
├── claude/          → claude-ui.ts        Claude UI (star motifs, Claude verbs)
├── hal/             → hal-ui.ts           HAL UI (orb landing, square glyphs)
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
├── at-path-complete.ts                    scoped @ listing for gitignored paths
└── test/                                  cross-extension tests
```

### Each Extension Stands On Its Own

This is the load-bearing invariant, enforced by `extensions/test/extension-discovery.test.ts`:

- **No cross-extension source imports.** Every relative import in an entry point's closure must stay under that extension's own directory. Shared UI presentation lives in `packages/ui-kit` (`@pi/ui-kit`), not `agent/extensions/shared` — the test still asserts `extensions/shared` does not exist. Headless helpers (`last-phase.ts`, `terminal-restore.ts`, `process-tree-kill.ts`, `agent-discovery.ts`, `segmenter-safety.ts`) stay duplicated per owner.
- **One entry point per extension, discovered once.** Support code lives in `internal/`, `runtime/`, `presentation/`, `observatory/`, or `test/` so it is never loaded as a second extension.
- **Deleting an extension directory + its entry file removes the feature cleanly**, with no dangling imports elsewhere.

When editing a duplicated helper, decide deliberately whether the change belongs to one owner or all of them, and apply it per owner.

### Three installable UIs

`apex/`, `claude/`, and `hal/` are separately discovered UI extensions. Shared receipts, layout, todo tools, and the single `ToolExecutionComponent` wrap live in `packages/ui-kit`. Deleting one UI directory uninstalls that look. See `CONTEXT.md` for presentation ownership.

- `PI_APEX_UI=0` is the installation-wide presentation opt-out: it disables custom styling, chrome, and render hooks. Kit-owned tools remain registered and executable. The todo panel stays mounted as a plain, uncolored list.
- `/ui` selects `pi` (stock Pi) or an **installed** UI (`apex`, `claude`, `hal`). Missing UI directories fail closed. Installed custom UIs set `PI_APEX_UI=1` and `PI_UI_SKIN` to their name. Claude uses round receipts and `claude-dark`; HAL uses square receipts, a truecolor orb+wordmark landing, quiet activity, and `hal-dark`. Glyphs are read at call time so a live `/ui` switch applies without a restart; unset `PI_UI_SKIN` falls back to Apex glyphs.
- `/mode work` is operations-first and uses its own prompt rather than the coding-first `agent/SYSTEM.md`. It shares Fusion's persistent sidekick lifecycle and configured model pair but keeps the existing synchronous specialist roster available. Business workflows and integrations remain owned by their project; custom work agents are not bundled into this mode.
- Live async workers share that same above-editor dock as an Agents tab (`alt+a` / `/agents`; `alt+t` / `/todos` still collapse). Triggers and chrome-off behavior: [`CONTEXT.md` § Todo dock](CONTEXT.md#todo-dock).
- `task/` renders its own cards through its own gate: `PI_TASK_UI=0` disables task cards alone; `PI_APEX_UI=0` disables them too. Task children are spawned with `PI_APEX_UI=0` so workers never paint chrome.
- Headless by design (execute, not chrome): `bg-process`, `powershell`, `mcp-adapter`, `web-search`, `continual-memory`, `read-guard`, `lsp`, `graphify`, `prompt-commands` (`browser_attach`). The kit attaches receipt chrome to several of these, skipped entirely when `PI_APEX_UI=0`. `at-path-complete` is also headless: it only wraps scoped `@` autocomplete. Pi owns standard `read`/`edit` execution and skill invocation lifecycle; the kit owns their interactive chrome.
- There is no custom footer. Pi owns the footer.

### Rendering Constraints

These come from real Windows Terminal failures and still apply to any custom rendering:

- No presentation timers: no `setInterval()` render loops, no `tui.requestRender()` on a timer. Pi owns render scheduling.
- Measure and truncate with kit `safe-text-layout.ts` (or the owning extension's copy for headless helpers), never `.length` and never Pi TUI `visibleWidth()`/`truncateToWidth()` in high-frequency custom rendering.
- Keep tool and task output bounded in both line count and character count.
- Sanitize dynamic text; keep ANSI styling simple and balanced; never splice styled strings by JS code-unit offsets.
- Use narrow BMP glyphs. No wide, ambiguous-width, or combining characters.
- Do not scan the full session during a render. Cache derived data outside the render path.

### Observatory Landing Screen

Blank-chat landing is mounted via `ctx.ui.setHeader(...)`. Apex shark/star art lives in `agent/extensions/apex/observatory/`; HAL orb art lives with the HAL UI. The shared Observatory engine is in `packages/ui-kit`. Apex art rules: [`agent/extensions/apex/observatory/README.md`](agent/extensions/apex/observatory/README.md).

### Crash And Stability Diagnostics

`crash-logger.ts` installs the segmenter shield, last-phase breadcrumbs, and terminal-restore watchdog independent of `PI_APEX_UI`. See `CONTEXT.md` § "Long-session and subagent stability" for the full mechanism.

Logs: `agent/logs/pi-crash.log` (fatal JS), `agent/logs/pi-render.log` (render failures), `agent/logs/pi-lifecycle.log` (compaction, exits), `agent/logs/pi-lsp.log` (LSP diagnostic probes). Read these before blaming a provider or subagent on an unclean session death.

## Validation

```
npm run typecheck                                        # tsc --noEmit, whole config
npm run lint                                             # oxlint, .oxlintrc.json defaults
node --experimental-transform-types --test agent/extensions/test/*.test.ts
node --experimental-transform-types --test agent/extensions/lsp/test/*.test.ts
node --experimental-transform-types --test agent/extensions/apex/test/*.test.ts
node --experimental-transform-types --test agent/extensions/task/*.test.ts agent/extensions/task/presentation/*.test.ts agent/extensions/task/runtime/test/*.test.ts
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
