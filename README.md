# Pi configuration

Choose how your agent works. Choose how it looks.

Personal configuration for [Pi](https://github.com/earendil-works/pi-mono) — a coding agent with a roster of specialist sub-agents, six collaboration modes, a stats-driven Hydra model router (`/mode hydra`), three installable presentation skins, and slash-command extensions for browser automation and deployment. This README is the human front door; [AGENTS.md](AGENTS.md) is the canonical description for the agent itself.

## Contents

- [Mode vs UI](#mode-vs-ui--two-independent-switches)
- [Modes at a glance](#modes-at-a-glance)
- [Setup](#setup) — try it in an isolated clone
- [Apex vs Apex Orchestrate](#apex-vs-apex-orchestrate)
- [Fusion](#fusion)
- [Utopia](#utopia)
- [Work](#work)
- [Hydra](#hydra)
- [Specialist roster](#specialist-roster)
- [Presentation](#presentation-ui)
- [Restore on a new machine](#restore-on-a-new-machine) — replace your own `~/.pi`
- [Where to read next](#where-to-read-next)

## What's here, and what isn't

This repo is the *configuration layer* on top of a stock Pi install: agent briefs, extensions, slash commands, skills, and themes under `agent/`, plus a shared UI package at `packages/ui-kit`. It does not vendor or replace Pi itself — Pi is a pinned dependency (`@earendil-works/pi-coding-agent`). Two collaboration modes are explicitly built on published external work:

- **Fusion mode is based on [Cognition's Fusion architecture](https://cognition.com/blog/local-fusion)**: a frontier lead paired with a cost-effective sidekick, each keeping its own persistent context and exchanging briefs/results/feedback rather than full transcripts. This is an independent implementation written for Pi — not Devin itself — and this repo makes no measured cost or performance claims; only the design shape is adopted. See [Fusion](#fusion) below for how it works here.
- **The specialist roster and its task-delegation tools are Amp-inspired**, adapting [Amp](https://ampcode.com/)'s published [subagent model](https://ampcode.com/docs/models-and-subagents) — notably an Oracle-style deep reasoner and a Librarian-style external-code researcher — and adding a broader set of purpose-built specialist roles alongside them (Advisor, Artisan, Inspector, Machinist, Picasso, Scout, Scribe, Sidekick, Stevedore). Prompts are rewritten for Pi; this is not a claim that Amp lacks these roles or that every agent here ships in Amp. `reference/amp-prompts/` holds Amp's original prompts as background reading; they are not loaded at runtime.

## Mode vs UI — two independent switches

Pi has two independent selectors:

- **`/mode`** picks *behavior*: which system prompt, delegation policy, and specialist roster are active (`pi`, `apex`, `apex-orchestrate`, `fusion`, `utopia`, `work`), or configures the **Hydra** stats-driven model and thinking router (`/mode hydra [off|standard|high|max|status|sync]`).
- **`/ui`** picks *presentation*: which visual skin renders tool output, receipts, and the landing screen. Choices: `pi` (stock, no custom chrome), `apex`, `claude`, `hal`.

They're orthogonal — you can run Fusion behavior under the HAL skin, or Apex Orchestrate under stock Pi presentation. Switching either is live, requires an idle lead and idle workers, and preserves the conversation. `/orchestrate on`/`off`/(bare toggle) is a shortcut for switching between Apex and Apex Orchestrate without leaving Apex behavior otherwise. See [`agent/extensions/prompt-commands/README.md`](agent/extensions/prompt-commands/README.md) for the full switching/persistence contract.

## Modes at a glance

| Mode | Delegation policy | Roster | Prompt / routing |
| --- | --- | --- | --- |
| **Pi** | None built in — upstream Pi's own system prompt and behavior | Full roster, dispatched when you name a specialist or ask it to delegate | Upstream Pi's system-prompt builder |
| **Apex** | Inline-first: the lead does most work directly, delegates selectively | Full roster | Coding-first base prompt (`agent/SYSTEM.md`) + Apex overlay |
| **Apex Orchestrate** | Specialist-first: substantial slices go to specialists; lead plans, integrates, verifies, and handles control-plane work inline | Full roster | Same base prompt + strict-orchestrator overlay |
| **Fusion** | Sidekick-first: persistent sidekicks are the default delegate (one by default, parallel ones for disjoint units); four others only on explicit request | Closed six-role team | Same base prompt + Fusion overlay |
| **Utopia** | Inline-first lead + warm reusable `sidekick` (<100k tokens) for recon, test/gate loops, experiments, and sweeps; full specialist roster when distinct judgment or isolation pays | Full roster + `sidekick` | Same base prompt + Utopia overlay; automatically enables Hydra (`high` by default) |
| **Work** | Operations-first, own dedicated prompt; inline-first with a closed four-specialist roster | Closed five-role team (lead + strategist, researcher, author, clerk) | Dedicated operations-first prompt, not the coding-first base |
| **Hydra** (`/mode hydra`) | Routing overlay on any mode (auto-enabled in Utopia; cleared on explicit mode switches): keeps a healthy, qualified lead cache-sticky while modulating thinking per turn (`low`..`max`, clamped to model support), and routes subagents dynamically | Active mode's roster | Active mode's prompt + AA/quota/Jev-scored model & thinking router (`off`, `standard`, `high`, `max`) |

"Pi mode" means **stock behavior inside this configured install** — your extensions, tools, skills, and project instructions are all still present, and the model can still delegate when you ask it to. It does not uninstall anything or reset you to a fresh, unconfigured Pi. (A brand-new install defaults to `/mode apex` + `/ui apex`; this table describes what each mode *does*, not the out-of-the-box default.)

## Apex vs Apex Orchestrate

Same base prompt, same specialist roster, same sub-agent tools — the only difference is who does substantial work by default.

**Apex (inline-first):**

```text
you: "add pagination to the /orders API endpoint"
  └─ lead: reads the code, implements the change
       └─ oracle: independently reviews the actual code and diff
     lead: addresses blocking findings, verifies, reports back
```

**Apex Orchestrate (specialist-first):**

```text
you: "add pagination to the /orders API endpoint"
  └─ lead: plans the slice, then delegates it
       └─ machinist: implements, runs slice-local checks
       └─ oracle: independently reviews the actual code and diff
     lead: resolves blocking findings, integrates the result
       └─ stevedore: runs integrated verification
     lead: reports back; stays inline for status checks, "continue",
           launching the dev server, and small integration edits
```

**Both Apex modes use Oracle for fresh-eyes review after substantial changes.** Review examines the actual code and diff, not just the implementer's summary, and blocking findings must be resolved before delivery. Sensitive changes, published public APIs, and user-visible behavior trigger review regardless of diff size; a non-behavioral typo does not need the full workflow.

Independent slices can run in parallel under Apex Orchestrate, each in its own isolated Git worktree, up to five concurrent async workers and three concurrent writers. `/orchestrate on` / `/orchestrate off` / `/orchestrate` (bare toggle) switches between the two without touching `/mode` directly.

## Fusion

Fusion is a **small team**, not a bigger roster: one lead, one persistent `sidekick` role (a second or third instance is spawned only when disjoint units can run in parallel, each on its own owned paths), and four specialists (`librarian`, `stevedore`, `oracle`, `picasso`) that only run when *you* explicitly ask for them — not automatically, no matter how hard the task looks or how strongly a review gate would normally fire elsewhere.

```text
you: "investigate why checkout fails intermittently, then fix it"
  └─ lead: dispatches a read-only discovery unit
       ← sidekick returns: findings, affected paths, evidence
  └─ lead: defines implementation ownership and behavioral acceptance cases
       └─ task_start(sidekick) → implements and runs the acceptance check
       └─ lead: prepares independent verification while the sidekick works
       ← sidekick returns: changed files, results, residual risks
  └─ lead: reviews the diff, verifies, resolves the todo item, reports

# only on your explicit request:
you: "have oracle review that fix before we ship"
  └─ task(oracle) → one-shot, synchronous review
```

Lead and sidekick keep **separate, persistent contexts** across the session — the lead sends a compact brief in, the sidekick sends back results and evidence, not a full transcript either direction. That separation, plus the "cheap sidekick executes, expensive lead plans/reviews" split, is the part borrowed from [Cognition's Fusion architecture](https://cognition.com/blog/local-fusion); the brief/result exchange protocol, the closed-roster gate, and the shared-todo-list discipline are this repo's own implementation on top of that idea. The sidekick is the *only* subagent dispatched automatically; a general "please verify this" or a difficult bug does not, by itself, authorize calling Oracle or any of the other three — you have to name it. See [`agent/prompts/inactive/fusion.md`](agent/prompts/inactive/fusion.md) for the exact handoff and ownership criteria the lead follows.

The first time you switch to Fusion without a saved pair, `/mode fusion` itself prompts you to pick the lead and sidekick models and thinking levels — you don't have to run `/mode configure` first. `/mode configure` is the explicit way to (re)configure that pair at any time; it configures and activates Fusion. Changing model or thinking level while Fusion is active updates the lead's choice directly. The pair is stored locally in the gitignored `agent/mode-settings.json`. Activation reports the selected pair; sidekick launch and reuse receipts distinguish configured selection from child-reported identity. These observations describe that point in time, not a guarantee of the model on a later response.

Related discovery and implementation units retain useful sidekick context. Release-only units start fresh with a compact, authorized handoff; verification captures are reused for summaries instead of rerunning unchanged checks. The [Fusion mode card](agent/prompts/inactive/fusion.md) owns these workflow rules.

## Utopia

Utopia combines **Apex's inline-first lead ownership and full specialist roster** with a **warm, reusable `sidekick`** (`task_start`, agent `sidekick`) and **Hydra** model routing (`high` by default):

```text
you: "trace why the LSP diagnostics probe stalls on Windows, then fix it"
  └─ lead (cache-sticky via Hydra): dispatches a slice-pack / experiment unit
       └─ task_start(sidekick) → scans local code or runs an exact experiment
       ← sidekick returns: compact findings, stays settled and warm (<100k tokens)
  └─ lead: implements the fix inline (or reuses the warm sidekick for iterative test loops)
       └─ oracle: fresh-eyes review of the actual code and diff when triggered
  └─ lead: resolves findings, verifies, reports back
```

- **Inline-first lead:** The lead owns architecture, ambiguity resolution, coherent multi-file/backend/frontend edits, and bounded (<30 line) doc/README/comment updates on a dirty checkout instead of spawning `scribe` onto uncommitted changes.
- **Warm `sidekick` (<100k token reuse):** Default delegate ahead of cold `scout`, `machinist`, or verification-only `stevedore` for local reconnaissance, executing exact Oracle diagnostic experiments, iterative test/build/gate loops, mechanical repo sweeps, and `/cua on` desktop automation. An accepted sidekick stays settled so the next `task_start` reuses its warm context on the same model up to ~100k tokens (`context: "fresh"` resets when prior context is irrelevant; `task_send mode=prompt` is bounded to one corrective pass on the same unit). Unlike Fusion, Utopia needs no preconfigured lead/sidekick pair — the sidekick routes dynamically through Hydra.
- **Ephemeral specialists when distinct judgment or isolation pays:** `oracle` for path-triggered or integrated-diff review and hard debugging, `librarian` for external repo/docs research, `artisan` for substantial visual design, `inspector` for live-page browser proof, `stevedore` for directed release/git/deploy mutations, `scribe` for standalone or long-form prose outside the lead's dirty edits, `machinist` for parallel disjoint worktree slices while `sidekick` is busy, `picasso` for image generation, `scout` for cold one-off or parallel scans, and `advisor` on explicit request.
- **Preflight and canonical closeout:** Verifies external prerequisites at their source (target config, `browser_tabs` for authenticated tabs, `bg_status`/health probes) before reporting a blocker or dispatching dependent `inspector`/`stevedore` work, and builds release artifacts from the primary checkout at the landed revision into the canonical output path.

## Work

Work is operations-first: HAL captures each commitment you state into Autotask (ticket or project task) or Microsoft To Do, acts on it, and closes it; the lead does the bulk of the work directly (inline-first, like Apex) using a dedicated prompt instead of the coding-first base, dispatching a closed four-specialist team — `strategist` (Eddie, business/productivity planning), `researcher` (Oscar, external source-traced research), `author` (Flo, human-readable and kindly worded prose), `clerk` (Gomez, broad recon plus monotonous reversible execution) — via `task`, or `task_start` / `task_send` when multi-turn or steering is needed. No persistent sidekick, no other agents. Business workflows and integrations remain owned by their own project.

## Hydra

Hydra (`/mode hydra [off|standard|high|max|status|sync]`) is a stats- and quota-driven model and thinking router. You can enable it on top of any behavior mode; switching to `/mode utopia` activates `high` automatically (unless another active tier is already set), while switching explicitly to another behavior mode turns Hydra off until re-enabled.

- **Scoring:** Ranks available models across your configured subscriptions using Artificial Analysis metrics (Coding Score, Intelligence Index, Design Arena Elo, output tok/s, and blended token price as a subscription-burn proxy), 24-hour subscription call-share balancing across major model families, live quota and circuit-breaker health, and Jev's per-turn task signal (`reasoningDepth` 1–4 and `domain`: `coding`, `design`, `reasoning`, `fast_edit`, `research`, `writing`, `conversation`).
- **Cache-sticky lead:** While the session prompt cache is warm (within 30 minutes) and the current lead model remains healthy and clears the turn's quality floor, Hydra holds that lead model to preserve prompt caching and modulates thinking effort (`low`..`max`, clamped to the model's supported levels) per turn instead of thrashing models. Picking a model manually with `/model` pins it for your next run before Hydra resumes routing.
- **Dynamic subagent routing:** Spawned specialists and Utopia's warm `sidekick` route through Hydra using role-specific domain and depth profiles (`oracle`/`advisor`/`strategist` on deep reasoning, `artisan` on design, `machinist`/`sidekick` on coding, `inspector`/`stevedore`/`scout` on fast execution, with `inspector` and `stevedore` preferring native tool-calling providers) and filter fallback chains by quota and open circuits.
- **Scope and inspection:** `/jippity [on|off]` restricts Hydra (both lead and subagents) to OpenAI (`openai` / `openai-codex`) models. `/mode hydra status` shows the top-ranked candidates, quota snapshots, open circuits, and 24-hour family call counts; `/mode hydra sync` refreshes the Artificial Analysis catalog and local quota snapshot.

## Trying a mode

```
/mode pi                 # stock Pi behavior in this configured install
/mode apex                # inline-first, full roster
/mode apex-orchestrate     # specialist-first, same roster
/orchestrate on            # equivalent toggle, from Apex
/mode fusion               # closed lead+sidekick team (first switch without a saved pair prompts for one)
/mode utopia               # inline-first + warm sidekick + full roster + Hydra (high by default)
/mode work                 # operations-first, inline-first, strategist/researcher/author/clerk
/mode hydra high           # enable Hydra stats/quota routing on the active mode (off|standard|high|max|status|sync)
/jippity on                # restrict Hydra routing to OpenAI models (/jippity off restores all subscriptions)
/mode configure            # pick lead/sidekick models + thinking for Fusion
/ui apex                   # switch presentation only — independent of /mode
```

Switching requires an idle lead and idle workers (a running dev server doesn't block it). A failed switch restores the prior tools/model/mode; if that recovery itself fails, input stays blocked until a `/mode` switch succeeds.

## Slash prompts

Live prompt templates under `agent/prompts/*.md` (discovery is non-recursive):

- `/brainstorm [topic]` — diverge on architectural options; do not implement until asked to converge.
- `/poteto [goal]` — match Investigation, Bug fix, Feature, Refactor, Prototype, or Unattended; copy those steps into the todo list (`skip: <reason>` stays visible); execute under the already-active `/mode`. Not a behavior mode. `new task` re-matches. Playbooks: [`agent/prompts/poteto/`](agent/prompts/poteto/).

`/browser`, `/deploy`, `/mode`, `/orchestrate`, `/jippity`, and `/cua` are native commands, not prompt templates.

## Specialist roster

Sub-agents are dispatched with `task` (synchronous, blocks for one final report) or `task_start`/`task_send`/`task_wait`/`task_close` (asynchronous, runs in the background while the lead keeps working). Each spawns its own `pi` process with its own model, thinking level, and tool set.

| Agent | Role |
| --- | --- |
| `advisor` | Strategic planner consulted before consequential approaches, when stuck, or when changing direction. Advisory only. |
| `artisan` | Bold visual-design and frontend specialist for substantial UI implementation, diagrams, slides, and data visualization. |
| `inspector` | Fast, cheap read-only verifier for live-browser checks, screenshots, and visual regression after implementation. |
| `librarian` | Remote source-code researcher for external libraries, framework internals, and cross-repository investigation. |
| `machinist` | Workhorse coding specialist for large implementation chunks, backend logic, refactors, migrations, bug fixes, tests. |
| `oracle` | Deep independent reviewer of actual code and diffs, plus debugger for difficult bugs and high-stakes decisions. |
| `picasso` | Image-generation specialist for concept art, UI renderings, illustrations, icons, logos, textures, diagrams. |
| `scout` | Fast, cheap local codebase reconnaissance for broad scans and context gathering. |
| `scribe` | Editorial writing specialist for blog posts, articles, documentation, launch copy, and long-form prose. |
| `sidekick` | Persistent or warm-reusable execution partner for implementation, reconnaissance, investigation, writing, and validation — Fusion and Utopia only. |
| `stevedore` | Fast execution specialist for integrated gates, exact diagnostic experiments, deploys, git, and platform CLIs. |

Full agent-file format (frontmatter fields, fallback-model chains, shared prompt fragments) is documented in [CONFIGURATION.md](CONFIGURATION.md#agent-markdown-agentagentsmd-local-custom).

## Presentation (`/ui`)

Three installable skins share one presentation package (`packages/ui-kit`, `@pi/ui-kit`) for receipts, layout, and the above-editor todo/agents dock; each owns its own landing art, glyphs, working indicator, and theme:

- **`pi`** — stock Pi, no custom chrome.
- **`apex`** — shark-in-deep-space Observatory landing, braille activity indicator, `apex-dark` theme.
- **`claude`** — star-motif landing, round receipts, Claude-style verbs, `claude-dark` theme.
- **`hal`** — geometric HAL-lens-orb landing, square receipts, quiet activity, `hal-dark` theme.

`/ui pi` doesn't unregister any tools — the todo dock, for example, just falls back to a plain uncolored list instead of the styled tabbed panel. Switching UI is independent of `/mode`, live, and idle-only; it fails closed if the target skin's directory is missing.

## Optional capabilities

These extend the base install and are not required to try modes/UI:

- **Browser automation** (`/browser`) — attaches to a dedicated, separately profiled debug Chrome on CDP port 29300 for co-browsing and live-page checks. Requires that Chrome to be launched with `--remote-debugging-port=29300` once; see [`agent/skills/agent-browser/SKILL.md`](agent/skills/agent-browser/SKILL.md).
- **Deploy** (`/deploy`) — delegates lint/format/verify/deploy to `stevedore` against the actual dirty worktree, not a hardcoded pipeline.
- **Image generation** (Picasso, `agent/skills/generate-image/`) — needs a configured image-capable model; see the skill for its fallback chain.
- **MCP servers** (`agent/mcp.json`) — optional, gitignored; a minimal example lives at [`agent/mcp.example.json`](agent/mcp.example.json). See [CONFIGURATION.md](CONFIGURATION.md#agentmcpjson-upstream-pi-mcp-servers).
- **Web search** (`web_search`/`fetch_content`) — optional, needs an Exa API key via `web-search.json` or `EXA_API_KEY`; example at [`web-search.example.json`](web-search.example.json). `fetch_content` works without a key.
- **Custom models/providers** (`agent/models.json`) — optional, gitignored; example at [`agent/models.example.json`](agent/models.example.json).
- **LSP navigation** — uses language servers already on `PATH`; none of this is installed or required for basic use.
- **`bg_*` background-process tools** run on any platform. The PowerShell tool needs a PowerShell executable on `PATH` — `pwsh`/`pwsh.exe`/`powershell.exe` on Windows, `pwsh` (PowerShell 7+) on Linux/macOS — or `PI_POWERSHELL_PATH` set explicitly; it is not guaranteed to be preinstalled everywhere. This configuration is developed on Windows, so Git Bash examples below have a PowerShell equivalent where it matters.

Start with a working Pi model provider; add these integrations only when you need them.

## Setup

**Requirements:** Node.js matching the engine range of the pinned `@earendil-works/pi-coding-agent@0.85.1` (Node ≥22.19), and `git`.

**Try it in a separate clone first.** Pi normally reads `~/.pi/agent`, regardless of where its binary is installed. Clone elsewhere and set `PI_CODING_AGENT_DIR` to select the trial's configuration and default session directory. This is a configuration override, not a filesystem sandbox: agents can still work on the project you open, and optional integrations may use other local resources.

1. Clone this repository somewhere other than `~/.pi`:

   ```bash
   git clone https://github.com/bskimball/pi.git pi-trial
   cd pi-trial
   ```

2. Install dependencies from the clone root:

   ```bash
   npm install
   ```

   MCP is built into Pi (0.99.0+); no adapter package is required. See [CONFIGURATION.md](CONFIGURATION.md#agentmcpjson-upstream-pi-mcp-servers) for native server setup and validation.

3. Launch the pinned binary from your target project directory, with `PI_CODING_AGENT_DIR` pointed at this clone's `agent/` folder. Replace the example paths with **absolute** paths. Use a dedicated terminal for the trial and close it afterward; the PowerShell environment assignment lasts for that terminal session.

   ```bash
   # Git Bash / macOS / Linux, run from the project you want to work in
   cd /path/to/your-project
   PI_CODING_AGENT_DIR="/absolute/path/to/pi-trial/agent" "/absolute/path/to/pi-trial/node_modules/.bin/pi"
   ```

   ```powershell
   # PowerShell, run from the project you want to work in
   Set-Location C:\path\to\your-project
   $env:PI_CODING_AGENT_DIR = "C:\absolute\path\to\pi-trial\agent"
   & "C:\absolute\path\to\pi-trial\node_modules\.bin\pi.cmd"
   ```

   The local binary uses this repository's pinned Pi version rather than whichever global version is installed. Delegated workers inherit the same agent-directory override and use the running Pi installation; a separate global `pi` command is not required.

4. Run `/login` to authenticate with a supported built-in provider, or configure your provider's API key using [Pi's provider documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md). `/login` stores credentials in `auth.json` directly inside `PI_CODING_AGENT_DIR` (`pi-trial/agent/auth.json`, gitignored).

5. Pick your own provider: the tracked `agent/settings.json` defaults to `defaultProvider: "openai-codex"` / `defaultModel: "gpt-6-sol"`, which requires ChatGPT Codex authentication. Open `/model` (or edit `agent/settings.json` in the clone) and choose a `defaultProvider`/`defaultModel` that names a provider you actually authenticated in step 4, or your own entry in `agent/models.json` (see step 6). There is no `enabledModels` allowlist, so the picker shows every configured provider. If you plan to exercise Apex or Apex Orchestrate dispatch, also check that each file in `agent/agents/*.md` names a model/fallback chain you can actually reach, or adjust it.

6. (Optional) Restore the example configs if you want custom models, MCP servers, or web search — see [Example and template files](#example-and-template-files) below. Because you set `PI_CODING_AGENT_DIR` to the clone's `agent/` folder, copy `agent/mcp.example.json` → `agent/mcp.json` and `agent/models.example.json` → `agent/models.json` inside that same `agent/` folder; copy `web-search.example.json` there too (as `agent/web-search.json`), since `web-search.ts` resolves `web-search.json` inside `PI_CODING_AGENT_DIR` when that variable is set, not the repo root. None of this is required to try `/mode`/`/ui` against a provider you already configured in steps 4–5.

None of the tracked example files are working configuration for you — they show shape, not values. The bundled `openai-codex` default requires your own ChatGPT Codex authentication, while `local-proxy` and other agent-file model routes may rely on this author's private setup; expect to change any route you cannot access before anything runs. Once you're satisfied and want this to be your actual Pi configuration instead of a scoped trial, see [Restore on a new machine](#restore-on-a-new-machine) below.

## Example and template files

Three gitignored, credential-bearing configs have a tracked example sibling — a **minimal supported template**, not a full mirror of the active file, with placeholder/env-only values:

| Active (gitignored) | Example (tracked) |
| --- | --- |
| `agent/mcp.json` | [`agent/mcp.example.json`](agent/mcp.example.json) |
| `agent/models.json` | [`agent/models.example.json`](agent/models.example.json) |
| `web-search.json` | [`web-search.example.json`](web-search.example.json) |

`agent/auth.json` has no example — it's populated by `/login`, not copied.

Copying an example is a starting point, not a drop-in config: placeholders need real values. `agent/mcp.example.json`'s server entry is a sample, not a required one. `agent/models.example.json`'s provider/model IDs are placeholders — if you copy it as-is, also update `agent/settings.json`'s `defaultProvider`/`defaultModel` to match. See [CONFIGURATION.md](CONFIGURATION.md) for field-by-field documentation, and [Restore on a new machine](#restore-on-a-new-machine) below for the exact copy commands.

## Restore on a new machine

1. Clone this repository as `~/.pi`. **Back up any existing `~/.pi` first — do not overwrite an existing installation.**
2. Install dependencies:

   ```bash
   npm install
   ```

3. Restore the ignored local configuration files from their tracked examples (see [CONFIGURATION.md](CONFIGURATION.md) for field details):

   ```bash
   cp agent/models.example.json agent/models.json
   cp agent/mcp.example.json agent/mcp.json
   cp web-search.example.json web-search.json
   ```

   Prefer leaving `$LOCAL_PROXY_API_KEY` and `$EXA_API_KEY` references in place and defining those environment variables instead of pasting real values. For MCP, `bearerTokenEnv` holds an environment-variable **name** — define that variable, don't paste a token into the field itself.

   If `PI_CODING_AGENT_DIR` is set (for example, when running an isolated clone rather than `~/.pi` directly), `web-search.ts` reads `web-search.json` from that exact directory instead of the repo root — copy the example there instead.
4. Sign in to OAuth-backed providers again with `/login`. `agent/auth.json` is intentionally gitignored and not restored from anything.
5. `agent/models.json` reloads automatically the next time `/model` is opened — no restart needed. The Exa credential is re-read on every `web_search` call. `agent/mcp.json` changes need a restart or `/reload`.

Before committing anything from this repo, review staged files and run a secret scanner such as Gitleaks:

```bash
git diff --cached
gitleaks git --staged
```

## Where to read next

- [CONFIGURATION.md](CONFIGURATION.md) — field-by-field reference for every config/markdown format used here (`mcp.json`, `models.json`, `settings.json`, agent frontmatter, prompt templates, skills, themes, extensions), each linked to the authoritative upstream Pi doc where one exists.
- [CONTEXT.md](CONTEXT.md) — the internal extension architecture: the standalone-extension rule, presentation ownership, the sync-vs-async task system, the Fusion sidekick lifecycle, and long-session stability mechanisms. Read this before modifying an extension.
- [AGENTS.md](AGENTS.md) — the working instructions this repo gives to the agent operating on itself.
- [`agent/extensions/prompt-commands/README.md`](agent/extensions/prompt-commands/README.md) — the exact `/mode`/`/ui` switching, persistence, and storage contract.
