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

The Windows Pi TUI has had intermittent renderer failures during long or resumed sessions, especially around large tool results and session transitions. Historical failures include `TypeError: segment.codePointAt is not a function` in `@earendil-works/pi-tui/dist/utils.js` and invalid Markdown token data.

### Current A/B Observation

- The currently running Pi process loaded the temporary presentation-reduced implementation and has remained stable.
- The files on disk now contain the restored presentation layer. They take effect after `/reload` or a Pi restart.
- Treat the first restarted session as an A/B test. If crashes resume after the restored presentation layer loads, consider the custom presentation layer implicated even if noninteractive smoke tests pass.
- Do not dismiss a renewed crash as a Surveyor or provider failure without checking the render evidence first.
- Avoid `/reload` before intentionally beginning this test, because it replaces the stable in-memory baseline with the restored implementation.

### Implemented Changes

- `agent/extensions/apex/apex-ui.ts`
  - Apex UI is enabled by default; `PI_APEX_UI=0` is the emergency opt-out.
  - Restored styled built-in `read`, `bash`, `edit`, and `write` rows, bounded output previews, edit/write statistics, expanded diffs, the context footer, and randomized Braille working animation.
  - Uses a minimal `CustomEditor` subclass only to repaint the existing top border gray and replace the two leading padding cells with an accent `❯` prompt. It does not insert rows or alter editor width/cursor calculations.
  - Uses Pi's built-in working indicator rather than extension-owned render scheduling.
  - Renderer failures are written to `agent/pi-render.log` and degrade to bounded fallback output.
- `agent/extensions/apex/amp-task.ts`
  - Bare model overrides inherit the agent's primary provider.
  - Explicit overrides retain declared fallbacks while excluding the default primary.
  - Subprocess errors preserve decisive stderr diagnostics and child processes receive agent/model environment metadata.
  - Restored rich task presentation: specialist badges, mission, model, thinking level, turn count, live tool activities, durations, failures, and bounded final reports.
  - Task rendering is one flat width-aware component. It does not use Markdown, nested renderer containers, or extension-owned render timers.
- `agent/extensions/apex/lib/safe-text-layout.ts` and `agent/extensions/apex/lib/ui-common.ts`
  - Custom surfaces use dependency-free, ANSI-aware width calculation and truncation instead of Pi TUI's `Intl.Segmenter` path.
  - Unsupported bare escape bytes are dropped; styled output is retained.
- `agent/extensions/crash-logger.ts`
  - Distinguishes main Pi and subagent processes and records code-0 exits, shutdown reasons, stderr/stdout errors, and unhandled rejections in `agent/pi-crash.log`.

### Stability Constraints

When modifying Apex UI or task rendering:

- Do not add custom `setInterval()` rendering loops or call `tui.requestRender()` on a presentation timer.
- The editor may only repaint an existing border or replace existing padding cells. Do not insert editor rows, change rendered line counts, or alter cursor/layout width calculations.
- Do not use Pi TUI `Text`, `Markdown`, `Container`, `visibleWidth()`, or `truncateToWidth()` in high-frequency custom tool/task/footer rendering without first proving the Windows crash is unrelated.
- Keep large tool and task output bounded in both line count and character count.
- Preserve task activity visibility. A stability fix must not collapse subagents to a one-line summary unless explicitly used as a diagnostic fallback.
- Validate with a large Bash result and a real delegated `task`, but remember that noninteractive tests do not prove interactive Windows Terminal stability.

### If the Restarted Session Crashes

1. Preserve the session and worktree; do not discard application changes.
2. Inspect `agent/pi-crash.log`, `agent/pi-render.log`, and the final session events.
3. Record whether the exit happened during a tool-result, task-update, footer, working-indicator, or session-transition render.
4. Run once with `PI_APEX_UI=0`. If that is stable, isolate presentation surfaces incrementally rather than removing all task visibility again.
5. Prefer disabling one restored surface at a time in this order: final task-report styling, live task activity presentation, built-in tool presentation, footer, working-indicator styling.
6. Keep editor customization limited to in-place border/padding repainting and keep all rendering timer-free throughout the investigation.

## Observatory Landing Screen

