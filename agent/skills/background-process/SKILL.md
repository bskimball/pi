---
name: background-process
description: Start, inspect, and stop long-running shell jobs (dev servers, watchers) with bg_start/bg_status/bg_list/bg_kill. Use when a command must keep running while the agent continues other work.
---

# Background Process Tools

Use the `bg_*` tools for long-running processes. Use `bash` for short, finite commands.

## Tools

- `bg_start` — start a command; returns immediately with a stable job id (`bg_N`) and pid when available.
  - `command` (required): shell command, e.g. `npm run dev`
  - `title` (optional): short label for listings
  - `working_dir` (optional): must exist; defaults to session cwd
- `bg_status` — bounded status + stdout/stderr tails for one job id
- `bg_list` — running and recent settled jobs
- `bg_kill` — kill the job's full process tree

## Rules

- Prefer `bg_start` for servers, bundlers, file watchers, and other keep-alive processes.
- Prefer `bash` for builds, tests, one-shot scripts, and anything expected to finish quickly.
- No interactive stdin: do not start prompts that wait for user input.
- After start, keep working; call `bg_status` when you need logs or readiness, not on a tight loop.
- Always `bg_kill` when finished so npm/node descendants do not linger (especially on Windows).
- Cap is a small number of concurrent jobs; kill idle ones before starting more.
- Tool output is intentionally truncated; tails are recent output only.
