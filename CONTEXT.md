# CONTEXT.md — Pi custom configuration architecture

Domain vocabulary and seams for `~/.pi`. Runtime behavior lives under `agent/`; reference material under `reference/`.

## Extension layout

```text
agent/extensions/
├── apex/                   # optional custom UI; owns all Apex rendering
│   ├── apex-ui.ts
│   ├── builtin-tools.ts
│   ├── observatory/
│   ├── internal/           # Apex-only presentation/runtime/edit/todo modules
│   └── test/
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

- Apex is the only general custom-presentation extension. Its Observatory, built-in tool receipts, layout safety, and width-safe primitives live under `apex/`.
- Other tools use Pi's stock tool renderer and return bounded plain text plus structured details where useful.
- Task owns one narrow exception: essential standalone delegated-worker activity cards and notices. They work with Apex absent, have their own `PI_TASK_UI=0` switch, and also honor the installation-wide `PI_APEX_UI=0` emergency presentation opt-out.
- Todo is Apex-private (`apex/internal/todo/`): receipts and the docked above-editor panel, or stock rendering under `PI_APEX_UI=0`.
- `PI_APEX_UI=0` remains the emergency opt-out for every custom presentation surface. It disables Apex UI and Task cards without disabling either extension's tool behavior.
- Rendering remains passive and event-driven. No extension presentation timer calls `requestRender()`.

## Task extension

| | Sync (`task/amp-task.ts`) | Async (`task/async-task.ts`) |
|--|---------------------------|------------------------------|
| Tool interface | `task` | `task_start`, `task_status`, `task_list`, `task_send`, `task_wait`, `task_abort`, `task_close`, `task_reply` |
| Child | `pi --mode json -p` subprocess | session-backed RPC worker |
| Runtime | local mission host | `task/runtime/worker-runtime.ts` control plane |
| Presentation | bounded Task-owned mission card | bounded Task-owned worker activity |

Task owns specialist discovery, subprocess environment, process-tree reaping, transport/framing, lifecycle policy, output bounds, and presentation. Both task modes cap child concurrency, exclude nested task tools, and bound stored output.

## Long-session and subagent stability

1. `crash-logger/internal/segmenter-safety.ts` installs process-wide lazy JS grapheme segmentation before the first fullscreen paint.
2. `apex/internal/presentation/render-safety.ts` contains malformed Apex Text/Markdown values and preserves cache identity.
3. `crash-logger/internal/terminal-restore-watchdog.mjs` restores the terminal after an unclean parent death and records last-phase evidence.
4. Task JSONL records, stderr, activities, errors, status text, result previews, and settled metadata are hard-bounded within `task/`.
5. Stream deltas do not repaint pinned worker cards; Pi owns scheduling.
6. Child agents run with Apex disabled; Task's own activity surface remains independently controllable.
7. Worker registries remain process-local. A parent crash still loses live handles; session files remain the durable child record.

Noninteractive tests prove type/runtime contracts, not sustained Windows Terminal stability. Interactive acceptance still requires fullscreen use with a large Bash result, session resume, and real delegated tasks.

## Observatory

- Apex-only landing surface: `apex/observatory/observatory.ts`.
- Preview: `node --experimental-transform-types agent/extensions/apex/observatory/preview.mjs`.
- Pure passive string rendering; no timers or Pi TUI Text/Markdown/Container.
- Cell measurement uses Apex-owned `apex/internal/presentation/safe-text-layout.ts`.
- `shark-art.ts` is generated and must not be hand-edited.

## Feature ownership

- Background jobs: `bg-process.ts` plus `bg-process/internal/`; Apex attaches receipt chrome on `bg_start`/`bg_status`/`bg_list`/`bg_kill`, plus notice chrome on `bg-process-settled`.
- Continual memory: `continual-memory.ts` plus `continual-memory/store.ts`; stock tool rendering.
- Web search: standalone `web-search.ts`; Apex receipt chrome on `web_search` / `fetch_content` / `get_search_content`.
- Todo list and unified edit: Apex-owned (`apex/internal/todo/`, `apex/internal/edit/`), registered by `apex/builtin-tools.ts`; Apex receipts plus the docked todo panel, or stock rendering under `PI_APEX_UI=0`.
- Browser/deploy pathways: `prompt-commands.ts` plus `prompt-commands/featured-commands.ts`; Apex contains its own pathway launcher copy for Observatory.
- User profile: loader owned directly by `user-profile.ts`.
- MCP adapter: standalone `mcp-adapter.ts`; MCP tools use Pi's stock renderer.

## Secrets

Never put API keys, tokens, credentials, browser profiles, or authentication data in results, logs, or this file.
