# CONTEXT.md — Pi custom configuration architecture

Domain vocabulary and seams for `~/.pi`. Runtime behavior lives under `agent/`; reference material under `reference/`.

## Layout

| Path | Role |
|------|------|
| `agent/extensions/` | Pi extensions (Apex UI, tasks, web search, continual memory, MCP) |
| `agent/extensions/apex/` | Apex package: UI, sync/async tasks, shared `lib/` |
| `agent/agents/` | Specialist agent markdown catalog |
| `agent/prompts/`, `agent/skills/`, `agent/themes/` | Prompts, skills, themes |
| `agent/SYSTEM.md` | System instructions |
| `AGENTS.md` | Agent/workspace rules (incl. Apex stability) |

## Extension seams

- Each Pi extension receives its **own** `ExtensionAPI` / tool map.
- Cross-extension interception is impossible: if extension A wraps `registerTool` on its API, extension B’s registrations are unaffected.
- **MCP same-API composition**: `mcp-adapter.ts` installs Apex MCP presentation on *its* `pi`, then boots `pi-mcp-adapter` on that same instance so proxy/direct tools get Apex receipts.
- Prefer lib imports (`apex/lib/*`) over loading `apex-ui.ts`’s default export when only helpers are needed (avoids UI side effects).

## Presentation gate (default UI vs Apex)

- **Gate**: `apex/lib/presentation.ts` — `apexPresentationEnabled()` / `withApexPresentation(renderers)`.
- Same emergency opt-out as Apex UI: `PI_APEX_UI=0` disables custom tool/task chrome **and** skips `apex-ui` interactive layout.
- When disabled, tools omit `renderCall` / `renderResult` / `renderShell: "self"` so Pi’s default boxed renderer shows the model-facing `content` text. Domain logic, `details` payloads, and tool registration stay loaded either way.
- Consumers spread `...withApexPresentation({ renderShell: "self", renderCall, renderResult })` (or return that object from a local `receipt` / `controlRenderers` helper). Settlement message renderers return `undefined` when the gate is off so Pi falls through to default custom-message display.
- **Apex-only surfaces** (Observatory, working-indicator chrome, builtin read/bash/write receipts, Mission/Worker cards) live under `apex/*` and must not be required for tool correctness in default UI.

## Tool receipt

- **Receipt** = one-row tool chrome: call blanking, status glyph, title, primary arg, optional stats, duration, collapsed rail preview, expanded padded body.
- **Engine**: `agent/extensions/apex/lib/tool-receipt.ts` — `toolRenderers(spec)`, `StableText`, `paddedSection`, `boundedOutput`, `reportRenderFailure`.
- **Specs** supply identity/arg/preview/body/stats/scrub; the engine owns glyphs, timing, expand chrome, failure wrappers.
- Consumers:
  - Web: `lib/web-search-ui.ts` (specs + `scrubSecrets`)
  - MCP: `lib/mcp-presentation.ts` (`installMcpPresentation`)
  - Built-ins: `apex-ui.ts` (read/bash/edit/write via the same engine)
- **Edit diffs**: `lib/edit-diff.ts` (numbered contextual diff, stats, intra-line highlights).

## Agent catalog

- Canonical discovery: `lib/agent-discovery.ts`.
- Directories: `getAgentDir()/agents` (global) and `process.cwd()/.pi/agents` (project override; later wins on name).
- Frontmatter → `AgentDef` (model, fallbacks, thinking, tools, turns, timeout, skills, body).
- Shared files: `_shared.md` (common preamble), `_shared-sync.md` / `_shared-async.md` (worker-mode semantics), `_handoff.md` (visible final-report requirement); project overrides global independently per file.
- `modelAttempts(def, override?)` builds the try chain; empty chain returns `[undefined]` so a default-model attempt still runs.
- Role boundary: `artisan` owns substantial UI implementation and design judgment; `inspector` is the cheap, read-only post-implementation verifier for bounded browser, viewport, interaction, screenshot, and visual-regression checks.
- Theme agent hues stay in amp-task (presentation of badges), not the catalog.

## Task: sync vs async

| | Sync (`amp-task.ts`) | Async (`async-task.ts`) |
|--|----------------------|-------------------------|
| Tool | `task` | `task_start`, `task_status`, `task_list`, `task_send`, `task_wait`, `task_abort`, `task_close`, `task_reply` |
| Child | `pi --mode json -p` subprocess, lifetime = process | Session-backed RPC worker |
| UI | Rich mission receipt (activities, models, report) | Bounded plain results + light list chrome |
| Shared | `discoverAgents`, `modelAttempts`, `readSharedFile`, `stderrDiagnostic`, task-card activity/tree helpers, `missionFromPrompt` / args helpers (`lib/task-view.ts`) | same catalog + view helpers, task-card helpers, `WorkerRuntime` control plane |

Both respect concurrency caps and exclude nested task tools in children.

### Task card and worker runtime

- **Task Card**: `lib/task-card.ts` owns safe, width-aware shared primitives only: activity glyphs, duration-column text, tree row assembly/continuations, and bounded rail text. `amp-task.ts` retains its mission header/failure/report layout; `async-task.ts` retains its worker header/status/preview layout (behind the presentation gate).
- **ActivityLedger**: `lib/activity-ledger.ts` owns overlapping tool-activity bookkeeping (identified-by-id vs anonymous LIFO) for both Missions (`amp-task`) and Workers (`async-task`). Async idle phase/budget control is owned by `WorkerRuntime`; the sync mission host arms the same exported budgets locally.
- **JobRegistry**: `lib/job-registry.ts` owns ordered map + settled-capacity pruning used by async workers and `bg-process`.
- **ProcessTree**: `lib/process-tree-kill.ts` is the sole reaping module (`killProcessTree` / `killProcessTreeSync`, optional POSIX `processGroup`). Call sites: async-task, amp-task, bg-process (`processGroup: true`), powershell.
- **WorkerRuntime**: `lib/worker-runtime.ts` is the async worker control plane. It owns registry/capacity, bounded errors, activity closure, subscriber invalidation, hard/idle/abort timers, force-kill/escalation, generation start/settlement, and RPC lifecycle transitions for agent, turn, tool, message, retry, compaction, queue, and UI-request events. `async-task.ts` supplies model-fallback/circuit and Pi-notification policy through hooks, and retains RPC transport spawning, waiter/result formatting, and `task_*` registration adapters. `lib/task-compaction-policy.ts` owns the parent-context reserve boundary used by timed-out waits.

