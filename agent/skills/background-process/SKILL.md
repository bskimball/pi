---
name: background-process
description: Start, inspect, and stop long-running shell jobs (dev servers, watchers, bundlers) with bg_start/bg_status/bg_list/bg_kill. Use when a command must keep running while the agent continues other work; prefer bash for short finite builds and tests.
---

# Background Process Tools

Use the `bg_*` tools for long-running processes. Use `bash` for short, finite commands.

## Tools

- `bg_start` — start a command; returns a job id and pid when available.
  - `command` (required): shell command, e.g. `npm run dev`. Runs in `cmd.exe` on Windows, the configured POSIX shell elsewhere. On Windows use cmd syntax, not Bash-style `NAME=value command`; prefer a project's existing env-file support for secrets.
  - `title` (optional): short label for listings
  - `working_dir` (optional): must exist; defaults to session cwd
  - `persistent` (optional, default false): survive Pi shutdown/restart. A detached runner owns the command and bounded logs. Resume the same conversation to recover the original id with `bg_list`, `bg_status`, or `bg_kill`; another conversation cannot manage it. Does not restart the command after it exits or after a machine reboot.
- `bg_status` — bounded status + stdout/stderr tails for one job id
- `bg_list` — running and recent settled jobs
- `bg_kill` — kill the job's full process tree

## Rules

- Use `persistent: true` for a user-requested dev server that should remain available between Pi launches. Omit it for temporary verification servers, bundlers, and watchers that should stop with the session.
- Pass the foreground command (`npm run dev`), not `start`, `nohup`, or a self-daemonizing launcher: `bg_start` provides the background lifetime. On Windows, tree termination needs the managed shell to remain alive; an escaped daemon cannot be safely recovered by killing an old PID.
- Prefer `bash` for builds, tests, one-shot scripts, and anything expected to finish quickly.
- No interactive stdin: the job's stdin stays open and unused so servers that exit on EOF keep running. Do not start prompts that wait for input, and do not try to write to stdin.
- After start, keep working; call `bg_status` when you need logs or readiness, not on a tight loop.
- `bg_kill` when the job is no longer needed so npm/node descendants do not linger (especially on Windows). Temporary jobs also stop on session shutdown. Persistent jobs require explicit cleanup; leave a user-requested persistent server running until it is no longer needed.
- If the runner is unavailable or stop is unconfirmed, report that state. Do not kill a PID from an old record: inspect the live process before manual cleanup.
- Cap is a small number of concurrent jobs; kill idle ones before starting more.
- Tool output is intentionally truncated; tails are recent output only.
