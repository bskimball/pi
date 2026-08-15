---
name: agent-browser
description: Browser automation for this Pi installation. Use for website interaction only through the dedicated authenticated debug Chrome on classic CDP port 29300. This is the same browser pathway configured by /browser; never launch or select another browser/profile.
---

# Dedicated Browser Automation

This Pi installation has one supported browser target: the dedicated authenticated debug Chrome on classic CDP port **29300**, using profile `~/.pi/browser/chrome-profile`.

The `/browser` command performs the preferred deterministic connect step before handing browser work to the agent. When browser work arrives as a natural-language request instead, reproduce that same pathway with the helper below. Slash commands are user-facing pathways; do not emit `/browser` as text and assume it will execute. If the current prompt already contains a successful `[Connect step]`, do not connect again; use its result and continue with interaction.

## Connect first

Resolve the helper independently of the current working directory:

```bash
BROWSER_CONNECT="${PI_AGENT_DIR:-$HOME/.pi/agent}/bin/browser-connect.mjs"
node "$BROWSER_CONNECT" connect
node "$BROWSER_CONNECT" status
node "$BROWSER_CONNECT" tabs
```

Use `node "$BROWSER_CONNECT" open <url>` when a URL needs to be opened before interaction.

Expected mode is `classic` on port `29300`. If classic HTTP discovery is unavailable, stop and report the blocker. Do not attach to another browser or retry through a different mechanism.

## Hard rules

- Every CLI invocation MUST include `--cdp 29300`:
  ```bash
  agent-browser --cdp 29300 snapshot -i
  agent-browser --cdp 29300 click @e1
  agent-browser --cdp 29300 fill @e2 "value"
  agent-browser --cdp 29300 batch "click @e1" "wait 1000" "snapshot -i"
  ```
- Never run plain `agent-browser`. It can launch a ghost unauthenticated browser.
- Never use `--auto-connect`, `--profile`, `--session-name`, `--state`, `profiles`, or an auth vault. Authentication already lives in the dedicated profile.
- Never run `agent-browser open <url>` without `--cdp 29300`; prefer the helper's `open` command.
- Never run `agent-browser close` or stop the dedicated Chrome. If the user wants it closed, ask them to close the dedicated window manually. Never stop daily Chrome.
- Never use daily Chrome UI debugging, autoConnect, or port `29242`. That path causes repeated **Allow** dialogs.
- Never start, stop, or reuse a chrome-devtools CLI daemon. The configured chrome-devtools MCP already targets port `29300` and is fallback-only for console, network, performance, or accessibility work that the CLI cannot cover.
- If Google or Microsoft is logged out during initial profile setup, run `node "$BROWSER_CONNECT" login` and ask the user to complete the one-time sign-in in the dedicated Chrome window. For any other logged-out site, stop and ask the user to authenticate in that window. Do not copy or extract authentication state.

## Interaction workflow

1. If no successful `[Connect step]` is present, connect and inspect tabs with the helper; otherwise use the supplied connection result.
2. Run `agent-browser --cdp 29300 snapshot -i` to obtain element refs.
3. Interact with refs using commands that retain `--cdp 29300`.
4. Re-snapshot after navigation or meaningful DOM changes.
5. Ask before destructive or externally consequential actions such as logout, deletion, purchase, message send, or irreversible submit.

Use the upstream `agent-browser` command set as needed, but the dedicated-target rules above override generic examples that omit `--cdp 29300` or create a separate browser session.