## Shark identity surfaces

The mark is the Observatory splash identity, not a live animation during work.

- **Pixel art**: `lib/pixel-art.ts` owns the packed half-block cell decoder (`pixelCell`, `pixelRows`, `pixelCells`) and the truecolor gate for the landing mark. `lib/shark-art.ts` is **generated** — regenerate with `tools/shark-art/encode-shark.py`, never hand-edit.
- **Star field** (`lib/star-field.ts`): shape is the *project* (deterministically seeded from cwd, so a repo's constellation is stable across launches); density is the *context* (stars burn out as the window fills, faintest first, never to an empty sky).

Compaction uses Pi's built-in spinner only. Live async workers are surfaced through the normal task status cards and `task_*` tools, not an ornamental widget. Pi only checks automatic compaction between agent runs, so a `task_wait` timeout at the configured compaction reserve boundary requests termination of its sequential tool-only run without aborting the worker; this creates a safe compaction boundary before another polling turn. Worker registries remain process-local, so an actual parent-process exit still loses handle continuity.

## Apex stability constraints

When changing Apex UI / task / receipt rendering:

1. No custom `setInterval` render loops; no extension-owned `tui.requestRender()` timers.
2. Editor may only repaint an existing border or replace padding cells — no inserted editor rows, no cursor/width math changes.
3. High-frequency surfaces: do **not** use pi-tui `Text`, `Markdown`, `Container`, `visibleWidth()`, or `truncateToWidth()` without proving Windows crash independence. Prefer `safe-text-layout` + `tool-receipt`.
4. Bound large tool/task output by line **and** character count.
5. Preserve task activity visibility; do not collapse subagents to a one-line summary unless diagnosing.
6. Emergency opt-out: `PI_APEX_UI=0` (also strips Apex tool/task receipts via the presentation gate).
7. Renderer failures → `agent/pi-render.log` and degrade to short fallback text.

## Session todo list

- Tool registration and the model-visible payload: `agent/extensions/todo-list.ts`. Pure presentation: `agent/extensions/apex/lib/todo-list.ts`.
- Statuses: `pending`, `in_progress`, `blocked`, `completed`, `cancelled`. `done` is `completed + cancelled` only — **`blocked` is open work** and must never count toward it.
- Two distinct indices, deliberately not merged: `activeIndex` is the first `in_progress` item and drives emphasis/expansion styling; `anchorIndex` places the collapsed window and falls back `in_progress` → `blocked` → `pending`. Merging them would style blocked rows as active; reusing `activeIndex` for the window hides the only open item behind completed rows when nothing is in progress.
- `todo_write` returns the short summary line; `todo_read` returns a bounded per-item serialization (status, exact content, note). The split is intentional: read results re-enter context on every later turn, so only the explicit read pays that cost. Extension `details` feed the TUI and are **not** model-visible — anything the agent must read has to be in `content`.
- Render and boundedness guard: `agent/extensions/apex/lib/todo-list-preview.mjs`, run with `node --experimental-transform-types` (plain `node` fails on TS parameter properties). It asserts height/width caps, hostile-input tolerance, and blocked-item visibility.

## Continual memory

- Extension adapter: `agent/extensions/continual-memory.ts` (tools, session inject, receipts).
- **MemoryStore** module: `apex/lib/memory-store.ts` (normalize/load/lock/mutate/overview; local + global adapters).
- Tools: `memory_list`, `memory_write` (create/update/delete).
- Kinds: `memory` (facts/preferences/failures) and `prompt` (narrow policy addendums only).
- Local store: session custom entry `continual-memory-local` (survives resume).
- Global store: `agent/harness/global.json` (gitignored runtime state).
- Injected each turn via `before_agent_start` as a compact overview; never rewrites `SYSTEM.md`.

## Shared tool helpers

- `apex/lib/tool-result.ts`: `textResult`, `resolveCwd`, `validateCwd` for extensions that need consistent model-facing payloads.
- `apex/lib/unified-edit.ts`: deep planner exports `buildPlan` / `preflightPlan` / `applyPlan` (+ types); tool registration remains the thin adapter at the file default export (receipts behind presentation gate).

## Intentionally deferred

- `async-task.ts` intentionally retains the transport and adapter seams around `WorkerRuntime`: `RpcClient` spawn/exit wiring, provider-specific fallback session replacement, waiter snapshots, result formatting, and `task_*` registration. These depend directly on Pi/RPC APIs rather than generic worker state transitions.
- Task **rendering** headers, badges, failures, and mission-report formatting still live in amp-task / async-task; `task-card` shares only safe tree/activity primitives.
- Theme **agentHue** remains amp-task-local.
- Deepening **TaskCard** into one view→lines module for Mission + Worker parity (presentation gate already separates Apex chrome from default UI).

## Secrets

Never put API keys, tokens, or credentials in receipt details, logs, or this file. Web receipts scrub key-shaped strings via `scrubSecrets`.
