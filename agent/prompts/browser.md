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
You are co-browsing with me in a **dedicated authenticated debug Chrome**.

## Why this exists

Chrome's daily-profile remote debugging (`chrome://inspect#remote-debugging`) shows an **Allow** dialog for every new client. We avoid it with a separate profile and classic CDP on port **29300**:

```text
chrome --remote-debugging-port=29300 --user-data-dir=~/.pi/browser/chrome-profile
```

Classic CDP exposes `http://127.0.0.1:29300/json/version` and does **not** prompt Allow on each connect. Port **29242** is often daily Chrome UI debugging (Allow spam) — ignore it unless I say otherwise.

Google/Microsoft logins live in this dedicated profile. They persist after a one-time `login` setup; they are not copied from daily Chrome.

## Helper

Resolve the Node helper independently of the current working directory or `PATH`:

```bash
BROWSER_CONNECT="${PI_AGENT_DIR:-$HOME/.pi/agent}/bin/browser-connect.mjs"
node "$BROWSER_CONNECT" connect   # idempotent attach
node "$BROWSER_CONNECT" status
node "$BROWSER_CONNECT" tabs
node "$BROWSER_CONNECT" open <url>
node "$BROWSER_CONNECT" login     # one-time Google/Microsoft sign-in
```

Do not search the project workspace for `browser-connect` and do not assume it is on `PATH`.

## Hard rules

1. **Never use plain `agent-browser`.** Every invocation must explicitly target this instance with `agent-browser --cdp 29300 ...`, or use the Node helper. Plain commands can launch a ghost browser.
2. **Never use autoConnect / daily Chrome UI debugging** unless I explicitly ask. That path causes Allow spam.
3. **Never start, stop, or reuse a chrome-devtools CLI daemon.** The configured chrome-devtools MCP already targets `http://127.0.0.1:29300` and is fallback-only for network, performance, or console work.
4. Prefer `agent-browser --cdp 29300` for interaction (`snapshot -i`, `click`, `fill`, `batch`).
5. If pages are logged out, run `node "$BROWSER_CONNECT" login` and tell me to sign into Google/Microsoft **once** in the dedicated debug Chrome window.
6. Expected mode is **classic** on port **29300**. If classic HTTP discovery is unavailable, stop and report; do not loop retries or attach to another browser.
7. Do not close or stop the dedicated Chrome after the task unless I explicitly request it. Never stop daily Chrome.

## Workflow

```bash
BROWSER_CONNECT="${PI_AGENT_DIR:-$HOME/.pi/agent}/bin/browser-connect.mjs"
node "$BROWSER_CONNECT" status
node "$BROWSER_CONNECT" tabs
agent-browser --cdp 29300 snapshot -i
# act with agent-browser --cdp 29300 and refs, then re-snapshot after DOM/navigation changes
```

Task/URL from me (blank means no task was provided; ask what to do after reporting tabs): $@

## After the deterministic connect step

Report briefly:

1. mode (`classic` expected) + port
2. whether Allow is required (**should be no**)
3. open tabs
4. next action for the task

Then do the browser work. Ask before destructive actions (logout, delete, purchase, irreversible submits).
