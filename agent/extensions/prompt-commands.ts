// Native implementations for /browser and /deploy (executable pre-steps) and
// /orchestrate (sticky per-turn system-prompt mode).
// Portable: no personal absolute paths, shell scripts, or prompt-template package.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  stripFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PREVIEW_CHARS = 8_000;
const PREVIEW_LINES = 120;
const STDERR_PREVIEW_CHARS = 4_000;
const STDERR_PREVIEW_LINES = 40;
const BROWSER_CONNECT_TIMEOUT_MS = 90_000;
const GIT_TIMEOUT_MS = 30_000;
const SKILL_BODY_CHARS = 24_000;
const SKILL_BODY_LINES = 400;

const ORCHESTRATE_ENTRY_TYPE = "orchestrate-mode";

const ORCHESTRATE_SYSTEM_BLOCK = `

## Strict orchestrator mode (active)

The user has switched this session into strict orchestrator mode. This overrides the inline-by-default coordination model above: the inline allowance is revoked until the user turns this mode off (/orchestrate off). You are the lead: you decide the split, write the work orders, integrate results, verify, and answer — you do not do the detailed work yourself.

- Do not write or edit code yourself, even single-file edits. Every implementation unit goes to machinist (non-visual) or artisan (UI/visual), however small. The only exceptions are trivial mechanical fixes to a specialist's just-returned diff (a typo, a missed import) where a dispatch round-trip is clearly wasteful — note it in your report when you do.
- Do not read broadly yourself. Handle direct symbol/path lookups with \`rg\`; everything wider goes to scout. Keep your context for coordination state: scope, assignments, returned evidence, blockers, verification status.
- Every task meeting the todo threshold gets a \`todo_write\` plan before the first dispatch, with one item per delegable unit.
- Prefer \`task_start\` and keep useful lead work going while specialists run; parallelize independent read-only units, serialize writers per worktree, and \`task_close\` finished workers.
- Every implementation diff gets a fresh-eyes review — oracle for risky, tricky, or multi-file work; a fresh reviewing agent otherwise. The implementer's self-review never closes a unit.
- Verification is yours to own: run the combined validation yourself or delegate a fresh verification pass and inspect its result before reporting done. Route routine read-only browser and screenshot checks after UI changes to inspector; use artisan when verification requires design judgment, exploratory refinement, or implementation changes.
- Consult advisor before consequential approach choices or when specialists return conflicting findings; use librarian when a unit depends on external/dependency internals.

The non-negotiable gates apply with zero inline exemptions: in this mode "tiny task" is not a reason to skip delegation. If a unit truly cannot be delegated (credentials, interactive auth, user-only decisions), surface it to the user instead of doing it silently.`;

function cleanText(value: string): string {
  return value.replace(/\u0000/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactPersonalPaths(value: string): string {
  let redacted = cleanText(value);
  const home = process.env.USERPROFILE || process.env.HOME;
  const replacements = [
    { path: getAgentDir(), label: "<pi-agent-dir>" },
    ...(home ? [{ path: home, label: "<home>" }] : []),
  ];

  for (const replacement of replacements) {
    const variants = new Set([
      replacement.path,
      replacement.path.replace(/\\/g, "/"),
      replacement.path.replace(/\//g, "\\"),
    ]);
    for (const variant of variants) {
      if (!variant) continue;
      redacted = redacted.replace(
        new RegExp(escapeRegExp(variant), "gi"),
        replacement.label,
      );
    }
  }
  return redacted;
}

function boundText(
  value: string,
  maxChars: number,
  maxLines: number,
): { text: string; truncated: boolean; totalChars: number; totalLines: number } {
  const text = cleanText(value ?? "");
  const lines = text.length === 0 ? [] : text.replace(/\r\n/g, "\n").split("\n");
  const totalChars = text.length;
  const totalLines = lines.length === 0 && text.length === 0 ? 0 : lines.length;

  let limited = lines.slice(0, maxLines).join("\n");
  let truncated = totalLines > maxLines;
  if (limited.length > maxChars) {
    limited = limited.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) {
    const omittedChars = Math.max(0, totalChars - limited.length);
    const omittedLines = Math.max(0, totalLines - Math.min(totalLines, maxLines));
    limited = `${limited}\n...[truncated, ${omittedChars} more chars / ${omittedLines} more lines omitted]`;
  }
  return { text: limited, truncated, totalChars, totalLines };
}

function notify(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  process.stderr.write(`${message}\n`);
}

function handOff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
  busyNotice = "Agent is busy; queued as follow-up.",
): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
    return;
  }
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  notify(ctx, busyNotice, "info");
}

