# CONTEXT.md — Pi custom configuration architecture

Domain vocabulary and seams for `~/.pi`. Runtime behavior lives under `agent/`; reference material under `reference/`.

## Extension layout

```text
agent/extensions/
├── apex/                   # Apex UI extension (shark Observatory, braille indicator)
├── claude/                 # Claude UI extension (star motifs, Claude verbs)
├── hal/                    # HAL UI extension (orb landing, square glyphs)
packages/ui-kit/            # shared presentation package (not a Pi extension)
├── task/                   # standalone sync + async delegation
│   ├── amp-task.ts
│   ├── async-task.ts
│   ├── presentation/       # Task-owned essential activity UI
│   └── runtime/
├── lsp/                    # standalone LSP extension
├── crash-logger/           # crash/watchdog implementation
├── bg-process/             # background-process implementation
├── continual-memory/       # memory storage implementation
├── prompt-commands/        # browser/deploy command implementation
├── at-path-complete.ts     # scoped @ listing that ignores gitignore
└── top-level adapters      # stock-rendered independent extensions
```

There is no cross-extension `shared/` source dependency.

## Standalone rule

Every extension entry may import only:

- files owned by that extension,
- Node built-ins,
- Pi's public packages, and
- declared npm dependencies.

It must not import another extension's source tree. Small process, bounding, or safety helpers are intentionally duplicated when two independently removable extensions need the same behavior.

Directory packages (`apex`, `task`, `lsp`) declare their entry points in their own `package.json`. Top-level extension files own same-named support directories where required.

## Presentation ownership

- Apex, Claude, and HAL are three installable UI extensions. Shared TREE receipts, layout, todo tools, and the single `ToolExecutionComponent` wrap live in `packages/ui-kit` (import `@pi/ui-kit`). That package is not a Pi extension and must not live under `agent/extensions/shared`.
- Kit receipts cover the Pi-owned `read`, `edit`, `grep`, and `ls` built-ins through `registerHeadlessReceipt(..., { overrideOwned: true })`; Pi keeps execution. `bash` and `write` are re-registered in the kit because execute is wrapped (write captures a diff).
- Each UI owns landing art, glyphs, working indicator, footer, and theme. `/ui` (owned by the presentation-switch module) selects among installed UIs (`pi` is always available) and fails closed if the target directory is missing. `PI_UI_SKIN` still names the active look so a live switch applies without restart. Unset or unrecognized values fall back to Apex glyphs. Only the kit wraps `ToolExecutionComponent` (once). Kit tools, shortcuts, Observatory commands, and landing art register through a process-interned bag because Pi imports each UI with jiti `moduleCache: false`. Tools/shortcuts/commands attach to the first loaded UI extension's `pi`; later skins only join the shared hosts and landings maps.
- Other tools use Pi's stock tool renderer and return bounded plain text plus structured details where useful.
- The kit collects the footer snapshot from Pi events (never during render) and installs one footer per active UI; each UI supplies its own pure `buildFooter` renderer (at most 3 lines). A throwing renderer falls back to one plain line. `/ui pi` and `PI_UI_CHROME=0` restore Pi's stock footer.
- Task owns one narrow exception: essential standalone delegated-worker activity cards and notices. They work with Apex absent, have their own `PI_TASK_UI=0` switch, and also honor the installation-wide `PI_UI_CHROME=0` emergency presentation opt-out (`PI_APEX_UI=0` alias).
- Todo tools and the docked above-editor panel live in the kit. Styled chrome follows the active UI; under `PI_UI_CHROME=0` the dock stays as a plain list.
- `PI_UI_CHROME=0` is the emergency opt-out for every custom presentation surface. `PI_APEX_UI=0` remains a deprecated alias; when both are set, `PI_UI_CHROME` wins. It disables custom UI chrome and Task cards without disabling either extension's tool behavior.
- Rendering remains passive and event-driven. No extension presentation timer calls `requestRender()`.

