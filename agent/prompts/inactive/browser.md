---
description: Attach to dedicated authenticated debug Chrome (no Allow spam)
argument-hint: "[url or task, e.g. 'https://mail.google.com' or 'check staging dashboard']"
deterministic:
  run: |
    node "${PI_AGENT_DIR:-$HOME/.pi/agent}/bin/browser-connect.mjs" connect "$1"
  handoff: always
  timeout: 90000
skill: agent-browser
---
Co-browse in dedicated authenticated debug Chrome for: $@

Interact with web applications using an authenticated browser session over classic CDP on port 29300. Pause for explicit confirmation before executing any destructive, transactional, or irreversible action.

## Scope
- With URL or task argument: navigate to the specified destination or execute the requested browser flow.
- Without arguments: connect, inspect open tabs, and request instructions.
- In scope: navigating pages, taking interactive snapshots, inspecting DOM state, filling inputs, and clicking elements within the dedicated Chrome profile (`~/.pi/browser/chrome-profile`).
- Out of scope: using daily Chrome debugging (`--remote-debugging-port=29242`), running bare `agent-browser` without `--cdp 29300`, launching ghost browser instances, or terminating the dedicated Chrome session when done. Public read-only lookups should use `web_search` and `fetch_content` instead.

## Attach
Chrome daily-profile remote debugging (`chrome://inspect#remote-debugging`) displays an Allow dialog for every new client connection. We avoid Allow spam by using a dedicated user data profile with classic CDP on port 29300:

```text
chrome --remote-debugging-port=29300 --user-data-dir=~/.pi/browser/chrome-profile
```

Classic CDP exposes `http://127.0.0.1:29300/json/version` and never prompts Allow on connect. Ignore port 29242 (daily Chrome UI debugging) unless explicitly directed. Google and Microsoft logins persist in this dedicated profile after a one-time login and are not copied from daily Chrome.

Resolve the Node helper independently of working directory or `PATH`:
```bash
BROWSER_CONNECT="${PI_AGENT_DIR:-$HOME/.pi/agent}/bin/browser-connect.mjs"
node "$BROWSER_CONNECT" connect   # idempotent attach
node "$BROWSER_CONNECT" status
node "$BROWSER_CONNECT" tabs
node "$BROWSER_CONNECT" open <url>
node "$BROWSER_CONNECT" login     # one-time Google/Microsoft sign-in
```
Do not search the project workspace for `browser-connect` and do not assume it is on `PATH`.

Attach steps:
1. Connect and verify isolation under attach rules:
   - **Never use plain `agent-browser`.** Every invocation must explicitly target this instance with `agent-browser --cdp 29300 ...`, or use the Node helper. Plain commands can launch a ghost browser.
   - **Never use autoConnect / daily Chrome UI debugging** unless explicitly requested, avoiding Allow spam.
   - **Never start, stop, or reuse a chrome-devtools CLI daemon.** The configured chrome-devtools MCP already targets `http://127.0.0.1:29300` and serves as fallback-only for network, performance, or console inspection.
   - Expected mode is **classic** on port **29300**. If classic HTTP discovery is unavailable, stop and report; do not loop retries or attach to another browser.
   - If pages are logged out, run `node "$BROWSER_CONNECT" login` and prompt the user to sign into Google or Microsoft once in the dedicated debug Chrome window.
   - Do not close or stop the dedicated Chrome instance after completing the task unless explicitly requested. Never stop daily Chrome.
   Criterion: classic CDP connectivity on port 29300 verified with Allow dialog confirmed absent.
2. Emit the connect-status summary to the user:
   - mode (`classic` expected) + port (`29300`)
   - whether Allow is required (**should be no**)
   - open tabs
   - next action for the task (if blank, ask what to do)
   Criterion: four-item connect-status report emitted before any `agent-browser` interaction.

## Act
Proceed with browser actions only after emitting the connect-status report in Attach and confirming classic CDP on port 29300.

1. Inspect initial page state using `agent-browser --cdp 29300 snapshot -i` to capture interactive elements and active tab URLs. Criterion: tab list and element snapshot obtained.
2. Execute navigation and interaction using `agent-browser --cdp 29300` (`click`, `fill`, `batch`, `open`) referencing stable ref indices from the snapshot. Re-snapshot after DOM mutations or page transitions. Criterion: target interactions executed and verified against updated snapshots.
3. Request explicit confirmation before performing any destructive or irreversible action (logout, deletion, purchase, or permanent submission). Criterion: destructive actions gated on user approval.

## Report
Provide a structured outcome summary of the completed browser task:
- Completed actions and resulting page states
- Direct answers, findings, or data extracted from the target pages
- If authentication is missing or confirmation is required, state the exact input needed from the user

Wait for user direction if no task was supplied, or pause for approval before executing destructive actions.
