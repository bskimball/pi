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
- Theme agent hues stay in amp-task (presentation of badges), not the catalog.

## Task: sync vs async

| | Sync (`amp-task.ts`) | Async (`async-task.ts`) |
|--|----------------------|-------------------------|
| Tool | `task` | `task_start`, `task_status`, `task_list`, `task_send`, `task_wait`, `task_abort`, `task_close`, `task_reply` |
| Child | `pi --mode json -p` subprocess, lifetime = process | Session-backed RPC worker |
| UI | Rich mission receipt (activities, models, report) | Bounded plain results + light list chrome |
| Shared | `discoverAgents`, `modelAttempts`, `readSharedFile`, `stderrDiagnostic`, task-card activity/tree helpers, `missionFromPrompt` / args helpers (`lib/task-view.ts`) | same catalog + view helpers, task-card helpers, WorkerRuntime policy |

Both respect concurrency caps and exclude nested task tools in children.

### Task card and worker runtime

- **Task Card**: `lib/task-card.ts` owns safe, width-aware shared primitives only: activity glyphs, duration-column text, tree row assembly/continuations, and bounded rail text. `amp-task.ts` retains its mission header/failure/report layout; `async-task.ts` retains its worker header/status/preview layout.
- **WorkerRuntime**: `lib/worker-runtime.ts` owns async worker policy (live/settled caps and idle budgets) and pure lifecycle/activity/capacity predicates. `async-task.ts` retains the worker map/order, RPC/process lifecycle, state mutation, and all `task_*` tool registration adapters.

## Shark identity surfaces

The mark is the Observatory splash identity, not a live animation during work.

- **Pixel art**: `lib/pixel-art.ts` owns the packed half-block cell decoder (`pixelCell`, `pixelRows`, `pixelCells`) and the truecolor gate for the landing mark. `lib/shark-art.ts` is **generated** — regenerate with `tools/shark-art/encode-shark.py`, never hand-edit.
- **Star field** (`lib/star-field.ts`): shape is the *project* (deterministically seeded from cwd, so a repo's constellation is stable across launches); density is the *context* (stars burn out as the window fills, faintest first, never to an empty sky).

Compaction uses Pi's built-in spinner only. Live async workers are surfaced through the normal task status cards and `task_*` tools, not an ornamental widget.

## Apex stability constraints

When changing Apex UI / task / receipt rendering:

1. No custom `setInterval` render loops; no extension-owned `tui.requestRender()` timers.
2. Editor may only repaint an existing border or replace padding cells — no inserted editor rows, no cursor/width math changes.
3. High-frequency surfaces: do **not** use pi-tui `Text`, `Markdown`, `Container`, `visibleWidth()`, or `truncateToWidth()` without proving Windows crash independence. Prefer `safe-text-layout` + `tool-receipt`.
4. Bound large tool/task output by line **and** character count.
5. Preserve task activity visibility; do not collapse subagents to a one-line summary unless diagnosing.
6. Emergency opt-out: `PI_APEX_UI=0`.
7. Renderer failures → `agent/pi-render.log` and degrade to short fallback text.

## Session todo list

- Tool registration and the model-visible payload: `agent/extensions/todo-list.ts`. Pure presentation: `agent/extensions/apex/lib/todo-list.ts`.
- Statuses: `pending`, `in_progress`, `blocked`, `completed`, `cancelled`. `done` is `completed + cancelled` only — **`blocked` is open work** and must never count toward it.
- Two distinct indices, deliberately not merged: `activeIndex` is the first `in_progress` item and drives emphasis/expansion styling; `anchorIndex` places the collapsed window and falls back `in_progress` → `blocked` → `pending`. Merging them would style blocked rows as active; reusing `activeIndex` for the window hides the only open item behind completed rows when nothing is in progress.
- `todo_write` returns the short summary line; `todo_read` returns a bounded per-item serialization (status, exact content, note). The split is intentional: read results re-enter context on every later turn, so only the explicit read pays that cost. Extension `details` feed the TUI and are **not** model-visible — anything the agent must read has to be in `content`.
- Render and boundedness guard: `agent/extensions/apex/lib/todo-list-preview.mjs`, run with `node --experimental-transform-types` (plain `node` fails on TS parameter properties). It asserts height/width caps, hostile-input tolerance, and blocked-item visibility.

## Continual memory

- Extension: `agent/extensions/continual-memory.ts`.
- Tools: `memory_list`, `memory_write` (create/update/delete).
- Kinds: `memory` (facts/preferences/failures) and `prompt` (narrow policy addendums only).
- Local store: session custom entry `continual-memory-local` (survives resume).
- Global store: `agent/harness/global.json` (gitignored runtime state).
- Injected each turn via `before_agent_start` as a compact overview; never rewrites `SYSTEM.md`.

## Intentionally deferred

- Full **WorkerRuntime** extraction of `async-task.ts` (~2.4k LOC): worker state machine, map/order registry, RPC lifecycle, and tool registration remain in `async-task.ts`; only policy and pure predicates are extracted.
- Task **rendering** headers, badges, failures, and mission-report formatting still live in amp-task / async-task; `task-card` shares only safe tree/activity primitives.
- Theme **agentHue** remains amp-task-local.

## Secrets

Never put API keys, tokens, or credentials in receipt details, logs, or this file. Web receipts scrub key-shaped strings via `scrubSecrets`.
