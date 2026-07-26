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

## Mono UI Stability Work

The Windows Pi TUI has had intermittent renderer failures during long or resumed sessions, especially around large tool results and session transitions. Historical failures include `TypeError: segment.codePointAt is not a function` in `@earendil-works/pi-tui/dist/utils.js` and invalid Markdown token data.

### Current A/B Observation

- The currently running Pi process loaded the temporary presentation-reduced implementation and has remained stable.
- The files on disk now contain the restored presentation layer. They take effect after `/reload` or a Pi restart.
- Treat the first restarted session as an A/B test. If crashes resume after the restored presentation layer loads, consider the custom presentation layer implicated even if noninteractive smoke tests pass.
- Do not dismiss a renewed crash as a Surveyor or provider failure without checking the render evidence first.
- Avoid `/reload` before intentionally beginning this test, because it replaces the stable in-memory baseline with the restored implementation.

### Implemented Changes

- `agent/extensions/mono-ui.ts`
  - Mono UI is enabled by default; `PI_MONO_UI=0` is the emergency opt-out.
  - Restored styled built-in `read`, `bash`, `edit`, and `write` rows, bounded output previews, edit/write statistics, expanded diffs, the context footer, and randomized Braille working animation.
  - Uses a minimal `CustomEditor` subclass only to repaint the existing top border gray and replace the two leading padding cells with an accent `❯` prompt. It does not insert rows or alter editor width/cursor calculations.
  - Uses Pi's built-in working indicator rather than extension-owned render scheduling.
  - Renderer failures are written to `agent/pi-render.log` and degrade to bounded fallback output.
- `agent/extensions/amp-task.ts`
  - Bare model overrides inherit the agent's primary provider.
  - Explicit overrides retain declared fallbacks while excluding the default primary.
  - Subprocess errors preserve decisive stderr diagnostics and child processes receive agent/model environment metadata.
  - Restored rich task presentation: specialist badges, mission, model, thinking level, turn count, live tool activities, durations, failures, and bounded final reports.
  - Task rendering is one flat width-aware component. It does not use Markdown, nested renderer containers, or extension-owned render timers.
- `agent/lib/safe-text-layout.ts` and `agent/lib/ui-common.ts`
  - Custom surfaces use dependency-free, ANSI-aware width calculation and truncation instead of Pi TUI's `Intl.Segmenter` path.
  - Unsupported bare escape bytes are dropped; styled output is retained.
- `agent/extensions/crash-logger.ts`
  - Distinguishes main Pi and subagent processes and records code-0 exits, shutdown reasons, stderr/stdout errors, and unhandled rejections in `agent/pi-crash.log`.

### Stability Constraints

When modifying Mono UI or task rendering:

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
4. Run once with `PI_MONO_UI=0`. If that is stable, isolate presentation surfaces incrementally rather than removing all task visibility again.
5. Prefer disabling one restored surface at a time in this order: final task-report styling, live task activity presentation, built-in tool presentation, footer, working-indicator styling.
6. Keep editor customization limited to in-place border/padding repainting and keep all rendering timer-free throughout the investigation.

## Rules

- Treat this directory as the active project when the request concerns custom Pi behavior or configuration.
- Inspect relevant configuration and implementation files before editing them.
- Make the smallest targeted change that satisfies the request.
- Preserve existing user changes and conventions.
- Do not expose secrets, tokens, credentials, browser profiles, or authentication data.
- Avoid editing generated or runtime data unless the user explicitly requests it. This includes caches, session history, browser state, `node_modules/`, and generated model stores.
- Keep temporary artifacts outside this directory unless they are intentional Pi configuration assets.
- This directory is not currently a Git worktree; do not assume Git-based validation or rollback is available.
