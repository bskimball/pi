# AGENTS.md — Custom Pi Configuration

## Purpose

This directory is the workspace for the user's custom Pi configuration. Requests made in this workspace should be interpreted as work on Pi itself—its agents, prompts, skills, extensions, models, MCP integrations, themes, and related configuration—unless the user explicitly names another repository.

## Working Directory

Use the Pi configuration directory (`~/.pi`) as the default working directory for Pi configuration tasks. Do not redirect requests to an unrelated application repository based on terms such as “the app,” “the UI,” or references to earlier work.

If the user explicitly names another project, locate that project in your local development directory, read its repository instructions, and inspect its worktree before making changes.

## Important Paths

- Pi agent configuration: `~/.pi/agent`
- Agents: `~/.pi/agent/agents`
- Extensions: `~/.pi/agent/extensions`
- Prompts: `~/.pi/agent/prompts`
- Skills: `~/.pi/agent/skills`
- Themes: `~/.pi/agent/themes`
- MCP configuration: `~/.pi/agent/mcp.json`
- Model configuration: `~/.pi/agent/models.json`
- Pi settings: `~/.pi/agent/settings.json`
- System instructions: `~/.pi/agent/SYSTEM.md`
- Reference material: `~/.pi/reference`
- Amp Coding Agent prompt references: `~/.pi/reference/amp-prompts`
- Pi UI concept images and screenshots: `~/.pi/reference/pi-tui`

## Reference Material

The `reference` directory contains source material for the custom Pi configuration rather than runtime data.

- Use the Amp Coding Agent prompts in `reference/amp-prompts` as behavioral and structural references when authoring or refining Pi system prompts, agent prompts, orchestration instructions, and related templates.
- Treat these files as references, not as Pi's active configuration. Do not edit them unless the user explicitly asks to update the reference material.
- Use images and screenshots under `reference` as concept references for Pi UI, TUI, theme, and interaction work.
- Preserve reference assets. Create or replace concept images only when the user explicitly requests it.

## Apex UI Stability Work

The Windows Pi TUI has had intermittent renderer failures during long or resumed sessions, especially around large tool results and session transitions. Historical failures include `TypeError: segment.codePointAt is not a function` in `@earendil-works/pi-tui/dist/utils.js` and invalid Markdown token data. Apex UI is enabled by default; `PI_APEX_UI=0` is the emergency opt-out for both interactive Apex layout (`apex-ui`) and Apex tool/task receipts (`withApexPresentation` — tasks, bg, powershell, todos, memory, web, MCP, builtins). With the opt-out, tools keep working and fall back to Pi’s default boxed renderer over model-facing text. Renderer failures land in `agent/pi-render.log`, crashes in `agent/pi-crash.log`.

If renderer crashes resume, check the render evidence in those logs before blaming a provider or subagent failure, and run once with `PI_APEX_UI=0` to isolate the presentation layer. Record whether the exit happened during a tool-result, task-update, footer, working-indicator, or session-transition render, then disable one surface at a time in this order: final task-report styling, live task activity presentation, built-in tool presentation, footer, working-indicator styling. Noninteractive smoke tests do not prove interactive Windows Terminal stability.

### Stability Constraints

When modifying Apex UI or task rendering:

- Do not add custom `setInterval()` rendering loops or call `tui.requestRender()` on a presentation timer.
- The editor may only repaint an existing border or replace existing padding cells. Do not insert editor rows, change rendered line counts, or alter cursor/layout width calculations.
- Do not use Pi TUI `Text`, `Markdown`, `Container`, `visibleWidth()`, or `truncateToWidth()` in high-frequency custom tool/task/footer rendering without first proving the Windows crash is unrelated.
- Keep large tool and task output bounded in both line count and character count.
- Preserve task activity visibility. A stability fix must not collapse subagents to a one-line summary unless explicitly used as a diagnostic fallback.
- Validate with a large Bash result and a real delegated `task`.

### Custom Footer Incident and Invariants

In August 2026, repeated Windows Terminal sessions ended abruptly without `session_shutdown` or a JavaScript exception, leaving the parent shell in raw mode. At that time, `PI_APEX_UI=0` only skipped `apex-ui` while separately loaded Apex task renderers could remain active; the strongest isolated suspect was the custom footer in `agent/extensions/apex/apex-ui.ts`, which was removed. Task/tool receipts are now also gated by the same opt-out (`withApexPresentation`), so `PI_APEX_UI=0` isolates the full Apex presentation layer.

The likely failure mechanism was downstream of the footer's own `render()` guard: the footer returned dynamically sized and ANSI-styled frames, then Pi's fullscreen layout/compositor measured, clipped, diffed, and wrote them through Windows ConPTY. A compositor or terminal-write failure there would bypass the footer's `try/catch`, take Pi's emergency terminal-exit path, and skip normal raw-mode restoration. The footer also duplicated Pi's git-branch repaint subscription and changed between one and two rows as task, MCP, VS Code, token, model, branch, and context statuses changed.

For future footer work:

