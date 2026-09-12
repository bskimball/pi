# Behavior modes and presentation

`/mode` opens the behavior picker. Direct choices are `pi`, `apex`, `apex-orchestrate`, and `fusion`. `/orchestrate on` selects Apex Orchestrate; `off` selects Apex. `/mode configure` configures the Fusion lead and sidekick, including independent thinking levels, and activates Fusion after successful setup.

The Fusion model picker uses the same available-provider catalog as Pi's `/model`, initially limited to your model scope when present. Type to search by model name, ID, or provider. Up/Down and Page Up/Page Down keep the highlighted selection visible; Enter selects and Escape cancels. Tab switches between your scope and all configured providers, never the full unconfigured catalog. In RPC mode, enter the exact `provider/model` ID instead of a terminal list.

Mode changes preserve the conversation and require an idle lead and idle workers. Running dev servers do not block switching. Earlier conversation history remains visible to the model, so switching to Pi is not a clean-room reset of prior messages.

Selection is staged: apply model/thinking, acknowledge Fusion configuration, persist the session/default choices, then announce the mode. A failed switch restores the prior tools, model, and mode; incomplete recovery blocks input until a successful `/mode` switch. Changing `/model` alone does not clear that block.

Pi uses the installed Pi system-prompt builder and the default built-in read, bash, edit, and write tools. Custom profile, memory, Graphify, and read-guard injections are suppressed. Project context and installed skill descriptions retain Pi's normal loading behavior. Apex, Apex Orchestrate, and Fusion each overlay the shared `agent/SYSTEM.md` base prompt with their own mode card (Regular, Orchestrate, Fusion); Fusion no longer replaces the base prompt. Apex appends the Regular card; Apex Orchestrate appends its existing specialist-first instructions.

Each session saves its mode and model choices. Explicit mode switching also sets the default for new sessions. Resuming restores the session's own settings; older sessions map their saved orchestration state to Apex or Apex Orchestrate.

## Fusion

Fusion operates with a closed roster: the lead, one persistent execution partner (`sidekick`) managed via `task_start`/`task_send`, and four one-shot ephemeral specialists dispatched via the synchronous `task` tool (`librarian` for external research, `stevedore` for verification-only passes and release mechanics, `oracle` for on-demand deep review only — user-requested, gate-triggered, or genuinely difficult bugs — and `picasso` for image generation). Other agents (machinist, artisan, scribe, scout, inspector, advisor) are excluded in Fusion. The persistent sidekick absorbs scout and inspector duties: broad local reconnaissance, codebase exploration, and live-page verification prep go through the sidekick rather than separate subagents. The lead owns investigation and judgment, and may delegate bounded read-only inventory, reference checks, or diagnostics early; the sidekick also executes scoped edits and validation in the same workspace. Each handoff identifies read-only versus execution work, scope, authorization, expected evidence or deliverable, and validation where appropriate. Preparation stops once authorized scope, affected files, risks, and validation are clear unless contradictory evidence appears.

One-writer rule: only one agent may mutate workspace files at a time across the sidekick and editing specialists. While the sidekick is active, runtime gates block lead `bash`, `powershell`, `edit`, and `write`. Read-only librarian research and read-only oracle review may run alongside a live sidekick; any specialist that touches workspace files (stevedore verification gates or git operations, oracle edits, picasso image writes) must wait for the sidekick to settle before dispatch. The lead may continue read-only inspection with `read`, `ffgrep`/`fffind`, or LSP, or wait for/stop the sidekick before using shell. Both roles may use installed utilities within those gates. The sidekick cannot maintain the lead's todo list.

The first entry requires a model pair. Canceling setup leaves the active mode unchanged. Context persists across assignments and is restored from the saved sidekick transcript after parking or session restart. Changing models retains that transcript. Reusing `task_start` continues it; a supplied report schema updates the generation's report instructions and validation. Model changes use `/mode configure`; a different working directory requires closing the worker first. Forking an existing sidekick transcript is not a per-assignment operation. Missing saved transcripts are reported rather than silently replaced with fresh context. Escape stops active sidekick work as well as the lead. Unavailable models are reported rather than automatically substituted.

The lead owns one todo list and supplies an update after work in another mode. User updates cover meaningful findings, decisions, handoffs, blockers, or completion rather than tool-by-tool narration. Todo state remains stored but dormant while Pi mode is selected. Existing task receipts expose bounded activity and results; this implementation does not claim Cognition benchmark or cost parity.

## Presentation

`/ui pi` selects default Pi presentation; `/ui apex` selects Apex; `/ui claude` selects the Claude Code skin on Apex presentation. The picker is available with `/ui`. Switching is live and idle-only, independent of behavior and models. UI selection is shared for future launches, with a separate saved theme for each UI. Change themes through Pi's normal theme controls; the selected theme is saved on UI switch or session shutdown.

There is no UI plugin framework. Apex owns its own install/teardown behavior; other extensions communicate through events rather than cross-extension source imports. Live switches refresh Apex-owned receipt definitions while preserving execution, active tools, and the stored plan. Todo controls stay registered but inactive in Pi presentation; the plain todo list remains available outside Pi behavior mode.

The Claude skin chooses a working verb per run (for example, Cogitating, Pondering, or Spelunking), retaining the star motifs and Pi-owned animation clock. The 20 phrases are a subset of the [independently documented Claude Code 2.1.42 list](https://codingcocoon.com/posts/claude-code-all-spinner-verbs/), not a claim to mirror every current default. Claude Code documents its own [`spinnerVerbs` setting](https://code.claude.com/docs/en/settings-reference#spinnerverbs); this installation does not add a separate phrase configuration.

## Storage and integration

Global defaults live in `agent/mode-settings.json`; session choices use `behavior-mode` custom entries. `PI_FUSION_SIDEKICK` and the `fusion-sidekick-session` persisted entry key are stable internals retained for transcript continuity after the agent rename. Sidekick transcript references remain scoped to the parent session. These files contain configuration or transcript paths, not provider credentials.

Event contracts:
- `pi:modes:query-busy`: mutable `{ busy }`, synchronously augmented by task listeners.
- `pi:modes:changed`: `{ mode, fusion }`, updates runtime policy and parks idle sidekicks when leaving Fusion.
- `pi:fusion:configure`: `{ fusion, acknowledged?, promise?, error?, rollback? }`. Task synchronously acknowledges ownership, exposes asynchronous model/thinking application, and supplies rollback before the mode controller commits selection. The event bus alone is not an error acknowledgement.
- `pi:ui:changed`: `{ ui, ctx }`, updates presentation without restarting the session.

The stock prompt builder is resolved from the installed Pi package because its runtime function is not exported at the package root. SDK upgrades must retain or update this integration point.
