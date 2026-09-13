# Behavior modes and presentation

`/mode` opens the behavior picker. Direct choices are `pi`, `apex`, `apex-orchestrate`, `fusion`, and `work`. `/orchestrate on` selects Apex Orchestrate; `off` selects Apex. `/mode configure` configures the active collaboration mode's lead/sidekick pair when Work is active, otherwise the Fusion pair, and activates that mode after successful setup.

The Work and Fusion pair intentionally share the existing persisted `fusion` pair schema, configuration handshake, and transcript entry key. This preserves sidekick continuity across the two collaboration modes without duplicating credential- or model-selection state. The pair is not a roster choice: Work and Fusion differ in their task policies.

The model picker uses the same available-provider catalog as Pi's `/model`, initially limited to the current model scope when present. Type to search by model name, ID, or provider. Up/Down and Page Up/Page Down keep the highlighted selection visible; Enter selects and Escape cancels. Tab switches between scoped and all configured providers, never an unconfigured catalog. In RPC mode, enter an exact `provider/model` ID.

Mode changes preserve the conversation and require an idle lead and idle workers. Running dev servers do not block switching. Selection is staged: apply model/thinking, acknowledge sidekick configuration, persist the session/default choices, then announce the mode. A failed switch restores prior tools, model, and mode; incomplete recovery blocks input until a successful `/mode` switch. Model and thinking changes update the active Work or Fusion lead choice.

Pi uses the installed Pi system-prompt builder and the default built-in read, bash, edit, and write tools. Apex, Apex Orchestrate, and Fusion overlay the configured base prompt. Work instead invokes the installed builder with its dedicated operations-first custom prompt, retaining project context, installed skills, and selected-tool guidance without inheriting the coding-first base prompt.

## Work

Work is operations-first collaboration: a lead and one persistent `sidekick` managed with `task_start` / `task_send`. The sidekick retains context across assignments and session resume; it can perform scoped reconnaissance, implementation, and slice-local validation, but cannot spawn agents or maintain the lead's todo list. Every brief names read-only versus execution work, exact paths, scope, authorization carried from the user, evidence, validation, and a compact return contract.

Unlike Fusion, Work keeps the full existing synchronous specialist roster available through `task`; it adds no new agents. Async `task_start` is reserved for the designated sidekick so its lifecycle, transcript reuse, model binding, and lead/sidekick gates remain unambiguous. Concurrent writers require disjoint path ownership. Broad validation, builds, and git operations run only in a settled exclusive window. Workspace instructions, skills, maintained CLIs/MCP surfaces, and owning capability packages remain the preferred source of operational behavior and authority boundaries.

## Fusion

Fusion remains a closed roster: the lead, one persistent `sidekick`, and the synchronous ephemeral `librarian`, `stevedore`, `oracle`, and `picasso`. Only the sidekick may be dispatched automatically. Each other specialist requires an explicit user request to use that specialist; a general review/research/verification request, a difficult bug, or a path-triggered review gate does not authorize dispatch. The Fusion mode card overrides automatic specialist-routing instructions; the lead and sidekick perform review and verification by default. Other existing specialists remain excluded in Fusion. Its sidekick lifecycle, transcript continuity, and `task_chain`/`task_rebind` restrictions are shared with Work; its synchronous closed-roster gate is Fusion-only. Work and Apex delegation policies are unchanged.

Fusion's [mode card](../../prompts/inactive/fusion.md#handoffs) owns the handoff criteria: choose complementary ownership, settle risky contracts before implementation, define observable acceptance, and integrate returned work without repeated small correction handoffs. These criteria are Fusion-only; the shared sidekick brief and runtime are unchanged.

## Presentation

`/ui pi` selects default Pi presentation. `/ui apex`, `/ui claude`, and `/ui hal` select the matching installed UI extension. Switching is live and idle-only, independent of behavior and models, and fails closed if that UI directory is missing. Each UI has a separately saved theme: `dark`, `apex-dark`, `claude-dark`, or `hal-dark`. Shared receipts live in `packages/ui-kit`; behavior-mode plumbing only sets `PI_APEX_UI` / `PI_UI_SKIN`.

## Storage and integration

Global defaults live in `agent/mode-settings.json`; session choices use `behavior-mode` custom entries. `PI_FUSION_SIDEKICK` and `fusion-sidekick-session` are stable internal names retained for sidekick transcript continuity. They contain configuration or transcript paths, not provider credentials.

Event contracts:
- `pi:modes:query-busy`: mutable `{ busy }`, synchronously augmented by task listeners.
- `pi:modes:changed`: `{ mode, fusion }`, updates task policy and parks settled sidekicks when leaving Work or Fusion.
- `pi:fusion:configure`: `{ fusion, acknowledged?, promise?, error?, rollback? }`; the name is retained while the Work and Fusion pair share the same task runtime handshake.
- `pi:ui:changed`: `{ ui, ctx }`, updates presentation without restarting the session.
