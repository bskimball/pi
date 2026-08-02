# CONTEXT.md — Pi custom configuration architecture

Domain vocabulary and seams for `~/.pi`. Runtime behavior lives under `agent/`; reference material under `reference/`.

## Layout

| Path | Role |
|------|------|
| `agent/extensions/` | Pi extensions (Apex UI, tasks, web search, MCP) |
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
- Shared files: `_shared.md` (preamble), `_handoff.md` (subagent append); project overrides global.
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

The mark is not decoration confined to the splash; it carries state on four surfaces.

- **Pixel art**: `lib/pixel-art.ts` owns the packed half-block cell decoder (`pixelCell`, `pixelRows`, `pixelCells`) and the truecolor gate, shared by every sprite. `lib/shark-art.ts` (landing mark) and `lib/fin-art.ts` (dorsal fin) are both **generated** — regenerate with `tools/shark-art/encode-shark.py` and `tools/shark-art/encode-fin.py`, never hand-edit. The fin is a crop of the mark's own first-dorsal polygon, so the two can never drift apart stylistically.
- **Fleet waterline** (`lib/fleet-waterline.ts`): one fin per live async worker, so the 3-worker cap and a stalled worker are visible without running `task_list`. Fin speed is worker event rate; a worker awaiting a UI reply holds station. Fed from `syncFleet()` in `async-task.ts`, called from `notifySubscribers` — the single chokepoint for worker state change.
- **Star field** (`lib/star-field.ts`): shape is the *project* (deterministically seeded from cwd, so a repo's constellation is stable across launches); density is the *context* (stars burn out as the window fills, faintest first, never to an empty sky).
- **Dive** (`lib/dive.ts`) and **re-entry** (`lib/reentry.ts`): compaction as a descent that surfaces with the pre-compaction size (the only figure knowable at that point), and a one-line orientation row when an existing session is resumed. Both are `setWidget` surfaces retired on the next user input.

Pi builds its own compaction spinner internally (`CompactionStatusIndicator`) and exposes **no** API to restyle it, so the dive is an additional widget alongside it, not a replacement. Restyling it requires an upstream change. Because that spinner already carries the words, the dive renders no text while descending.

## Apex stability constraints

When changing Apex UI / task / receipt rendering:

1. No custom `setInterval` render loops; no extension-owned `tui.requestRender()` timers — **except the two motion surfaces below**, which are the only sanctioned clocks in Apex. Do not add a third without the same justification.
   - `lib/fleet-waterline.ts` — per-worker fin positions; nothing in Pi drives them. Starts on the first live worker, cleared when the live set empties, on `dispose()`, and on `session_shutdown`.
   - `lib/dive.ts` — compaction descent. Starts on `session_before_compact`, stopped on `session_compact`; the surfaced result row is static and holds no clock. The descent has no terminal state: real compactions run tens of seconds, so the mark bobs and sways indefinitely rather than landing, and bubbles rise past it. Verify changes over a full 30s budget, not just the first second.
   - Both `unref()` their interval so an ornament never holds the process open, and both are reached only through `ctx.ui.setWidget`, so Pi's widget teardown calls `dispose()`.
2. Editor may only repaint an existing border or replace padding cells — no inserted editor rows, no cursor/width math changes.
3. High-frequency surfaces: do **not** use pi-tui `Text`, `Markdown`, `Container`, `visibleWidth()`, or `truncateToWidth()` without proving Windows crash independence. Prefer `safe-text-layout` + `tool-receipt`.
4. Bound large tool/task output by line **and** character count.
5. Preserve task activity visibility; do not collapse subagents to a one-line summary unless diagnosing.
6. Emergency opt-out: `PI_APEX_UI=0`.
7. Renderer failures → `agent/pi-render.log` and degrade to short fallback text.

## Intentionally deferred

- Full **WorkerRuntime** extraction of `async-task.ts` (~2.4k LOC): worker state machine, map/order registry, RPC lifecycle, and tool registration remain in `async-task.ts`; only policy and pure predicates are extracted.
- Task **rendering** headers, badges, failures, and mission-report formatting still live in amp-task / async-task; `task-card` shares only safe tree/activity primitives.
- Theme **agentHue** remains amp-task-local.

## Secrets

Never put API keys, tokens, or credentials in receipt details, logs, or this file. Web receipts scrub key-shaped strings via `scrubSecrets`.