- Do not restore the removed status-heavy, responsive custom footer.
- Prefer Pi's built-in footer until interactive Windows stability has been demonstrated over long sessions, resumes, large tool results, and real delegated tasks.
- Any replacement custom footer MUST return exactly one row at every width and state. Its height must never depend on terminal width, status count, context usage, or content.
- A replacement MUST NOT mirror task, MCP, VS Code, background-job, or other extension statuses. Those surfaces already render elsewhere and independently trigger repaints.
- A replacement MUST NOT subscribe to branch changes or call `tui.requestRender()`; Pi already owns the branch watcher and render scheduling.
- A replacement MUST NOT scan the full session during `render()`. Cache data outside the render path and update it only from bounded lifecycle events.
- Sanitize all dynamic text, hard-truncate every returned line to the supplied width with `safe-text-layout.ts`, and avoid ambiguous-width/combining glyphs.
- Keep ANSI styling simple and balanced. Do not splice styled strings by JavaScript code-unit offsets or return partial escape sequences.
- Treat a clean noninteractive import or smoke test as syntax validation only. The acceptance test is sustained interactive use in Windows Terminal with fullscreen mode, a large Bash result, session resume, and a real delegated `task`.

## Observatory Landing Screen

The blank-chat landing screen ("Observatory") lives in `agent/extensions/apex/lib/observatory.ts` and is mounted by `agent/extensions/apex/apex-ui.ts` via `ctx.ui.setHeader(...)` as Pi's startup header (not an above-editor widget), so with quiet startup it IS the opening screen and has no 10-line above-editor cap. `OBSERVATORY_MAX_LINES` is 25, matching this budget.

### Cosmic Shark Design Direction

The wordmark is a hand-authored side-profile great white shark swimming left over a quiet star field, in `agent/extensions/apex/lib/observatory.ts` (`logoBlock`). Four tiers, widest first: truecolor bitmaps `SHARK_PIXELS_WIDE` and `SHARK_PIXELS_MID`, then the glyph shark (`SHARK_LOGO` at >= `FULL_MIN`, else `SHARK_COMPACT`), then `SHARK_MINIMAL`, a single `▴`. The bitmap tiers are skipped entirely without 24-bit color, so the glyph tiers are what most terminals show.

- Tier widths and row heights are load-bearing constants (`SHARK_LOGO_WIDTH`, `SHARK_COMPACT_WIDTH`, `FULL_MIN`, `MINIMAL_MIN`). Changing the art must update the matching width and key arrays together or centering (`indent()`/`center()`) breaks. Logo height also feeds the constellation row budget in `constellationBlock` (`maxRows`).
- Countershading comes from color, not glyph noise: per-row theme keys in `SHARK_LOGO_KEYS`/`SHARK_COMPACT_KEYS`, plus one `null`-keyed lateral-line row rendered by `lateralLine()`.
- Geometry is static on focus. When the orb (`observatory-orb.ts`) is active only the lateral line's color changes; the art arrays never vary by selection or focus state.
- Use narrow BMP block glyphs (`█ ▓ ▒ ░ ▀ ▄`) only, so blocks measure the same width on every terminal. No wide, ambiguous-width, or combining glyphs.
- Any silhouette change must stay recognizably a shark in profile at the full tier and keep the four compact-tier cues: dorsal fin, snout, belly, forked tail.

### Preview Harness

Do not iterate on this surface through screenshots. Use the harness:

```
node --experimental-transform-types agent/extensions/apex/lib/observatory-preview.mjs
node --experimental-transform-types agent/extensions/apex/lib/observatory-preview.mjs 80
```

- Renders three scenarios (populated user inventory, balanced project inventory, empty inventory) at 40/60/80/100/120/160 columns, or at the widths passed as arguments.
- Approximates apex-dark colors on a dark background so contrast and hierarchy can be judged directly in the terminal.
- Flags `TOO TALL` and `OVERFLOW` per scenario and exits nonzero when any bound fails.
- Check all three responsive tiers (>=62, 20-61, <20 columns) when touching the shark art, not just the default preview widths.
- Keep it in sync when `renderObservatory` or `buildObservatory` signatures change.

### Constraints

- `OBSERVATORY_MAX_LINES` is 25 (the startup-header budget, not the 10-line above-editor cap). Keep the composition dense rather than padded with blank lines.
- Pure passive string rendering only: no timers, no `requestRender()`, no Pi TUI `Text`, `Markdown`, or `Container`.
- Measure and truncate with `agent/extensions/apex/lib/safe-text-layout.ts` helpers, never `.length`.
- Color only through `theme.fg(key, text)`; use narrow BMP glyphs so centering matches real terminal cells.
- The workspace signal must stay truthful. Fall back to `AWAITING A SIGNAL` when no project-scoped resources exist.

## Rules

- Treat this directory as the active project when the request concerns custom Pi behavior or configuration.
- Inspect relevant configuration and implementation files before editing them.
- Make the smallest targeted change that satisfies the request.
- Preserve existing user changes and conventions.
- Do not expose secrets, tokens, credentials, browser profiles, or authentication data.
- Avoid editing generated or runtime data unless the user explicitly requests it. This includes caches, session history, browser state, `node_modules/`, and generated model stores.
- Keep temporary artifacts outside this directory unless they are intentional Pi configuration assets.