The blank-chat landing screen ("Observatory") lives in `agent/extensions/apex/lib/observatory.ts` and is mounted by `agent/extensions/apex/apex-ui.ts` via `ctx.ui.setHeader(...)` as Pi's startup header (not an above-editor widget), so with quiet startup it IS the opening screen and has no 10-line above-editor cap. `OBSERVATORY_MAX_LINES` is 22, matching this budget.

### Cosmic Shark Design Direction

The former Pi block-art wordmark is now a hand-authored side-profile great white shark, swimming left, sitting on a quiet star field. The direction is restrained cosmic, not decorative: existing theme roles and layout rhythm are unchanged, only the mark's silhouette and coloring changed.

- **Responsive tiers** (`agent/extensions/apex/lib/observatory.ts`, `logoBlock`):
  - `width >= FULL_MIN` (62 cols): full `SHARK_LOGO`, 7 rows × 56 columns (`SHARK_LOGO_WIDTH`). Drawn on a 14 × 56 half-block sub-grid: pointed snout, eye, open mouth, three gill slits, long torpedo trunk, tall triangular dorsal about a third back from the snout, pectoral raked down and back, a long rear taper into a narrow peduncle, and a large asymmetric crescent tail with a long swept upper lobe over a short lower one.
  - `MINIMAL_MIN <= width < FULL_MIN` (20–61 cols): `SHARK_COMPACT`, 4 rows × 18 columns, cut down to triangular dorsal, tapered snout, thick trunk, raked pectoral, crescent tail.
  - `width < MINIMAL_MIN` (< 20 cols): `SHARK_MINIMAL`, a single `▴` dorsal-fin glyph.
- **Countershading is carried by color, not glyph noise**: dark violet back, a luminous lateral line (`lateralLine()`, violet→cyan→violet horizontal gradient) through the flank, pale belly, and a soft wake — via `SHARK_LOGO_KEYS`/`SHARK_COMPACT_KEYS` per-row theme keys plus the one `null`-keyed lateral-line row.
- **Geometry is static on focus.** When the orb (`observatory-orb.ts`) is active, only the lateral line's color changes (to a single live `accent`, replacing the resting gradient); the art arrays themselves never change per selection or focus state.
- All art stays narrow BMP block glyphs (`█ ▓ ▒ ░ ▀ ▄`) so blocks measure the same fixed width on every terminal; do not introduce wide/ambiguous-width or combining glyphs.
- Widths and row heights above (56/18/1 columns, 7/4/1 rows) are load-bearing constants (`SHARK_LOGO_WIDTH`, `SHARK_COMPACT_WIDTH`, `FULL_MIN`, `MINIMAL_MIN`). Changing the art must update the matching width/key arrays together, or centering (`indent()`/`center()`) breaks. The logo height also feeds the constellation row budget in `constellationBlock` (`maxRows`).

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

- `OBSERVATORY_MAX_LINES` is 22 (the startup-header budget, not the 10-line above-editor cap). Keep the composition dense rather than padded with blank lines.
- Pure passive string rendering only: no timers, no `requestRender()`, no Pi TUI `Text`, `Markdown`, or `Container`.
- Measure and truncate with `agent/extensions/apex/lib/safe-text-layout.ts` helpers, never `.length`.
- Color only through `theme.fg(key, text)`; use narrow BMP glyphs so centering matches real terminal cells.
- The workspace signal must stay truthful. Fall back to `AWAITING A SIGNAL` when no project-scoped resources exist.
- Any change to the shark's silhouette must keep it recognizably a shark in profile at the full tier and preserve the four compact-tier cues (dorsal fin, snout, belly, forked tail); geometry must stay identical between resting and focused states.

## Rules

- Treat this directory as the active project when the request concerns custom Pi behavior or configuration.
- Inspect relevant configuration and implementation files before editing them.
- Make the smallest targeted change that satisfies the request.
- Preserve existing user changes and conventions.
- Do not expose secrets, tokens, credentials, browser profiles, or authentication data.
- Avoid editing generated or runtime data unless the user explicitly requests it. This includes caches, session history, browser state, `node_modules/`, and generated model stores.
- Keep temporary artifacts outside this directory unless they are intentional Pi configuration assets.
- This directory is not currently a Git worktree; do not assume Git-based validation or rollback is available.