function resolveBrowserConnectHelper(): string {
  return join(getAgentDir(), "bin", "browser-connect.mjs");
}

function resolveRegisteredSkillPath(
  pi: ExtensionAPI,
  skillName: string,
): string | undefined {
  const normalized = skillName.startsWith("skill:")
    ? skillName.slice("skill:".length)
    : skillName;
  if (!normalized) return undefined;
  const candidates = new Set([normalized, `skill:${normalized}`]);

  for (const command of pi.getCommands()) {
    if (command.source !== "skill") continue;
    if (!candidates.has(command.name)) continue;
    const path = command.sourceInfo?.path;
    if (path && existsSync(path)) return path;
  }
  return undefined;
}

function resolveSkillPathFallback(skillName: string): string | undefined {
  const normalized = skillName.startsWith("skill:")
    ? skillName.slice("skill:".length)
    : skillName;
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) {
    return undefined;
  }

  const candidates = [
    join(getAgentDir(), "skills", normalized, "SKILL.md"),
    join(getAgentDir(), "skills", `${normalized}.md`),
  ];

  // Portable global agents skill location (no username hardcoding).
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    candidates.push(
      join(home, ".agents", "skills", normalized, "SKILL.md"),
      join(home, ".agents", "skills", `${normalized}.md`),
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function loadSkillBody(pi: ExtensionAPI, skillName: string): {
  body: string;
  path: string;
} | undefined {
  const skillPath =
    resolveRegisteredSkillPath(pi, skillName) ??
    resolveSkillPathFallback(skillName);
  if (!skillPath) return undefined;
  try {
    const raw = readFileSync(skillPath, "utf8");
    const body = stripFrontmatter(raw).trim();
    const bounded = boundText(body, SKILL_BODY_CHARS, SKILL_BODY_LINES);
    return { body: bounded.text, path: skillPath };
  } catch {
    return undefined;
  }
}

function wrapSkill(skillName: string, body: string): string {
  return `<skill name="${skillName}">\n${body}\n</skill>`;
}

function buildBrowserPrompt(args: string, connectBlock: string, skillBlock?: string): string {
  const task = args.trim();
  const taskLine = task
    ? `Task/URL from me: ${task}`
    : "Task/URL from me: (blank — no task was provided; ask what to do after reporting tabs)";

  const sections = [
    skillBlock,
    "You are co-browsing with me in a **dedicated authenticated debug Chrome**.",
    "",
    "## Why this exists",
    "",
    "Chrome's daily-profile remote debugging (`chrome://inspect#remote-debugging`) shows an **Allow** dialog for every new client. We avoid it with a separate profile and classic CDP on port **29300**:",
    "",
    "```text",
    "chrome --remote-debugging-port=29300 --user-data-dir=<pi-browser-profile>",
    "```",
    "",
    "Classic CDP exposes `http://127.0.0.1:29300/json/version` and does **not** prompt Allow on each connect. Port **29242** is often daily Chrome UI debugging (Allow spam) — ignore it unless I say otherwise.",
    "",
    "Google/Microsoft logins live in this dedicated profile. They persist after a one-time `login` setup; they are not copied from daily Chrome.",
    "",
    "## Helper",
    "",
    "A portable Node helper was already used for the attach step. Prefer that same helper path from the connect block below (do not search the workspace for it, and do not assume it is on PATH):",
    "",
    "```text",
    "node <browser-connect-helper> connect",
    "node <browser-connect-helper> status",
    "node <browser-connect-helper> tabs",
    "node <browser-connect-helper> open <url>",
    "node <browser-connect-helper> login",
    "```",
    "",
    "## Hard rules",
    "",
    "1. **Never use plain `agent-browser`.** Every invocation must explicitly target this instance with `agent-browser --cdp 29300 ...`, or use the Node helper. Plain commands can launch a ghost browser.",
    "2. **Never use autoConnect / daily Chrome UI debugging** unless I explicitly ask. That path causes Allow spam.",
    "3. **Never start, stop, or reuse a chrome-devtools CLI daemon.** The configured chrome-devtools MCP already targets `http://127.0.0.1:29300` and is fallback-only for network, performance, or console work.",
    "4. Prefer `agent-browser --cdp 29300` for interaction (`snapshot -i`, `click`, `fill`, `batch`).",
    "5. If pages are logged out, run the helper's `login` subcommand and tell me to sign into Google/Microsoft **once** in the dedicated debug Chrome window.",
    "6. Expected mode is **classic** on port **29300**. If classic HTTP discovery is unavailable, stop and report; do not loop retries or attach to another browser.",
    "7. Do not close or stop the dedicated Chrome after the task unless I explicitly request it. Never stop daily Chrome.",
    "",
    "## Workflow",
    "",
    "```text",
    "node <browser-connect-helper> status",
    "node <browser-connect-helper> tabs",
    "agent-browser --cdp 29300 snapshot -i",
    "# act with agent-browser --cdp 29300 and refs, then re-snapshot after DOM/navigation changes",
    "```",
    "",
    taskLine,
    "",
    "## After the deterministic connect step",
    "",
    "Report briefly:",
    "",
    "1. mode (`classic` expected) + port",
    "2. whether Allow is required (**should be no**)",
    "3. open tabs",
    "4. next action for the task",
    "",
    "Then do the browser work. Ask before destructive actions (logout, delete, purchase, irreversible submits).",
    "",
    connectBlock,
  ].filter((part): part is string => part !== undefined);

  return sections.join("\n");
}

function buildConnectBlock(
  result: { code: number; stdout: string; stderr: string; killed: boolean },
  durationMs: number,
): string {
  const stdout = boundText(
    redactPersonalPaths(result.stdout),
    PREVIEW_CHARS,
    PREVIEW_LINES,
  );
  const stderr = boundText(
    redactPersonalPaths(result.stderr),
    STDERR_PREVIEW_CHARS,
    STDERR_PREVIEW_LINES,
  );
  return [
    "[Connect step]",
    `status: ${result.code === 0 && !result.killed ? "succeeded" : "failed"}`,
    `exitCode: ${result.code}`,
    `killed: ${result.killed ? "true" : "false"}`,
    `durationMs: ${durationMs}`,
    "",
    "[stdout]",
    `lineCount: ${stdout.totalLines}`,
    `charCount: ${stdout.totalChars}`,
    `truncated: ${stdout.truncated ? "true" : "false"}`,
    "preview:",
    stdout.text || "(empty)",
    "",
    "[stderr]",
    `lineCount: ${stderr.totalLines}`,
    `charCount: ${stderr.totalChars}`,
    `truncated: ${stderr.truncated ? "true" : "false"}`,
    "preview:",
    stderr.text || "(empty)",
  ].join("\n");
}

async function runGit(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await pi.exec("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    signal,
  });
  return {
    code: result.code,
    stdout: cleanText(result.stdout).trimEnd(),
    stderr: cleanText(result.stderr).trimEnd(),
  };
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

async function gatherDeployContext(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const lines: string[] = [`session_cwd=${cwd}`];

  const toplevel = await runGit(pi, cwd, ["rev-parse", "--show-toplevel"], signal);
  if (toplevel.code !== 0) {
    lines.push("git_toplevel=");
    lines.push("NOT_A_GIT_REPO=1");
    if (toplevel.stderr) {
      const err = boundText(toplevel.stderr, 500, 8);
      lines.push(`git_probe_stderr=${err.text}`);
    }
    return lines.join("\n");
  }

  const gitRoot = toplevel.stdout.trim();
  lines.push(`git_toplevel=${gitRoot}`);

  const [branch, head, status, worktrees, modified, staged, untracked] =
    await Promise.all([
      runGit(pi, cwd, ["branch", "--show-current"], signal),
      runGit(pi, cwd, ["rev-parse", "--short", "HEAD"], signal),
      runGit(pi, cwd, ["status", "--short", "--branch"], signal),
      runGit(pi, cwd, ["worktree", "list"], signal),
      runGit(pi, cwd, ["diff", "--name-only"], signal),
      runGit(pi, cwd, ["diff", "--cached", "--name-only"], signal),
      runGit(pi, cwd, ["ls-files", "--others", "--exclude-standard"], signal),
    ]);

  lines.push(`git_branch=${branch.stdout.trim()}`);
  lines.push(`git_head=${head.stdout.trim()}`);
  lines.push("--- git status --short --branch ---");
  lines.push(status.stdout || "(clean / empty status)");
  lines.push("--- git worktree list ---");
  lines.push(worktrees.stdout || "(none)");
  lines.push("--- dirty summary ---");

  const modifiedLines = nonEmptyLines(modified.stdout);
  const stagedLines = nonEmptyLines(staged.stdout);
  const untrackedLines = nonEmptyLines(untracked.stdout);

  lines.push(`modified_tracked=${modifiedLines.length}`);
  lines.push(`staged=${stagedLines.length}`);
  lines.push(`untracked=${untrackedLines.length}`);
  lines.push("--- modified tracked ---");
  lines.push(
    modifiedLines.length > 0
      ? boundText(modifiedLines.join("\n"), PREVIEW_CHARS, PREVIEW_LINES).text
      : "(none)",
  );
  lines.push("--- staged ---");
  lines.push(
    stagedLines.length > 0
      ? boundText(stagedLines.join("\n"), PREVIEW_CHARS, PREVIEW_LINES).text
      : "(none)",
  );
  lines.push("--- untracked ---");
  lines.push(
    untrackedLines.length > 0
      ? boundText(untrackedLines.join("\n"), PREVIEW_CHARS, PREVIEW_LINES).text
      : "(none)",
  );

  return lines.join("\n");
}

function buildDeployPrompt(args: string, snapshot: string): string {
  const extra = args.trim();
  const extraLine = extra
    ? `Extra instructions: ${extra}`
    : "Extra instructions: (none provided — use the project's default deploy target.)";

  return [
    "Ship the current project using the `stevedore` subagent — do not run the deploy yourself.",
    "",
    "## Resolve the worktree first (mandatory)",
    "",
    "Use the pre-step snapshot below. Before delegating:",
    "",
    "1. Set **absolute worktree path** = `git_toplevel` when present, otherwise the session `session_cwd`. On Windows use a native path, never a bash-only path.",
    "2. Confirm you are shipping **this** worktree (branch + dirty files from the snapshot), not a sibling worktree, not the Pi agent config tree, and not some other project inferred from conversation alone.",
    "3. If `git worktree list` shows multiple worktrees and the intended one is ambiguous, stop and ask me — do not guess.",
    "4. Treat the dirty tree as the release contents. Inventory **all** modified, staged, and untracked project files from the snapshot. Do not ship a partial subset of the conversation's \"recent files\" while leaving related dirty files behind.",
    "",
    "## Delegate",
    "",
    "Call the `task` tool once with:",
    "- `agent`: `stevedore`",
    "- `cwd`: the absolute worktree path from step 1 (**required** — always pass it explicitly)",
    "- a complete self-contained brief (stevedore has no conversation access)",
    "",
    "Build the brief from:",
    "- Absolute working directory (repeat the same path you passed as `cwd`)",
    "- Branch / HEAD from the snapshot",
    "- Full dirty-file inventory (or \"clean\") from the snapshot — not a selective subset",
    "- Anything relevant from our conversation (what changed, which env, known gotchas)",
    `- ${extraLine}`,
    "",
    "The brief must tell stevedore to:",
    "1. Work only inside the provided absolute `cwd` / worktree. Refuse if `pwd` / `git rev-parse --show-toplevel` does not match.",
    "2. Re-run `git status --short --branch` and reconcile against the inventory in the brief. If the tree changed, use the live status and report the delta.",
    "3. Discover the project's own lint/format/typecheck/test/build/deploy scripts and use those.",
    "4. Run lint and format checks, fixing only mechanical issues.",
    "5. Run build/tests; a red build blocks deploy.",
    "6. **Worktree completeness for release:**",
    "   - Default: deploy the **entire current worktree** (all current project changes on disk), not a hand-picked subset.",
    "   - If commit and/or push is part of shipping (explicitly requested by me, or required by the project's release path), stage and commit the **full intended project change set**. Prefer `git add -A` scoped to the repo after reviewing status. Never partially stage \"some of the feature\" while leaving related project files dirty.",
    "   - Exclude only true noise/secrets/generated artifacts (e.g. `node_modules/`, build output already ignored, `.env*`, credentials, local scratch). If unsure whether a dirty file belongs in the release, stop with `need_decision` instead of omitting it silently.",
    "   - After any commit: re-run `git status`. If project files that should have shipped are still dirty/untracked, fix the staging and amend only if the commit has not been pushed and the brief allows it; otherwise make a follow-up commit or stop and report. Do not report success with a partial commit.",
    "7. Deploy to the stated target; if the target is ambiguous, contact you (supervisor) instead of guessing — answer its ask, don't let it stall.",
    "8. Verify the deploy and report back in its structured format, including final `git status` after the operation.",
    "",
    "If stevedore contacts you with `need_decision`, relay the question to me if you can't answer it from context.",
    "",
    "When it finishes, give me a short summary: worktree path + branch, pre-flight results, whether the full dirty set was included, what was deployed where, verification, final git status, and any follow-ups.",
    "",
    "## Pre-step snapshot",
    "",
    snapshot,
  ].join("\n");
}

export async function runBrowserCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionContext,
): Promise<void> {
  const helperPath = resolveBrowserConnectHelper();
  if (!existsSync(helperPath)) {
    notify(
      ctx,
      "Browser helper is missing from the agent bin directory.",
      "error",
    );
    return;
  }

  const extraArgs = args.trim() ? [args.trim()] : [];
  const started = Date.now();
  let result: { code: number; stdout: string; stderr: string; killed: boolean };
  try {
    result = await pi.exec(
      process.execPath,
      [helperPath, "connect", ...extraArgs],
      {
        cwd: ctx.cwd,
        timeout: BROWSER_CONNECT_TIMEOUT_MS,
        signal: ctx.signal,
      },
    );
  } catch (error) {
    const message = redactPersonalPaths(
      error instanceof Error ? error.message : String(error),
    );
    notify(ctx, `Browser connect failed: ${message}`, "error");
    return;
  }
  const durationMs = Date.now() - started;
  const connectBlock = buildConnectBlock(result, durationMs);

  if (result.code !== 0 || result.killed) {
    const stderr = boundText(
      redactPersonalPaths(result.stderr),
      800,
      12,
    ).text;
    notify(
      ctx,
      `Browser connect failed (exit ${result.code}${result.killed ? ", killed" : ""}).${stderr ? ` ${stderr}` : ""}`,
      "error",
    );
    return;
  }

  const skill = loadSkillBody(pi, "agent-browser");
  if (!skill) {
    notify(
      ctx,
      "agent-browser skill not found; continuing without skill injection.",
      "warning",
    );
  }

  const skillBlock = skill
    ? wrapSkill("agent-browser", skill.body)
    : undefined;
  const prompt = buildBrowserPrompt(args, connectBlock, skillBlock);
  handOff(pi, ctx, prompt, "Browser prompt queued as follow-up.");
  notify(ctx, "Browser attached; handed off to agent.", "info");
}