## Todo dock

One `aboveEditor` widget (`todo-list`) owned by the kit. Live async workers share that slot as an Agents tab; Task publishes snapshots on `globalThis.__piTaskFleetBus` and the kit listens — no cross-extension import, no extra footer rows.

Snapshots carry structural liveness (`phase`, running `tool`, bounded activity target, `turns`/`maxTurns`, `generation`, resolved `model`, `waitingUi`, `mission`, `directive`, `fusion`) bounded at publish time. `directive` is the last `task_send` steer or follow_up for this generation: `queued: true` until the child queue drains (steer at the next model-call boundary; follow_up only after settle, when the next generation starts). Rows show `queued: <text>` vs plain `<text>` so a pending steer is never the current task. `waitingUi` still owns the state column (`waiting for reply`); then directive, then mission. `fleetSnapshotKey()` covers those fields so a tool change, turn, or directive-only update repaints, while raw `lastEventAt` heartbeats still do not — the dock updates through `requestHostRender()`, never a remount or a timer. Live workers are listed first; bounded settled/failed history fills remaining slots so its transcript remains reachable. The full-pane view keeps labeled mission and directive lines plus the resolved model in its header; the directive yields before the transcript window disappears, and `peekTranscriptBudget` counts the same chrome as the renderer. Peek transcript tones mirror the main session: lead steers read as warning, worker prose as primary text, worker tool lines as muted, and bare tool lines as accent.

| Trigger | Effect |
| --- | --- |
| `todo_write` / `todo_read` | Mount or refresh the Todos pane. |
| Live `task_start` / `task_chain` worker | Mount `[todos] / [agents N]`. Agents-only sessions open on Agents. |
| Lone Fusion sidekick (`fusion`, 1 worker) | Mount the same Agents tab used by every mode. |
| `alt+t` or `/todos` | Collapse or expand the dock. |
| `alt+a` | Toggle Todos / Agents when chrome is on. |
| `/agents` | Switch to Agents. Click a row or press Enter for an opaque full-pane agent workspace (read-only JSONL tail that fully occludes the parent transcript). Esc/q returns to the lead without aborting the worker. |
| Settled/failed worker | Keep bounded history visible. From the workspace, `o` prepares `/agents open <id>` without replacing any non-empty draft; `/agents peek <id>` can switch directly from its command context. Running workers remain read-only (`session still writing`). Switching sessions runs task shutdown and closes every retained worker, so the UI requires confirmation when any other worker is still live. |
| Last retained worker is closed/pruned | Drop the Agents tab; clear the dock if no todo list remains. |
| `PI_UI_CHROME=0` (alias `PI_APEX_UI=0`) | Plain todo list only. No tabs; `alt+t` / `alt+a` / `/todos` / `/agents` stay registered but inactive, so a later live switch can enable them. |

## Behavior-mode transitions

The behavior-mode transition module in `prompt-commands/modes.ts` owns staged model/thinking selection, active tools, session choices, and global defaults. Fusion waits for the task-owned persistent-sidekick configuration acknowledgement before persistence and announces the new mode last. The configured model pair and transcript lifecycle are Fusion's. Work uses a standalone operations-first prompt with a closed four-specialist roster (strategist, researcher, author, clerk) and dispatches inline-first; Fusion retains its closed roster. Failed transitions restore the prior selection; incomplete recovery blocks input until a successful `/mode` switch. `/model` alone cannot clear that recovery block.

Presentation remains independent: `pi:ui:changed` lets the active UI host refresh chrome without changing execution, active tools, or the stored plan. Claude uses a per-run verb from a documented Claude Code phrase subset. HAL uses geometric square activity with a neutral working label and a static HAL lens-orb landing instead of the shark/star field; Pi still owns animation timing.

## Task extension

