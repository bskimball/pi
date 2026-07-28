# Pi configuration

Personal configuration for [Pi](https://github.com/earendil-works/pi-mono) — a customized coding-agent setup with a fleet of specialist sub-agents, TUI extensions, and slash commands for browser automation and deployment.

Credentials are stored directly in the local configuration files that consume them; those files are excluded by `.gitignore`.

## Overview

This repo layers several things on top of a stock Pi install:

- **A `task` tool and a roster of specialist sub-agents** (`agent/agents/`) whose prompts are adapted from [Amp](https://ampcode.com/)'s published agent and sub-agent prompts, with additional custom agents added.
- **Extensions** (`agent/extensions/`) that provide the task/orchestration tooling, background-process management, a custom "Mono" TUI presentation layer, and crash logging.
- **Slash commands / prompts** (`agent/prompts/`), including `/browser` for authenticated browser automation and `/deploy` for delegated ship-it workflows.
- **Skills** (`agent/skills/`) for image generation and background processes.

## Sub-agents and the `task` tool

Pi's main agent delegates bounded units of work to specialist sub-agents through a single `task` tool. Each task spawns a separate `pi` process with the specialist's own system prompt, model, thinking level, and tool set, then streams its activity back into the parent session and returns a single final report.

The task tool and the sub-agent prompts are **based on Amp's prompts and sub-agents**. Amp ships a small set of built-in sub-agents (an orchestrator, a search/oracle reviewer, a librarian, and fast workers); the reference prompts live under `reference/amp-prompts/` and are used as behavioral and structural templates. On top of that foundation this configuration adds a broader roster of purpose-built specialists:

| Agent | Role |
| --- | --- |
| `advisor` | Strategic planner consulted before consequential approaches, when stuck, or when changing direction. Advisory only. |
| `artisan` | Bold visual-design and frontend specialist for substantial UI work, diagrams, slides, data visualization, and polished human-facing artifacts. |
| `librarian` | Remote source-code researcher for external libraries, framework internals, and cross-repository investigation. |
| `machinist` | Workhorse coding specialist for large implementation chunks, backend logic, refactors, migrations, bug fixes, and tests. |
| `oracle` | Deep independent code reviewer and debugger for difficult bugs, conflicting evidence, and high-stakes decisions. |
| `picasso` | Image-generation specialist for concept art, UI renderings, illustrations, icons, logos, textures, and diagrams. |
| `scout` | Fast, cheap local codebase reconnaissance for broad scans, architecture mapping, and context gathering. |
| `scribe` | Editorial writing specialist for blog posts, articles, documentation, launch copy, and long-form prose. |
| `stevedore` | Fast ops specialist for deploys and CLI chores: lint, format, build, git, and platform CLIs. |

Shared norms that apply to every specialist (non-interactive reporting, smallest-correct-change discipline, browser rules, etc.) live in `agent/agents/_shared.md`. Each agent file also declares its primary model plus a fallback chain, so a task keeps running even if a provider is unavailable.

## Extensions

Custom TUI and orchestration extensions live in `agent/extensions/`:

- **`mono/amp-task.ts`** — implements the `task` tool and sub-agent execution. Each task spawns a separate `pi --mode json -p` process using the agent prompt from `agent/agents/*.md`, with hard/idle/turn guards, model fallbacks, streaming, and cleanup kept local to the extension. It renders rich task presentation: specialist badges, mission, model, thinking level, turn count, live tool activity, durations, and bounded final reports.
- **`mono/mono-ui.ts`** — the "Mono" presentation layer: styled built-in `read`/`bash`/`edit`/`write` rows, bounded output previews, diffs, a context footer, and a working animation. Degrades to bounded fallback output on renderer failure.
- **`mcp-adapter.ts`** — composes Mono's MCP presentation with the root `pi-mcp-adapter` dependency on one `ExtensionAPI`. Do not also add `pi-mcp-adapter` to `agent/settings.json` packages; independent package loading would initialize a second MCP extension and bypass this shared presentation wrapper.
- **`bg-process.ts`** — background-process management (`bg_start`, `bg_status`, `bg_list`, `bg_kill`) for dev servers and watchers.
- **`crash-logger.ts`** — records exits, shutdown reasons, and unhandled rejections to `agent/pi-crash.log`, distinguishing main and sub-agent processes.

## Slash commands

Custom prompts are registered in `agent/settings.json` and defined under `agent/prompts/`.

### `/browser`

Attaches to a **dedicated authenticated debug Chrome** and co-browses with you. Chrome's daily-profile remote debugging shows an **Allow** dialog on every new client; this command sidesteps that by using a separate profile with classic CDP on port **29300**:

```text
chrome --remote-debugging-port=29300 --user-data-dir=~/.pi/browser/chrome-profile
```

Google/Microsoft logins persist in this dedicated profile after a one-time sign-in. A deterministic pre-step runs `agent/bin/browser-connect.mjs connect` to idempotently attach, then the agent uses `agent-browser --cdp 29300` (snapshot/click/fill/batch) to drive the page. It never launches a ghost browser and never touches the daily Chrome profile.

```
/browser https://mail.google.com
/browser check staging dashboard
```

### `/deploy`

Delegates lint, format, verify, and deploy to the `stevedore` sub-agent instead of running the deploy inline. A deterministic pre-step captures the git worktree, branch, HEAD, and a dirty-file inventory, then the main agent hands `stevedore` a complete self-contained brief:

- Work only inside the resolved absolute worktree path.
- Discover and run the project's own lint/format/typecheck/test/build/deploy scripts.
- Treat the full dirty tree as the release contents (no partial subsets), excluding only true noise/secrets/generated artifacts.
- Deploy to the stated target, verify, and report back with final `git status`.

```
/deploy staging
/deploy wrangler, skip tests
```

## Restore on a new machine

1. Clone this repository as `~/.pi`.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Restore the ignored local configuration files containing credentials:
   - `agent/models.json` for model-provider API keys
   - `agent/mcp.json` for MCP credentials
   - `web-search.json` for web-search provider keys
4. Sign in to OAuth-backed providers again with Pi's `/login` command. `agent/auth.json` is intentionally ignored.
5. Restart Pi after changing these configuration files.

`.env.example` remains a reference for the supported key names, but Pi does not automatically load the repository's `.env` file.

Before committing, review the staged files and run a secret scanner such as Gitleaks:

```bash
git diff --cached
gitleaks git --staged
```