export async function runDeployCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionContext,
): Promise<void> {
  let snapshot: string;
  try {
    snapshot = await gatherDeployContext(pi, ctx.cwd, ctx.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, `Failed to gather deploy context: ${message}`, "error");
    return;
  }

  const boundedSnapshot = boundText(snapshot, 20_000, 300);
  handOff(
    pi,
    ctx,
    buildDeployPrompt(args, boundedSnapshot.text),
    "Deploy handoff queued as follow-up.",
  );
  notify(ctx, "Deploy context gathered; delegated via task handoff.", "info");
}

/**
 * Run a featured pathway command that is implemented as a native extension
 * slash command rather than a prompt template. Used by Observatory launch.
 */
export async function runFeaturedExtensionCommand(
  pi: ExtensionAPI,
  name: string,
  args: string,
  ctx: ExtensionContext,
): Promise<void> {
  if (name === "browser") {
    await runBrowserCommand(pi, args, ctx);
    return;
  }
  if (name === "deploy") {
    await runDeployCommand(pi, args, ctx);
    return;
  }
  throw new Error(`No featured handler registered for /${name}`);
}

export default function (pi: ExtensionAPI): void {
  let orchestrateMode = false;

  const setOrchestrateMode = (
    enabled: boolean,
    ctx: ExtensionContext,
  ): void => {
    if (orchestrateMode === enabled) {
      notify(
        ctx,
        `Orchestrator mode already ${enabled ? "on" : "off"}.`,
        "info",
      );
      return;
    }
    orchestrateMode = enabled;
    pi.appendEntry(ORCHESTRATE_ENTRY_TYPE, { enabled });
    notify(
      ctx,
      enabled
        ? "Strict orchestrator mode ON — lead delegates all implementation."
        : "Strict orchestrator mode OFF — inline allowance restored.",
      "info",
    );
  };

  pi.registerCommand("orchestrate", {
    description:
      "Toggle strict orchestrator mode (no inline edits; delegate everything)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") setOrchestrateMode(true, ctx);
      else if (arg === "off") setOrchestrateMode(false, ctx);
      else if (arg === "" || arg === "toggle") {
        setOrchestrateMode(!orchestrateMode, ctx);
      } else {
        notify(ctx, "Usage: /orchestrate [on|off]", "warning");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === ORCHESTRATE_ENTRY_TYPE
      ) {
        const data = entry.data as { enabled?: boolean } | undefined;
        orchestrateMode = data?.enabled === true;
      }
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!orchestrateMode) return undefined;
    return {
      systemPrompt: event.systemPrompt + ORCHESTRATE_SYSTEM_BLOCK,
    };
  });

  pi.registerCommand("browser", {
    description:
      "Attach to dedicated authenticated debug Chrome (no Allow spam)",
    handler: async (args, ctx) => {
      await runBrowserCommand(pi, args, ctx);
    },
  });

  pi.registerCommand("deploy", {
    description:
      "Delegate lint, format, verify, and deploy to the stevedore subagent",
    handler: async (args, ctx) => {
      await runDeployCommand(pi, args, ctx);
    },
  });
}
