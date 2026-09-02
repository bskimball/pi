// Shared implementations for /browser and /deploy executable pre-steps.
// Portable: no personal absolute paths, shell scripts, or prompt-template package.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
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

function handOffHidden(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  customType: string,
  prompt: string,
  busyNotice: string,
): void {
  const idle = ctx.isIdle();
  pi.sendMessage(
    {
      customType,
      content: prompt,
      display: false,
    },
    idle
      ? { triggerTurn: true }
      : { triggerTurn: true, deliverAs: "followUp" },
  );
  if (!idle) notify(ctx, busyNotice, "info");
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
  const taskTarget = task || "(blank — no task was provided; ask what to do after reporting tabs)";

  const sections = [
    skillBlock,
    `Co-browse in dedicated authenticated debug Chrome for: ${taskTarget}`,
    "",
    "Interact with web applications using an authenticated browser session over classic CDP on port 29300. Pause for explicit confirmation before executing any destructive, transactional, or irreversible action.",
    "",
    "## Scope",
    "- With URL or task argument: navigate to the specified destination or execute the requested browser flow.",
    "- Without arguments: connect, inspect open tabs, and request instructions.",
    "- In scope: navigating pages, taking interactive snapshots, inspecting DOM state, filling inputs, and clicking elements within the dedicated Chrome profile (`<pi-browser-profile>`).",
    "- Out of scope: using daily Chrome debugging (`--remote-debugging-port=29242`), running bare `agent-browser` without `--cdp 29300`, launching ghost browser instances, or terminating the dedicated Chrome session when done. Public read-only lookups should use `web_search` and `fetch_content` instead.",
    "",
    "## Attach",
    "Chrome daily-profile remote debugging (`chrome://inspect#remote-debugging`) displays an Allow dialog for every new client connection. We avoid Allow spam by using a dedicated user data profile with classic CDP on port 29300:",
    "",
    "```text",
    "chrome --remote-debugging-port=29300 --user-data-dir=<pi-browser-profile>",
    "```",
    "",
    "Classic CDP exposes `http://127.0.0.1:29300/json/version` and never prompts Allow on connect. Ignore port 29242 (daily Chrome UI debugging) unless explicitly directed. Google and Microsoft logins persist in this dedicated profile after a one-time login and are not copied from daily Chrome.",
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
    "Attach steps:",
    "1. Connect and verify isolation under attach rules:",
    "   - **Never use plain `agent-browser`.** Every invocation must explicitly target this instance with `agent-browser --cdp 29300 ...`, or use the Node helper. Plain commands can launch a ghost browser.",
    "   - **Never use autoConnect / daily Chrome UI debugging** unless explicitly requested, avoiding Allow spam.",
    "   - **Never start, stop, or reuse a chrome-devtools CLI daemon.** The configured chrome-devtools MCP already targets `http://127.0.0.1:29300` and serves as fallback-only for network, performance, or console inspection.",
    "   - Expected mode is **classic** on port **29300**. If classic HTTP discovery is unavailable, stop and report; do not loop retries or attach to another browser.",
    "   - If pages are logged out, run `node <browser-connect-helper> login` and prompt the user to sign into Google or Microsoft once in the dedicated debug Chrome window.",
    "   - Do not close or stop the dedicated Chrome instance after completing the task unless explicitly requested. Never stop daily Chrome.",
    "   Criterion: classic CDP connectivity on port 29300 verified with Allow dialog confirmed absent.",
    "2. Emit the connect-status summary to the user:",
    "   - mode (`classic` expected) + port (`29300`)",
    "   - whether Allow is required (**should be no**)",
    "   - open tabs",
    "   - next action for the task (if blank, ask what to do)",
    "   Criterion: four-item connect-status report emitted before any `agent-browser` interaction.",
    "",
    "## Act",
    "Proceed with browser actions only after emitting the connect-status report in Attach and confirming classic CDP on port 29300.",
    "",
    "1. Inspect initial page state using `agent-browser --cdp 29300 snapshot -i` to capture interactive elements and active tab URLs. Criterion: tab list and element snapshot obtained.",
    "2. Execute navigation and interaction using `agent-browser --cdp 29300` (`click`, `fill`, `batch`, `open`) referencing stable ref indices from the snapshot. Re-snapshot after DOM mutations or page transitions. Criterion: target interactions executed and verified against updated snapshots.",
    "3. Request explicit confirmation before performing any destructive or irreversible action (logout, deletion, purchase, or permanent submission). Criterion: destructive actions gated on user approval.",
    "",
    "## Report",
    "Provide a structured outcome summary of the completed browser task:",
    "- Completed actions and resulting page states",
    "- Direct answers, findings, or data extracted from the target pages",
    "- If authentication is missing or confirmation is required, state the exact input needed from the user",
    "",
    "Wait for user direction if no task was supplied, or pause for approval before executing destructive actions.",
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
  const extraTarget = extra || "(none provided — use project default deploy target)";

  return [
    `Ship the current project using the stevedore subagent: ${extraTarget}`,
    "",
    "Delegate all lint, format, test, build, and deployment execution to the stevedore subagent. Do not run the deploy directly or edit project files yourself.",
    "",
    "## Scope",
    "- Target: the active repository worktree identified in the pre-step snapshot.",
    `- Arguments: extra deploy instructions or target environment (${extraTarget}). If empty, use the project's default deployment target.`,
    "- In scope: resolving the absolute worktree path, auditing the complete dirty file inventory, assembling a self-contained brief, delegating via `task`, and answering or relaying `need_decision`.",
    "- Out of scope: executing deploy commands directly in the supervisor session, shipping from an unverified worktree, deploying from the Pi agent config tree unless that is the explicit target, or omitting uncommitted project changes.",
    "",
    "## Resolve",
    "Use the pre-step snapshot below to establish the release baseline before delegating:",
    "1. Determine the absolute worktree path: set worktree path to `git_toplevel` when present, otherwise fallback to `session_cwd`. On Windows, use a native path, never a bash-only path. Criterion: absolute native worktree path determined.",
    "2. Confirm target repository identity: verify you are shipping this exact worktree (branch and dirty files from the snapshot), not a sibling worktree, not the Pi agent config tree, and not another project inferred from conversation history. Criterion: target worktree identity confirmed against snapshot.",
    "3. Disambiguate worktrees: if `git worktree list` shows multiple worktrees and the release target is ambiguous, stop and ask me — do not guess. Criterion: target worktree unambiguous or decision requested.",
    "4. Inventory release contents: treat the dirty tree as the release contents. Inventory all modified, staged, and untracked project files from the snapshot. Never deploy a partial subset of recent files while leaving related dirty changes uncommitted or unreleased. Criterion: complete dirty inventory recorded.",
    "",
    "## Delegate",
    "Delegate deployment only after resolving the absolute worktree path and verifying the release inventory.",
    "",
    "Call the `task` tool once with:",
    "- `agent`: `stevedore`",
    "- `cwd`: the absolute worktree path from Resolve (**required** — always pass it explicitly)",
    "- `prompt`: a complete, self-contained brief (stevedore has no access to conversation history)",
    "",
    "Build the brief from:",
    "- Absolute working directory (repeat the same path passed as `cwd`)",
    "- Branch and HEAD commit from the snapshot",
    "- Full dirty-file inventory (or \"clean\") from the snapshot — not a selective subset",
    "- Relevant conversation context (what changed, target environment, known gotchas)",
    `- Extra instructions: ${extraTarget}`,
    "",
    "Instruct stevedore in the brief to:",
    "1. Work exclusively inside the provided absolute `cwd` / worktree. Refuse execution if `pwd` or `git rev-parse --show-toplevel` does not match.",
    "2. Re-run `git status --short --branch` and reconcile against the inventory in the brief. If the tree changed, use live status and report the delta.",
    "3. Discover the project's own lint, format, typecheck, test, build, and deploy scripts from package configuration or repository conventions.",
    "4. Run lint and format checks, fixing only mechanical issues.",
    "5. Run build and tests; a failing build blocks deploy.",
    "6. Enforce worktree completeness for release:",
    "   - Default: deploy the entire current worktree (all current project changes on disk), not a hand-picked subset.",
    "   - If commit or push is required or requested, stage and commit the full intended project change set (prefer repository-scoped `git add -A` after reviewing status). Never partially stage a feature while leaving related project files dirty.",
    "   - Exclude only true noise, secrets, and generated artifacts (`node_modules/`, ignored build output, `.env*`, credentials, local scratch). If unsure whether a dirty file belongs in the release, stop with `need_decision` instead of omitting it silently.",
    "   - After any commit: re-run `git status`. If project files that should have shipped remain dirty or untracked, fix staging and amend only if the commit has not been pushed and the brief permits; otherwise create a follow-up commit or stop and report. Never report success with a partial commit.",
    "7. Deploy to the stated target. If the target is ambiguous, contact the supervisor with `need_decision` instead of guessing.",
    "8. Verify the deployment and report results in structured format, including final `git status`.",
    "",
    "If stevedore contacts you with `need_decision`, answer from context or relay the question to me.",
    "Criterion: stevedore subagent dispatched with complete brief and explicit `cwd`.",
    "",
    "## Report",
    "When stevedore finishes, provide a structured summary:",
    "- Worktree path and branch",
    "- Pre-flight check results (lint, format, tests, build)",
    "- Release completeness confirmation (verifying full dirty set was included)",
    "- Target and deployment outcome (what was deployed where)",
    "- Verification results and final `git status`",
    "- Any follow-ups or open issues",
    "",
    "Wait for stevedore to complete and report, or relay its questions if a decision is needed.",
    "",
    "## Pre-step snapshot",
    "",
    snapshot,
  ].join("\n");
}

type BrowserAttachResult =
  | { ok: true; prompt: string; skillLoaded: boolean }
  | { ok: false; message: string };

async function attachBrowser(
  pi: ExtensionAPI,
  args: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<BrowserAttachResult> {
  const helperPath = resolveBrowserConnectHelper();
  if (!existsSync(helperPath)) {
    return {
      ok: false,
      message: "Browser helper is missing from the agent bin directory.",
    };
  }

  const extraArgs = args.trim() ? [args.trim()] : [];
  const started = Date.now();
  let result: { code: number; stdout: string; stderr: string; killed: boolean };
  try {
    result = await pi.exec(
      process.execPath,
      [helperPath, "connect", ...extraArgs],
      {
        cwd,
        timeout: BROWSER_CONNECT_TIMEOUT_MS,
        signal,
      },
    );
  } catch (error) {
    const message = redactPersonalPaths(
      error instanceof Error ? error.message : String(error),
    );
    return { ok: false, message: `Browser connect failed: ${message}` };
  }

  const durationMs = Date.now() - started;
  const connectBlock = buildConnectBlock(result, durationMs);
  if (result.code !== 0 || result.killed) {
    const stderr = boundText(
      redactPersonalPaths(result.stderr),
      800,
      12,
    ).text;
    return {
      ok: false,
      message: `Browser connect failed (exit ${result.code}${result.killed ? ", killed" : ""}).${stderr ? ` ${stderr}` : ""}`,
    };
  }

  const skill = loadSkillBody(pi, "agent-browser");
  const skillBlock = skill
    ? wrapSkill("agent-browser", skill.body)
    : undefined;
  return {
    ok: true,
    prompt: buildBrowserPrompt(args, connectBlock, skillBlock),
    skillLoaded: skill !== undefined,
  };
}

export function registerBrowserAttachTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "browser_attach",
    label: "Browser Attach",
    description:
      "Attach to the dedicated authenticated debug Chrome and return the custom browser handoff prompt. Use this FIRST for natural-language requests that require live-page interaction, clicks, form filling, login state, screenshots, or browser inspection. Do not invoke agent-browser directly before this tool. A prompt that already contains a successful [Connect step] is already attached.",
    promptSnippet:
      "For live-page browser work, call browser_attach first; then follow its returned custom browser prompt.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({
        description: "The browser task or HTTP(S) URL from the user.",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const task = typeof params.task === "string" ? params.task : "";
      const attached = await attachBrowser(
        pi,
        task,
        ctx?.cwd ?? process.cwd(),
        signal,
      );
      return {
        content: [{
          type: "text" as const,
          text: attached.ok ? attached.prompt : attached.message,
        }],
        details: {},
        isError: !attached.ok,
      };
    },
  });
}

export async function runBrowserCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionContext,
): Promise<void> {
  const attached = await attachBrowser(pi, args, ctx.cwd, ctx.signal);
  if (!attached.ok) {
    notify(ctx, attached.message, "error");
    return;
  }
  if (!attached.skillLoaded) {
    notify(
      ctx,
      "agent-browser skill not found; continuing without skill injection.",
      "warning",
    );
  }

  handOffHidden(
    pi,
    ctx,
    "browser-handoff",
    attached.prompt,
    "Browser prompt queued as follow-up.",
  );
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
