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
    "## Pinned tab",
    "Connect with an explicit HTTP(S) URL before any agent-browser interaction. The helper reuses an exact URL match; for a root URL without query or fragment, it may reuse a same-origin app tab, preserving its route and state. Otherwise it opens the requested URL in a new tab. Without a URL it only lists pages; identify the task target and connect again with its URL. Keep the unique `AGENT_BROWSER_SESSION` and `AGENT_BROWSER_PIN_TAB=1`, and pass no `--session`. The helper selects the target before enabling strict pinning. Matching app tabs may be shared: coordinate browser actions rather than acting concurrently. Leave reused and newly opened tabs open unless explicitly asked to close them. Never change unrelated tabs or run `agent-browser close`. On `tab_gone`, stop and report instead of falling back. Each specialist must connect its own session with the target URL even if the lead already connected. The chrome-devtools MCP fallback is not pinned: select the intended page explicitly.",
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
      runGit(pi, cwd, ["rev-parse", "--verify", "HEAD"], signal),
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
  const extraTarget = args.trim() || "(none provided — resolve the documented project default)";
  return [
    `Deploy the approved project revision using the stevedore subagent: ${extraTarget}`,
    "",
    "Delegate verification, build, and deployment execution to Stevedore. The lead resolves scope and permissions, provides a self-contained brief, and relays any `need_decision`; it does not run the deployment itself.",
    "",
    "## Scope and permission",
    "- `/deploy` authorizes deployment to the confirmed target and delegation to Stevedore. It is not `/ship`: Git checkpoint/integration commits, pushes, PR landing, and branch/worktree cleanup require task-specific permission already granted or obtained before those actions.",
    "- When Git closeout is needed, read the shipping skill and use its task-scoped helper under that permission. Carry the task id, owned paths, destination, and exact revision into the brief. A deployment script that needs a commit/push does not itself grant Git permission; detect push-triggered deployments before any Git mutation.",
    "- Preserve unrelated staged, unstaged, untracked, and ignored files in their original checkout. The snapshot is discovery evidence, not approval to adopt the dirty tree. Re-read live state when the snapshot is stale or truncated.",
    `- Extra instructions/target: ${extraTarget}. Without an explicit environment, use only an unambiguous documented project default. Resolve and name the actual account, project, environment, and database before remote mutation; ask if ambiguous.`,
    "- Stay in the explicitly identified project, not a sibling worktree, the Pi agent config tree, or a project inferred from history. The Pi config tree is a target only when explicitly requested. Separate version bumps, release publication, and local installation need their own authorization.",
    "",
    "## Resolve",
    "1. Resolve the native absolute repository/worktree path from `git_toplevel` (otherwise `session_cwd`) in the snapshot. Read its instructions and canonical deployment pipeline. If multiple worktrees make the intended source ambiguous, ask once. Criterion: exact project and target identified.",
    "2. Select the approved full commit SHA from the request/current task, preferring its recorded landed revision after `/ship`. Do not silently substitute another HEAD or deploy an outdated commit while intended changes remain uncommitted. Resolve those changes through authorized scoped checkpoints first, or stop with `need_decision`. Criterion: intended changes and excluded work accounted for.",
    "3. Use a clean checkout at that SHA, or an existing immutable artifact proven to come from it, without moving or discarding unrelated work. Before creating an isolated checkout, follow the shipping skill's ownership rules. For non-Git projects, identify an immutable artifact/digest or reproducible source snapshot instead of inventing a commit. Criterion: source provenance established and selected deployment cwd explicit.",
    "",
    "## Delegate",
    "Call `task` once with `agent: stevedore`, the selected absolute deployment `cwd`, and a self-contained prompt. The brief must contain:",
    "- Project path, branch/full SHA or artifact identity, approved deployment target and canonical pipeline.",
    "- Shipping task id and existing Git permissions when applicable; otherwise explicitly state that Git mutations are not authorized.",
    "- Owned changes, the full observed dirty-file inventory and preserved exclusions, plus the clean checkout/artifact selected for deployment.",
    "- Applicable exact-revision verification evidence, relevant environment/dependency changes, migration requirements, and extra instructions.",
    "",
    "Instruct Stevedore to:",
    "1. Confirm cwd, repository identity, source SHA/artifact, live status, and target against the brief. Stop on drift; do not expand scope to new dirty files.",
    "2. Run the canonical lint, format-check, typecheck, test, and build gates needed for the selected revision and deployment environment. Reuse prior evidence only for the same revision and applicable environment. A failed required gate blocks deployment; report it to the owner rather than choosing a weaker command.",
    "3. Keep source checks non-mutating during deployment. Mechanical fixes require an explicitly authorized owned scope; if a fix is authorized, checkpoint it through Shipping as permitted, invalidate old review/check evidence, and verify/build the new revision before continuing. Never deploy a partial staged index or substitute a dirty tree for the verified source.",
    "4. If authorized Git steps are necessary, use Shipping's scoped checkpoints/integration/publication/landing workflow. Preserve unrelated index entries; never use `git add -A` or `git add .`. Do not merge PRs or delete artifacts merely because deployment was requested.",
    "5. Confirm the actual account/project/environment/database before deploying. Follow the canonical migration/rollout order: required migrations must precede code that depends on them, including when a push triggers rollout. Verify migration state/schema; stop with `need_decision` for an unapproved destructive or incompatible migration plan.",
    "6. Deploy the verified revision/artifact through the canonical pipeline. Re-check source identity before rollout; on retries inspect prior deployment/migration state before repeating mutations.",
    "7. Verify the live target: observed deployment version/artifact identity, health, and at least one changed contract when applicable. An accepted CI/deploy command is pending until the rollout is confirmed; report pending/failed honestly rather than claiming it is live.",
    "",
    "Wait for the report or relay `need_decision`. Do not infer new permissions from a blocked prerequisite.",
    "",
    "## Report",
    "- Exact project/worktree and deployed source SHA/artifact; task and Git delivery state when applicable.",
    "- Checks/review used, their revision, and anything failed, skipped, or unverified.",
    "- Account/project/environment, deployment command and observed rollout ID/URL/status.",
    "- Migration results and ordering; live health/changed-contract evidence.",
    "- Final Git status, unrelated work preserved, any authorized cleanup, and remaining blockers.",
    "",
    "Git publication, landing, cleanup, deployment, and local installation are separate outcomes. State what actually completed.",
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
      "Attach to the dedicated authenticated debug Chrome and return the custom browser handoff prompt. When the host exposes `browser_tabs` (Apex), call it first and act on the extension-shared or preview tabs it returns with the host `browser_*` tools; use this tool only when no such tab fits or the user asks for the dedicated debug browser. Otherwise use it before agent-browser for live-page interaction, clicks, form filling, login state, screenshots, or browser inspection. A prompt that already contains a successful [Connect step] is already attached. In Apex Orchestrate mode, live-page verification (shared/preview tabs or debug Chrome) routes to the inspector specialist, which has the same browser tools.",
    promptSnippet:
      "Browser routing: if `browser_tabs` exists, list it first and use the host browser_* tools on the user's shared/preview tabs. Only when none fits, or the user asks for the debug browser, call browser_attach and follow its returned prompt. In Apex Orchestrate, dispatch the inspector for live-page checks instead of doing them yourself. chrome-devtools MCP is a fallback for network/console/performance inspection; computer_use_* tools only for native input no page-level tool can perform.",
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
