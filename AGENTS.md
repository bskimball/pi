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
├── harness/               # runtime state: global memory, model circuits
├── extensions/            # see below
└── pi-*.log               # render / crash / lifecycle traces
reference/                 # source material, not runtime data
```

## Extension Architecture

Pi discovers extensions two ways: a bare `*.ts` file in `agent/extensions/`, or a directory whose `package.json` declares `pi.extensions`. Everything under a directory that is not a declared entry point is private support code.

```text
agent/extensions/
├── apex/            → apex-ui.ts          the UI layer (see below)
├── task/            → amp-task.ts, async-task.ts   sync `task` + async task_* RPC workers
├── lsp/             → index.ts            language-server navigation
├── unified-edit/    → adapter.ts          the `edit` tool (row edit scripts)
├── bg-process.ts    + bg-process/         bg_start/status/list/kill
├── powershell.ts    + powershell/         direct PowerShell child process
├── crash-logger.ts  + crash-logger/       crash/lifecycle logs, terminal restore, segmenter shield
├── continual-memory.ts + continual-memory/  memory_list / memory_write
├── prompt-commands.ts + prompt-commands/  /browser, /deploy, /orchestrate
├── graphify.ts                            local knowledge-graph query
├── mcp-adapter.ts                         pi-mcp-adapter bridge
├── read-guard.ts                          duplicate-image + downscale guard
├── todo-list.ts                           session todo tools + widget
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

`apex/` owns the interactive presentation layer; every other extension is either headless or renders its own chrome locally.

```text
apex/apex-ui.ts                      interactive layout, working indicator, header mount
├── builtin-tools.ts                 read/bash/write/edit adapters (execution delegates to Pi)
├── internal/presentation/
│   ├── presentation.ts              withApexPresentation() — the PI_APEX_UI=0 gate
│   ├── tool-receipt.ts              bounded tool receipts
│   ├── edit-diff.ts                 diff rendering for edit/write
│   ├── render-safety.ts             guards Pi TUI text/markdown renderers
│   ├── safe-text-layout.ts          measure/truncate; never use .length
│   └── ui-common.ts                 shared width/ANSI primitives
├── internal/runtime/                segmenter-safety, last-phase, terminal-restore,
│                                    agent-discovery, featured-commands
└── observatory/                     blank-chat landing screen (see below)
```

- `PI_APEX_UI=0` is the installation-wide presentation opt-out. `apex-ui.ts` installs nothing, and `withApexPresentation()` strips `renderCall`/`renderResult`/`renderShell` so tools fall back to Pi's stock boxed renderer over model-facing text. Execution and tool registration are unaffected.
- `task/` renders its own cards through its own gate, `withTaskPresentation()`: `PI_TASK_UI=0` disables task cards alone; `PI_APEX_UI=0` disables them too. Task child processes are spawned with `PI_APEX_UI=0` so workers never paint chrome.
- Headless by design — these use Pi's stock rendering: `bg-process`, `powershell`, `mcp-adapter`, `todo-list`, `web-search`, `graphify`, `continual-memory`, `read-guard`, `lsp`.
- There is no custom footer. Pi owns the footer; `prompt-commands` and `graphify` publish status through `ctx.ui.setStatus(key, …)` only.

### Rendering Constraints

These come from real Windows Terminal failures and still apply to any custom rendering:

- No presentation timers: no `setInterval()` render loops, no `tui.requestRender()` on a timer. Pi owns render scheduling.
- Measure and truncate with the owning extension's `safe-text-layout.ts`, never `.length` and never Pi TUI `visibleWidth()`/`truncateToWidth()` in high-frequency custom rendering.
- Keep tool and task output bounded in both line count and character count.
- Sanitize dynamic text; keep ANSI styling simple and balanced; never splice styled strings by JS code-unit offsets.
- Use narrow BMP glyphs. No wide, ambiguous-width, or combining characters.
- Do not scan the full session during a render. Cache derived data outside the render path.

### Crash And Stability Diagnostics

`crash-logger.ts` loads at module scope (before the first paint) and installs, independent of `PI_APEX_UI`:

- **Segmenter shield** (`crash-logger/internal/segmenter-safety.ts`, mirrored in `apex/internal/runtime/`): replaces grapheme `Intl.Segmenter.prototype.segment` with a lazy JS extended-grapheme scan, because native ICU grapheme segmentation can abort the Node process on Windows with no JS stack. Word/sentence granularity stays native so editor word navigation keeps `isWordLike`. `PI_SEGMENTER_NATIVE=1` restores native graphemes for diagnostics only.
- **Last-phase breadcrumbs**: each pid writes its current phase to `agent/.tmp/last-phase-<pid>`; the watchdog copies it into `pi-lifecycle.log` / `pi-crash.log` as `last-phase: …` when the parent disappears uncleanly.
- **Terminal restore watchdog**: restores raw/mouse mode when a session dies without `session_shutdown`.

