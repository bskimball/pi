# Behavior modes and presentation

`/mode` opens the behavior picker. Direct choices are `pi`, `apex`, `apex-orchestrate`, `fusion`, and `work`. `/orchestrate on` selects Apex Orchestrate; `off` selects Apex. `/mode configure` configures the Fusion lead/sidekick pair and activates that mode after successful setup. Work no longer uses a persistent pair.

The persisted `fusion` pair schema, configuration handshake, and transcript entry key are Fusion's. Work no longer uses a persistent sidekick pair and keeps no sidekick transcript across modes.

The model picker uses the same available-provider catalog as Pi's `/model`, initially limited to the current model scope when present. Type to search by model name, ID, or provider. Up/Down and Page Up/Page Down keep the highlighted selection visible; Enter selects and Escape cancels. Tab switches between scoped and all configured providers, never an unconfigured catalog. In RPC mode, enter an exact `provider/model` ID.

Mode changes preserve the conversation and require an idle lead and idle workers. Running dev servers do not block switching. Selection is staged: apply model/thinking, acknowledge sidekick configuration, persist the session/default choices, then announce the mode. A failed switch restores prior tools, model, and mode; incomplete recovery blocks input until a successful `/mode` switch. Model and thinking changes update the active Work or Fusion lead choice.

Pi uses the installed Pi system-prompt builder and keeps installed extension tools, including intercom, fffind, and ffgrep. Subagents remain available only when the user names a specialist or asks to delegate; Pi does not inherit Apex auto-routing. Apex, Apex Orchestrate, and Fusion overlay the configured base prompt. Work instead invokes the installed builder with its dedicated operations-first custom prompt, retaining project context, installed skills, and selected-tool guidance without inheriting the coding-first base prompt.

## Work

Work is operations-first collaboration in the Apex inline-first shape: the lead does the bulk of the work directly and dispatches a closed four-specialist team — `strategist` (Eddie, business/productivity planning), `researcher` (Oscar, external source-traced research), `author` (Flo, human-readable and kindly worded prose), `clerk` (Gomez, broad recon plus monotonous reversible execution) — via `task`, or `task_start` / `task_send` when multi-turn or steering is needed. No persistent sidekick, no other agents. Concurrent writers require disjoint path ownership. Broad validation, builds, and git operations run only in a settled exclusive window. Workspace instructions, skills, maintained CLIs/MCP surfaces, and owning capability packages remain the preferred source of operational behavior and authority boundaries.

## Fusion

Fusion remains a closed roster: the lead, the persistent `sidekick` role (an idle sidekick is reused; `task_start` while every sidekick is busy spawns a parallel one for a disjoint unit), and the synchronous ephemeral `librarian`, `stevedore`, `oracle`, and `picasso`. Only the sidekick may be dispatched automatically. Each other specialist requires an explicit user request to use that specialist; a general review/research/verification request, a difficult bug, or a path-triggered review gate does not authorize dispatch. The Fusion mode card overrides automatic specialist-routing instructions; the lead and sidekick perform review and verification by default. Other existing specialists — including the Work crew (strategist, researcher, author, clerk) — remain excluded in Fusion. Its sidekick lifecycle, transcript continuity, and `task_chain`/`task_rebind` restrictions are Fusion-only. Apex delegation policy is unchanged.

Fusion's [mode card](../../prompts/inactive/fusion.md#handoffs) owns the handoff criteria: choose complementary ownership, settle risky contracts before implementation, define observable acceptance, and integrate returned work without repeated small correction handoffs. These criteria are Fusion-only; the shared sidekick brief and runtime are unchanged.

## Presentation

`/ui pi` selects default Pi presentation. `/ui apex`, `/ui claude`, and `/ui hal` select the matching installed UI extension. Switching is live and idle-only, independent of behavior and models, and fails closed if that UI directory is missing. Each UI has a separately saved theme: `dark`, `apex-dark`, `claude-dark`, or `hal-dark`. Shared receipts live in `packages/ui-kit`. Presentation switching lives in `presentation-switch.ts` and sets `PI_UI_CHROME` / `PI_UI_SKIN` (`PI_APEX_UI` is a deprecated alias kept in sync).

## Storage and integration

Global defaults live in `agent/mode-settings.json`; session choices use `behavior-mode` custom entries. `PI_FUSION_SIDEKICK` and `fusion-sidekick-session` are stable internal names retained for sidekick transcript continuity. They contain configuration or transcript paths, not provider credentials.

Event contracts:
- `pi:modes:query-busy`: mutable `{ busy }`, synchronously augmented by task listeners.
- `pi:modes:changed`: `{ mode, fusion }`, updates task policy and parks settled sidekicks when leaving Work or Fusion.
- `pi:fusion:configure`: `{ fusion, acknowledged?, promise?, error?, rollback? }`; the name is retained while the Work and Fusion pair share the same task runtime handshake.
- `pi:ui:changed`: `{ ui, ctx }`, updates presentation without restarting the session.