| | Sync (`task/amp-task.ts`) | Async (`task/async-task.ts`) |
|--|---------------------------|------------------------------|
| Tool interface | `task` | `task_start`, `task_status`, `task_list`, `task_send`, `task_wait`, `task_abort`, `task_close`, `task_reply`, `task_chain` |
| Child | `pi --mode json -p` subprocess | session-backed RPC worker |
| Runtime | local subprocess host | `task/runtime/worker-runtime.ts` control plane |
| Presentation | bounded Task-owned activity card | bounded Task-owned worker activity |

Task owns specialist discovery, subprocess environment, process-tree reaping, transport/framing, lifecycle policy, output bounds, and presentation. Both task modes cap child concurrency, exclude nested task tools, and bound stored output.

The **Fusion sidekick lifecycle module** (`task/runtime/fusion-lifecycle.ts`) owns the configured pair, designated-worker reuse, configuration acknowledgement/rollback, parking, parent-session isolation, and tool gates. `async-task.ts` retains process spawn and RPC framing; `worker-runtime.ts` enforces Fusion's idle-timeout exemption through every generation/event path. Rejected prompts settle; unknown prompt acceptance requires abort/closure before releasing the single-writer gate. Saved transcripts are parent-scoped; a missing saved file is an error, never a silent context reset. Reuse is context-bounded: an idle sidekick or restored transcript over `FUSION_REUSE_CONTEXT_TOKENS` (100k, from last assistant usage or `get_session_stats`) starts clean and the `task_start` receipt says so; unknown size keeps the transcript.

### `/dispatch <request>`

Command for steering the active parent orchestrator with concurrent requests or priority shifts while workers run:

- **Target & Scope**: Directs additional work to the **same orchestrator** session. The command itself assigns no worker; the orchestrator routes the request under the active delegation policy (Apex inline-by-default, Apex Orchestrate specialist-first, Fusion through its sidekick(s)) — delegating via `task_start` with the correct specialist (artisan for visual/UI, machinist for code, scribe for prose) when it outgrows trivial glue. It preserves active work, steers existing workers, or delegates in isolated worktrees. Substantial inline work ahead of running workers is out of scope. Ordinary chat messages remain unchanged.
- **Recording & Delivery**: Records an `async-task-dispatch` entry in the session log and requests steering via hidden custom message (`deliverAs: "steer"`, `triggerTurn: true`).
- **Interruption Semantics**:
  - Active `task_wait` yields immediately on dispatch without aborting the worker and without applying a timeout or cooldown. The orchestrator absorbs the dispatch and can reconnect later via `task_wait`.
  - For active inference or other executing tools, steering is delivered at the next safe turn boundary.
- **Reliability & Guarantees**: Steering is requested in-process and best-effort; there is no confirmed delivery receipt, durable recovery, or automatic replay across session restarts.

## Long-session and subagent stability

1. `crash-logger/internal/segmenter-safety.ts` installs process-wide lazy JS grapheme segmentation before the first fullscreen paint.
2. `packages/ui-kit/internal/presentation/render-safety.ts` contains malformed Text/Markdown values, preserves cache identity, and caps Text/Markdown payloads plus compositor line arrays so Ctrl+O expand-all cannot dump unbounded tool output into the TUI.
3. `crash-logger/internal/terminal-restore-watchdog.mjs` restores the terminal after an unclean parent death and records the observed Windows exit code, last phase, a metadata-only runtime event ring, heartbeat age/event-loop lag, memory/resource counters, parent liveness, and bounded metadata from nearby Windows crash/resource events.
4. Task JSONL records, stderr, activities, errors, status text, result previews, and settled metadata are hard-bounded within `task/`.
5. Stream deltas do not repaint pinned worker cards; Pi owns scheduling.
6. Child agents run with Apex disabled; Task's own activity surface remains independently controllable.
7. Worker registries remain process-local. A parent crash still loses live handles; session files remain the durable child record.

Noninteractive tests prove type/runtime contracts, not sustained Windows Terminal stability. Interactive acceptance still requires fullscreen use with a large Bash result, session resume, and real delegated tasks.