Logs: `agent/pi-crash.log` (fatal JS), `agent/pi-render.log` (render failures, large-input segmenter warnings), `agent/pi-lifecycle.log` (compaction, exits).

When a session dies uncleanly, read those logs before blaming a provider or subagent, and run once with `PI_APEX_UI=0` to isolate the presentation layer. A clean noninteractive import or smoke test proves syntax only — acceptance for UI changes requires sustained interactive use in Windows Terminal (fullscreen mode) with a large `bash` result, a session resume, and a real delegated `task`.

## Observatory Landing Screen

The blank-chat landing screen lives in `apex/observatory/` and is mounted by `apex-ui.ts` via `ctx.ui.setHeader(...)` as Pi's startup header — not an above-editor widget — so with `quietStartup` it is the opening screen and has the full `OBSERVATORY_MAX_LINES` (25) budget rather than the 10-line above-editor cap.

```text
observatory/
├── observatory.ts        composition, inventory, glyph shark tiers, selectors
├── observatory-orb.ts    focus/selection state
├── shark-art.ts          truecolor pixel bitmaps (ULTRA / WIDE / MID)
├── pixel-art.ts          half-block pixel renderer + truecolor detection
├── star-field.ts         background star rows
├── preview.mjs           full-screen harness
└── sky-preview.mjs       star-field-only harness
```

### Shark Wordmark

A hand-authored side-profile great white swimming left over a quiet star field (`logoBlock` in `observatory.ts`). Tiers, widest first:

| Tier | Source | Requires |
| --- | --- | --- |
| `SHARK_PIXELS_ULTRA` (112 cols) | `shark-art.ts` | truecolor |
| `SHARK_PIXELS_WIDE` (72) | `shark-art.ts` | truecolor |
| `SHARK_PIXELS_MID` (48) | `shark-art.ts` | truecolor |
| `SHARK_LOGO` (56) | `observatory.ts` | width ≥ `FULL_MIN` (62) |
| `SHARK_COMPACT` (18) | `observatory.ts` | width ≥ `MINIMAL_MIN` (20) |
| `SHARK_MINIMAL` (`▴`) | `observatory.ts` | any |

Pixel tiers are skipped entirely without 24-bit color, so the glyph tiers are what most terminals show.

- Tier widths and row heights are load-bearing. Changing art must update the matching `*_WIDTH` and `*_KEYS` arrays together or `indent()`/`center()` breaks. Logo height also feeds `constellationBlock`'s row budget.
- Countershading comes from color, not glyph noise: per-row theme keys in `SHARK_LOGO_KEYS`/`SHARK_COMPACT_KEYS`, plus one `null`-keyed lateral-line row rendered by `lateralLine()`.
- Geometry is static on focus. When the orb is active only the lateral line's color changes; art arrays never vary by selection or focus.
- Use narrow block glyphs (`█ ▓ ▒ ░ ▀ ▄`) only.
- Any silhouette change must stay recognizably a shark in profile at the full tier and keep the compact-tier cues: dorsal fin, snout, belly, forked tail.

### Preview Harness

Do not iterate on this surface through screenshots.

```
node --experimental-transform-types agent/extensions/apex/observatory/preview.mjs
node --experimental-transform-types agent/extensions/apex/observatory/preview.mjs 80
node --experimental-transform-types agent/extensions/apex/observatory/sky-preview.mjs
```

Renders four inventory scenarios (populated user, balanced project, extension pathways, empty) at 40/60/80/100/120/160 columns — or the widths passed as arguments — approximates apex-dark on a dark background, flags `TOO TALL` / `OVERFLOW`, and exits nonzero on any bound failure. Check all three responsive glyph tiers (≥62, 20–61, <20 columns) when touching the art, and keep the harness in sync when `buildObservatory`/`renderObservatory` signatures change.

### Constraints

- Pure passive string rendering: no timers, no `requestRender()`, no Pi TUI `Text`, `Markdown`, or `Container`.
- Keep within `OBSERVATORY_MAX_LINES` (25) and stay dense rather than padded with blank lines.
- Color only through `theme.fg(key, text)`.
- The workspace signal must stay truthful — fall back to `AWAITING A SIGNAL` when no project-scoped resources exist.

## Validation

```
npm run typecheck                                        # tsc --noEmit, whole config
node --experimental-transform-types --test agent/extensions/test/*.test.ts
node --experimental-transform-types --test agent/extensions/lsp/test/*.test.ts
node --experimental-transform-types --test agent/extensions/unified-edit/test/*.test.ts
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