## Observatory

- Observatory engine lives in `packages/ui-kit/observatory/`. Each UI registers landing art; Apex shark/classic landing is `registerClassicObservatoryLanding`.
- Preview: `node --experimental-transform-types agent/extensions/apex/observatory/preview.mjs`.
- Pure passive string rendering; no timers or Pi TUI Text/Markdown/Container.
- Cell measurement uses kit `packages/ui-kit/internal/presentation/safe-text-layout.ts`.
- The passive splash is mark + invitation + horizon on every UI: no CUSTOM PROMPTS / CUSTOM AGENTS inventory, no workspace signal, no inventory counts, no `/observatory` hint, no UI caption. Gated on the absence of a selection, not on the skin. The interactive orb and `/observatory` still render the full constellation; a focused orb also shows the key legend.
- Claude uses a wide block-art critter (29 × 7 cells full, 19 × 5 compact); terminal cells are ~2:1 tall, so equal-count art renders skinny.
- HAL uses a lens orb above a striped `HAL` wordmark, all upper-half blocks, separated by one dark row. Full tier: orb 9 × 18, wordmark 8 × 31, block width 31. Compact: orb 7 × 14, wordmark 8 × 18, block width 18. Below 20 columns, a single `▀`.
- The HAL orb has no art array: `discRadii()` gives each cell a normalized radius and `ORB_RAMP` colors it — radiant yellow pupil, concentric crimson glow, dark bronze bezel (the HAL 9000 lens). Truecolor inks per-cell RGB with run coalescing; otherwise it collapses to `warning`/`brand`/`brandDim` by radius. It does not use `pixel-art.ts` bitmaps.
- The HAL wordmark is Paul Rand's IBM 8-bar construction: all eight rows inked with one uniform `brand` key. Never dim a wordmark row, and do not reintroduce a per-row key tuple.
- `shark-art.ts` and `hal-art.ts` are generated and must not be hand-edited. `hal-art.ts` is retained as a generated asset but is no longer on the landing path.

## Feature ownership

- Background jobs: `bg-process.ts` plus `bg-process/internal/`; the kit attaches receipt chrome on `bg_start`/`bg_status`/`bg_list`/`bg_kill`, plus notice chrome on `bg-process-settled`.
- Continual memory: `continual-memory.ts` plus `continual-memory/store.ts`; kit receipt chrome on `memory_list` / `memory_write`.
- Web search: standalone `web-search.ts`; kit receipt chrome on `web_search` / `fetch_content` / `get_search_content`.
- Todo list: kit-owned (`packages/ui-kit/internal/todo/`), registered by `packages/ui-kit/builtin-tools.ts`; kit receipts plus the docked todos/agents panel, or a plain list under `PI_UI_CHROME=0`. Pi owns standard `read`/`edit` execution and skill invocation lifecycle; the kit wraps their interactive chrome and restores stock rendering when chrome is off.
- Browser/deploy pathways: `prompt-commands.ts` plus `prompt-commands/featured-commands.ts`; kit receipt chrome on `browser_attach`; the kit Observatory engine launches featured pathways.
- User profile: loader owned directly by `user-profile.ts`.
- `@` path overlay: standalone `at-path-complete.ts`; lists on-disk children for scoped `@dir/` mentions so gitignored folders (for example `files/`) appear in autocomplete. Bare `@foo` stays with FFF/stock.
- MCP adapter: standalone `mcp-adapter.ts`; kit receipt chrome on `mcp` / `mcpScript` (overrides adapter renderers). Direct and namespace MCP tools keep adapter chrome.
- Git worktrees: standalone `worktree.ts` plus `worktree/internal/`; kit receipt chrome on `worktree`.
- Agent Catalog: `packages/ui-kit/internal/runtime/agent-discovery.ts`. Task spawn and Observatory listing are adapters over it.

## Secrets

Never put API keys, tokens, credentials, browser profiles, or authentication data in results, logs, or this file.
