// amp-task: Mono Missions task tool and subagent execution.
//
// One `task` tool. Each task spawns a separate `pi --mode json -p` process with
// the agent's system prompt from ~/.pi/agent/agents/*.md. Child lifetime remains
// process lifetime; hard/idle/turn guards, fallbacks, streaming, and cleanup are
// intentionally kept local to this extension.

import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  safeTruncateToWidth,
  safeVisibleWidth,
} from "./lib/safe-text-layout.ts";
import {
  WidthText,
  cleanInline,
  fitLine,
  formatDuration,
  textContent,
  type ToolRenderContext,
} from "./lib/ui-common.ts";

// ---------------------------------------------------------------- agents

interface AgentDef {
  name: string;
  description: string;
  model?: string;
  fallbackModels: string[];
  thinking?: string;
  tools?: string;
  maxTurns?: number;
  timeoutSec?: number;
  /** Skills are prompt-injected and read via the read tool; false passes --no-skills. */
  inheritSkills: boolean;
  body: string;
  file: string;
}

const AGENT_DIRS = [
  path.join(os.homedir(), ".pi", "agent", "agents"),
  path.join(process.cwd(), ".pi", "agents"),
];

function parseAgentFile(file: string): AgentDef | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return undefined;
    const fm = m[1];
    const body = m[2].trim();
    const get = (key: string): string | undefined => {
      const line = fm.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
      return line ? line[1].trim() : undefined;
    };
    const getList = (key: string): string[] => {
      const inline = get(key);
      const clean = (value: string) =>
        value
          .trim()
          .replace(/^(["'])(.*)\1$/, "$2")
          .trim();
      if (inline) {
        return inline
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map(clean)
          .filter(Boolean);
      }
      const block = fm.match(
        new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]+-.*(?:\\r?\\n|$))+)`, "m"),
      );
      if (!block) return [];
      return block[1]
        .split(/\r?\n/)
        .map((line) =>
          clean(line.match(/^[ \t]+-[ \t]*(.+?)[ \t]*$/)?.[1] ?? ""),
        )
        .filter(Boolean);
    };
    return {
      name: get("name") ?? path.basename(file, ".md"),
      description: get("description") ?? "",
      model: get("model"),
      fallbackModels: getList("fallbackModels"),
      thinking: get("thinking"),
      tools: get("tools"),
      maxTurns: get("maxTurns")
        ? Number(get("maxTurns")) || undefined
        : undefined,
      timeoutSec: get("timeoutSec")
        ? Number(get("timeoutSec")) || undefined
        : undefined,
      inheritSkills: get("inheritSkills") !== "false",
      body,
      file,
    };
  } catch {
    return undefined;
  }
}

function discoverAgents(): Map<string, AgentDef> {
  const agents = new Map<string, AgentDef>();
  for (const dir of AGENT_DIRS) {
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md") && !f.startsWith("_"));
    } catch {
      continue;
    }
    for (const file of files) {
      const def = parseAgentFile(path.join(dir, file));
      if (def) agents.set(def.name, def);
    }
  }
  return agents;
}

// Shared files in the agents dirs (project overrides global):
// _shared.md is prepended to every agent's system prompt; _handoff.md is
// passed via --append-system-prompt so only subagents get it.
function readSharedFile(name: string): string | undefined {
  for (const dir of [...AGENT_DIRS].reverse()) {
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8").trim();
      if (text) return text;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- visual helpers

const RESET = "\x1b[0m";
const ansiFg = (hex: string, text: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}${RESET}`;
};

const IDENTITIES: Record<string, { icon: string; hue: string }> = {
  advisor: { icon: "A", hue: "#63d7c6" },
  artisan: { icon: "R", hue: "#d7a6ff" },
  librarian: { icon: "L", hue: "#79b8ff" },
  machinist: { icon: "M", hue: "#79e2b1" },
  oracle: { icon: "O", hue: "#c9a7ff" },
  picasso: { icon: "P", hue: "#ff9f86" },
  scout: { icon: "S", hue: "#e8c66a" },
  scribe: { icon: "W", hue: "#f2a7b8" },
  stevedore: { icon: "V", hue: "#88a7c2" },
};
const FALLBACK_IDENTITY = { icon: "?", hue: "#9aa8b3" };

function missionFromPrompt(prompt: string): string {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => cleanInline(line, 180))
    .filter(Boolean);
  const goal = lines.find((line) => /^goal\s*:/i.test(line));
  return cleanInline(
    (goal ?? lines[0] ?? "Mission").replace(/^goal\s*:\s*/i, ""),
    140,
  );
}

function shortArgs(args: unknown): string {
  try {
    const a = args as Record<string, unknown>;
    return cleanInline(
      a?.command ??
        a?.path ??
        a?.pattern ??
        a?.url ??
        a?.query ??
        a?.prompt ??
        "",
      100,
    );
  } catch {
    return "";
  }
}

function modelProvider(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

function agentProvider(def: AgentDef | undefined): string | undefined {
  // A bare override inherits only the primary model's provider. Inferring from
  // a fallback could silently route it to an unrelated provider.
  return modelProvider(def?.model);
}

function qualifyModel(
  model: string | undefined,
  provider: string | undefined,
): string | undefined {
  if (!model || model.includes("/") || !provider) return model;
  return `${provider}/${model}`;
}

function modelAttempts(
  def: AgentDef,
  override: string | undefined,
): (string | undefined)[] {
  const provider = agentProvider(def);
  const defaultPrimary = qualifyModel(def.model, provider);
  const qualifiedFallbacks = def.fallbackModels.map((model) =>
    qualifyModel(model, provider),
  );
  // An explicit override replaces only the primary model. The agent's declared
  // fallback chain remains available, while its default primary stays excluded
  // so review-diversity overrides cannot silently fall back to that model even
  // if it was accidentally repeated in fallbackModels.
  const chain = override
    ? [
        qualifyModel(override, provider),
        ...qualifiedFallbacks.filter((model) => model !== defaultPrimary),
      ]
    : [defaultPrimary, ...qualifiedFallbacks];
  const attempts = [
    ...new Set(chain.filter((model): model is string => !!model)),
  ];
  return attempts.length ? attempts : [undefined];
}

function stderrDiagnostic(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => cleanInline(line, 500))
    .filter(Boolean);
  if (!lines.length) return undefined;

  const documentationOnly = (line: string) => {
    const withoutSee = line.replace(/^see:\s*/i, "");
    return (
      !withoutSee ||
      /(?:^|[\\/])docs[\\/](?:models|providers)\.md\b/i.test(withoutSee)
    );
  };
  const useful = lines.filter((line) => !documentationOnly(line));
  const decisive = useful.find((line) =>
    /no api key|unauthori[sz]ed|forbidden|rate limit|authentication|something went wrong|\b(?:error|exception|failed|invalid|unknown|not found|timed out|terminated|refused)\b|\b(?:ECONN\w*|ENOTFOUND|EAI_AGAIN)\b/i.test(
      line,
    ),
  );
  // CLI errors normally lead with the cause and append login/help text. When
  // no keyword matches, the first non-documentation line is more useful than
  // the trailing help line.
  return decisive ?? useful.at(0) ?? lines.at(0);
}

function exitedFailure(
  model: string,
  exitCode: number | null,
  stderr: string,
): string {
  const diagnostic = stderrDiagnostic(stderr);
  return `${model}: subagent exited ${exitCode}${diagnostic ? `: ${diagnostic}` : ""}`;
}

// ---------------------------------------------------------------- task state

type ActivityStatus = "running" | "completed" | "error";
interface MissionActivity {
  id: string;
  tool: string;
  summary: string;
  status: ActivityStatus;
  startedAt: number;
  duration?: number;
}

interface TaskDetails {
  agent: string;
  mission: string;
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  startedAt: number;
  duration?: number;
  activities: MissionActivity[];
  attemptedModels: string[];
  attemptFailures: string[];
  model?: string;
  thinking?: string;
  fallbackUsed?: boolean;
  turns: number;
  exitCode?: number | null;
  killReason?: string;
  finalReport?: string;
}

interface TaskRenderState {
  startedAt?: number;
  endedAt?: number;
  hasResult?: boolean;
}

interface TaskRun {
  agent: string;
  model?: string;
  child?: ChildProcess;
  cancel?: (reason: string) => void;
  done: boolean;
}

const activeRuns = new Set<TaskRun>();
function updateStatus(ctx: ExtensionContext) {
  try {
    const runs = [...activeRuns].filter((run) => !run.done);
    ctx.ui.setStatus("tasks", runs.length ? `tasks:${runs.length}` : undefined);
  } catch {}
}

// Full Pi subprocesses are expensive on Windows. Three balances the SYSTEM.md
// guidance (2-3 typical fan-out) against orphan/process pressure when a parent
// turn dies; larger fan-outs simply queue.
const MAX_CONCURRENT = 3;
let running = 0;
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  running++;
}
function release() {
  running--;
  waiters.shift()?.();
}

function renderActivity(
  activity: MissionActivity,
  theme: any,
  now = Date.now(),
): string {
  const glyph =
    activity.status === "running"
      ? theme.fg("warning", "●")
      : activity.status === "error"
        ? theme.fg("error", "×")
        : theme.fg("success", "✓");
  const detail = theme.fg(
    "dim",
    activity.summary ? `  ${activity.summary}` : "",
  );
  const elapsed = theme.fg(
    "dim",
    formatDuration(activity.duration ?? now - activity.startedAt),
  );
  return `${theme.fg("dim", "   ├")} ${glyph} ${theme.fg("muted", activity.tool)}${detail}  ${elapsed}`;
}

function taskHeader(
  details: TaskDetails,
  theme: any,
  width: number,
  now: number,
): string {
  const identity = IDENTITIES[details.agent.toLowerCase()] ?? FALLBACK_IDENTITY;
  const badge = ansiFg(identity.hue, `[${identity.icon} ${details.agent}]`);
  const meta = [
    details.model,
    details.thinking && `think:${details.thinking}`,
    details.turns > 0 &&
      `${details.turns} turn${details.turns === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  // Task headers and nested activity/report gutters share the lighter dim
  // token so outer and internal tree rails match.
  const left = `${theme.fg("dim", "└")} ${theme.fg("toolTitle", "task")} ${theme.fg("dim", "▸")} ${badge}${meta ? ` ${theme.fg("dim", `(${meta})`)}` : ""} ${theme.fg("text", details.mission)}`;
  const status =
    details.status === "running" || details.status === "queued"
      ? theme.fg("warning", details.status)
      : details.status === "completed"
        ? theme.fg("success", "complete")
        : theme.fg("error", details.status);
  const elapsed = formatDuration(details.duration ?? now - details.startedAt);
  return fitLine(left, `${status} ${theme.fg("dim", elapsed)}`, width);
}

function renderTaskComponent(
  details: TaskDetails,
  expanded: boolean,
  theme: any,
): Component {
  const isRunning = details.status === "running" || details.status === "queued";

  // Keep the rich mission surface on every platform, but render it as one
  // dependency-free width-aware component. This preserves activities, status,
  // badges, failures, and the final report without Markdown, nested containers,
  // or extension-owned render timers.
  return new WidthText((width) => {
    const lines = [taskHeader(details, theme, width, Date.now())];
    const limit = expanded ? 80 : 4;
    const shown = details.activities?.slice(-limit) ?? [];
    const hidden = (details.activities?.length ?? 0) - shown.length;
    if (hidden > 0) lines.push(theme.fg("muted", `   ▸ ${hidden} more steps`));
    const now = Date.now();
    for (const activity of shown)
      lines.push(renderActivity(activity, theme, now));
    if (details.attemptFailures.length) {
      const failures = expanded
        ? details.attemptFailures.slice(-8)
        : details.attemptFailures.slice(-1);
      for (const failure of failures)
        lines.push(
          `${theme.fg("dim", "   └")} ${theme.fg("error", "×")} ${theme.fg("error", cleanInline(failure, 180))}`,
        );
    }
    if (!isRunning && details.finalReport) {
      const reportLines = details.finalReport
        .trim()
        .replace(/\t/g, "   ")
        .split(/\r?\n/)
        .map((line) => {
          const heading = line.match(/^#{1,6}\s+(.+)$/);
          if (heading) return theme.fg("toolTitle", heading[1]);
          const bullet = line.match(/^\s*[-*]\s+(.+)$/);
          if (bullet)
            return `${theme.fg("accent", "•")} ${theme.fg("toolOutput", bullet[1])}`;
          return theme.fg("toolOutput", line);
        });
      const reportLimit = expanded ? 120 : 12;
      const shownReport = reportLines.slice(0, reportLimit);
      if (expanded && width > 2) {
        // Expanded report renders inside a padded background container, like
        // Pi's default ctrl+o tool box.
        const bg = (text: string) => theme.bg("toolSuccessBg", text);
        const innerWidth = width - 2;
        const blank = bg(" ".repeat(width));
        lines.push(blank);
        for (const line of shownReport) {
          const clipped = safeTruncateToWidth(line, innerWidth);
          const fill = " ".repeat(
            Math.max(0, innerWidth - safeVisibleWidth(clipped)),
          );
          lines.push(bg(` ${clipped}${fill} `));
        }
        lines.push(blank);
      } else {
        lines.push(theme.fg("dim", "   │"));
        for (const line of shownReport) {
          lines.push(`${theme.fg("dim", "   │")} ${line}`);
        }
      }
      if (reportLines.length > shownReport.length) {
        lines.push(
          `${theme.fg("dim", "   └")} ${theme.fg("muted", `▸ ${reportLines.length - shownReport.length} more report lines · ctrl+o`)}`,
        );
      }
    }
    return lines;
  }, "[task display unavailable]");
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  const agents = discoverAgents();
  const agentList = [...agents.values()]
    .map((agent) => `- ${agent.name}: ${agent.description}`)
    .join("\n");

  const TaskParams = Type.Object({
    agent: Type.String({
      description: `Agent to run. One of: ${[...agents.keys()].join(", ")}`,
    }),
    prompt: Type.String({
      description:
        "Complete self-contained work order: goal, scope, context, evidence, validation, and expected return format. The agent has no access to this conversation.",
    }),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory for the agent (defaults to current)",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Override the agent's primary model. Use provider/id, or a bare id to inherit the agent's provider. Declared fallback models remain enabled.",
      }),
    ),
    timeoutSec: Type.Optional(
      Type.Number({
        description:
          "Hard time limit in seconds (default 1800, or the agent's own default)",
      }),
    ),
    maxTurns: Type.Optional(
      Type.Number({
        description:
          "Max assistant turns before the agent is stopped (default 30, or the agent's own default)",
      }),
    ),
  });

  pi.registerTool({
    name: "task",
    label: "Task",
    description: `Delegate a bounded unit of work to a specialist subagent running in its own process with a fresh context window. Returns the agent's final report. Issue multiple task calls in one message to run agents in parallel (only with disjoint file ownership for writers).\n\nAvailable agents:\n${agentList}`,
    parameters: TaskParams,
    executionMode: "parallel",
    renderShell: "self",

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const def = agents.get(params.agent);
      const mission = missionFromPrompt(params.prompt);
      const startedAt = Date.now();
      if (!def) {
        const text = `Unknown agent "${params.agent}". Available: ${[...agents.keys()].join(", ")}`;
        return {
          content: [{ type: "text", text }],
          isError: true,
          details: {
            agent: params.agent,
            mission,
            status: "failed",
            startedAt,
            duration: 0,
            activities: [],
            attemptedModels: [],
            attemptFailures: [text],
            turns: 0,
          } satisfies TaskDetails,
        };
      }
      const childCwd = params.cwd ?? ctx.cwd;
      if (!fs.existsSync(childCwd)) {
        const text = `cwd "${childCwd}" does not exist. On Windows, pass a native path (e.g. C:/Users/...), not a bash-style path like /tmp.`;
        return {
          content: [{ type: "text", text }],
          isError: true,
          details: {
            agent: def.name,
            mission,
            status: "failed",
            startedAt,
            duration: Date.now() - startedAt,
            activities: [],
            attemptedModels: [],
            attemptFailures: [text],
            turns: 0,
          } satisfies TaskDetails,
        };
      }

      await acquire();
      const timeoutMs = (params.timeoutSec ?? def.timeoutSec ?? 1800) * 1000;
      const idleMs = 300_000;
      const toolIdleMs = 900_000;
      const maxTurns = params.maxTurns ?? def.maxTurns ?? 30;
      const attempts = modelAttempts(def, params.model);

      const activities: MissionActivity[] = [];
      const attemptedModels: string[] = [];
      const attemptFailures: string[] = [];
      let activeActivity: MissionActivity | undefined;
      let turns = 0;
      let killReason: string | undefined;
      let finalExitCode: number | null = null;
      let finalAssistantText = "";
      let currentModel: string | undefined;

      const snapshot = (
        status: TaskDetails["status"],
        finalReport?: string,
      ): TaskDetails => ({
        agent: def.name,
        mission,
        status,
        startedAt,
        duration:
          status === "running" || status === "queued"
            ? undefined
            : Date.now() - startedAt,
        activities: activities.map((activity) => ({ ...activity })),
        attemptedModels: [...attemptedModels],
        attemptFailures: [...attemptFailures],
        model: currentModel,
        thinking: def.thinking,
        fallbackUsed: attemptedModels.length > 1,
        turns,
        exitCode: finalExitCode,
        killReason,
        finalReport,
      });
      const emit = () => {
        try {
          onUpdate?.({
            content: [{ type: "text", text: `[${def.name}] ${mission}` }],
            details: snapshot("running"),
          });
        } catch {}
      };
      const closeActive = (status: ActivityStatus = "completed") => {
        if (!activeActivity || activeActivity.status !== "running") return;
        activeActivity.status = status;
        activeActivity.duration = Date.now() - activeActivity.startedAt;
        activeActivity = undefined;
      };

      const run: TaskRun = { agent: def.name, done: false };
      const kill = (reason: string) => {
        if (killReason) return;
        killReason = reason;
        const child = run.child;
        if (!child?.pid) return;
        if (process.platform === "win32") {
          try {
            const taskkill = spawn(
              path.join(
                process.env.SystemRoot ?? "C:\\Windows",
                "System32",
                "taskkill.exe",
              ),
              ["/F", "/T", "/PID", String(child.pid)],
              { stdio: "ignore", windowsHide: true },
            );
            const killDirectChildIfAlive = () => {
              if (child.exitCode !== null || child.signalCode !== null) return;
              try {
                if (process.kill(child.pid!, 0)) child.kill();
              } catch {}
            };
            // Node 24 reports spawn failures asynchronously. Always consume the
            // error event and fall back to killing the direct child. taskkill
            // can also spawn successfully but fail to terminate the process.
            taskkill.once("error", killDirectChildIfAlive);
            taskkill.once("close", (code) => {
              if (code !== 0) killDirectChildIfAlive();
            });
          } catch {
            try {
              child.kill();
            } catch {}
          }
          return;
        }
        try {
          child.kill();
        } catch {}
      };
      run.cancel = kill;
      activeRuns.add(run);
      updateStatus(ctx);
      const hardTimer = setTimeout(
        () => kill(`exceeded ${timeoutMs / 1000}s time limit`),
        timeoutMs,
      );
      const onAbort = () => kill("aborted by user");
      signal?.addEventListener("abort", onAbort);
      if (signal?.aborted) onAbort();

      try {
        emit();
        for (
          let attemptIndex = 0;
          attemptIndex < attempts.length;
          attemptIndex++
        ) {
          if (killReason) break;
          const model = attempts[attemptIndex];
          const modelLabel = model ?? "default model";
          currentModel = modelLabel;
          attemptedModels.push(modelLabel);
          run.model = modelLabel;
          updateStatus(ctx);

          const cliJs = process.argv[1];
          const args = [
            cliJs,
            "--mode",
            "json",
            "--no-session",
            "--exclude-tools",
            "task,subagent,wait_for_subagents,wait",
          ];
          if (model) {
            const slash = model.indexOf("/");
            if (slash > 0)
              args.push(
                "--provider",
                model.slice(0, slash),
                "--model",
                model.slice(slash + 1),
              );
            else args.push("--model", model);
          }
          if (def.thinking) args.push("--thinking", def.thinking);
          if (!def.inheritSkills) args.push("--no-skills");
          if (def.tools) {
            const tools = def.tools
              .split(",")
              .map((tool) => tool.trim())
              .filter(Boolean);
            if (tools.length) args.push("--tools", tools.join(","));
          }
          // Children are fire-and-forget: there is no mid-flight channel back
          // to the orchestrator, so agent prompts must escalate via their
          // final report rather than a live supervisor tool.
          const sharedPreamble = readSharedFile("_shared.md");
          const systemPrompt = [sharedPreamble, def.body]
            .filter(Boolean)
            .join("\n\n");
          if (systemPrompt) args.push("--system-prompt", systemPrompt);
          const handoff = readSharedFile("_handoff.md");
          if (handoff) args.push("--append-system-prompt", handoff);
          args.push(params.prompt);

          let child: ChildProcessByStdio<null, Readable, Readable>;
          let spawnFailure: string | undefined;
          try {
            child = spawn(process.execPath, args, {
              cwd: childCwd,
              stdio: ["ignore", "pipe", "pipe"],
              env: {
                ...process.env,
                PI_SUBAGENT: "1",
                PI_SUBAGENT_AGENT: def.name,
                PI_SUBAGENT_MODEL: modelLabel,
              },
            });
            run.child = child;
          } catch (error) {
            spawnFailure =
              error instanceof Error ? error.message : String(error);
            finalExitCode = -1;
            const failure = `${modelLabel}: spawn failed: ${cleanInline(spawnFailure, 300)}`;
            attemptFailures.push(failure);
            emit();
            continue;
          }

          let idleTimer: NodeJS.Timeout | undefined;
          let buffer = "";
          let assistantText = "";
          let assistantError: string | undefined;
          let stderrTail = "";
          let attemptTurns = 0;
          // Tools may legitimately stay quiet longer than model turns, but
          // still need an idle bound below the hard process timeout. Track
          // overlapping calls so one completion cannot end another's budget.
          const activeToolIds = new Set<string>();
          let anonymousTools = 0;
          const hasActiveTools = () =>
            activeToolIds.size > 0 || anonymousTools > 0;
          const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            const toolPhase = hasActiveTools();
            const budgetMs = toolPhase ? toolIdleMs : idleMs;
            const phase = toolPhase ? " during tool execution" : "";
            idleTimer = setTimeout(
              () => kill(`idle for ${budgetMs / 1000}s${phase}`),
              budgetMs,
            );
          };
          resetIdle();

          child.stdout.on("data", (chunk: Buffer) => {
            resetIdle();
            buffer += chunk.toString("utf8");
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              let event: any;
              try {
                event = JSON.parse(line);
              } catch {
                continue;
              }
              try {
                if (event.type === "turn_start") {
                  turns++;
                  attemptTurns++;
                  if (attemptTurns > maxTurns)
                    kill(`exceeded ${maxTurns} turns`);
                } else if (event.type === "tool_execution_start") {
                  if (event.toolCallId == null) anonymousTools++;
                  else activeToolIds.add(String(event.toolCallId));
                  resetIdle();
                  closeActive();
                  activeActivity = {
                    id: String(event.toolCallId ?? activities.length),
                    tool: cleanInline(event.toolName, 40),
                    summary: shortArgs(event.args),
                    status: "running",
                    startedAt: Date.now(),
                  };
                  activities.push(activeActivity);
                  if (activities.length > 400)
                    activities.splice(0, activities.length - 300);
                  emit();
                } else if (event.type === "tool_execution_end") {
                  if (event.toolCallId == null) {
                    // Only match an anonymous end to an anonymous start. Do not
                    // guess which identified overlapping call may have ended.
                    if (anonymousTools > 0) anonymousTools--;
                  } else {
                    activeToolIds.delete(String(event.toolCallId));
                  }
                  resetIdle();
                  if (
                    activeActivity &&
                    (!event.toolCallId ||
                      activeActivity.id === String(event.toolCallId))
                  )
                    closeActive(event.isError ? "error" : "completed");
                  emit();
                } else if (
                  event.type === "message_end" &&
                  event.message?.role === "assistant"
                ) {
                  const message = event.message;
                  assistantError =
                    message.stopReason === "error" || message.errorMessage
                      ? String(message.errorMessage ?? "provider/model error")
                      : undefined;
                  if (Array.isArray(message.content)) {
                    const text = message.content
                      .filter((item: any) => item.type === "text")
                      .map((item: any) => item.text)
                      .join("\n")
                      .trim();
                    if (text) assistantText = text;
                  }
                }
              } catch {}
            }
          });
          child.stderr.on("data", (chunk: Buffer) => {
            resetIdle();
            // Keep enough context to retain the decisive diagnostic even when
            // the CLI follows it with login help and documentation paths.
            stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8000);
          });

          const exitCode: number | null = await new Promise((resolve) => {
            let settled = false;
            const settle = (code: number | null) => {
              if (!settled) {
                settled = true;
                resolve(code);
              }
            };
            child.on("close", settle);
            child.on("error", (error) => {
              spawnFailure = error.message;
              stderrTail = (
                stderrTail + `\nspawn error: ${error.message}`
              ).slice(-8000);
              settle(-1);
            });
          });
          if (idleTimer) clearTimeout(idleTimer);
          closeActive(killReason || exitCode !== 0 ? "error" : "completed");
          run.child = undefined;
          finalExitCode = exitCode;
          finalAssistantText = assistantText;
          emit();
          if (killReason) break;

          const retryFailure = assistantError
            ? `${modelLabel}: ${cleanInline(assistantError, 300)}`
            : spawnFailure
              ? `${modelLabel}: spawn failed: ${cleanInline(spawnFailure, 300)}`
              : exitCode !== 0
                ? exitedFailure(modelLabel, exitCode, stderrTail)
                : !assistantText
                  ? `${modelLabel}: completed without an assistant result`
                  : undefined;
          if (retryFailure) {
            attemptFailures.push(retryFailure);
            emit();
            continue;
          }

          const report =
            attemptIndex > 0
              ? `[${def.name}] succeeded with fallback model ${modelLabel} after ${attemptIndex} failed attempt${attemptIndex === 1 ? "" : "s"}.\n\n${assistantText || "(no output)"}`
              : assistantText || "(no output)";
          return {
            content: [{ type: "text", text: report }],
            isError: false,
            details: snapshot("completed", report),
          };
        }

        const allFailed =
          !killReason && attemptFailures.length === attemptedModels.length;
        const text = allFailed
          ? `[${def.name}] all model attempts failed:\n${attemptFailures.map((failure) => `- ${failure}`).join("\n")}`
          : `[${def.name}] stopped: ${killReason} (${turns} turns). Partial result:\n\n${finalAssistantText || "(no output)"}`;
        return {
          content: [{ type: "text", text }],
          isError: allFailed || (!!killReason && !finalAssistantText),
          details: snapshot(allFailed ? "failed" : "stopped", text),
        };
      } finally {
        clearTimeout(hardTimer);
        signal?.removeEventListener("abort", onAbort);
        closeActive(killReason ? "error" : "completed");
        run.done = true;
        run.child = undefined;
        activeRuns.delete(run);
        updateStatus(ctx);
        release();
      }
    },

    renderCall(args, theme, context: ToolRenderContext<TaskRenderState, any>) {
      context.state.startedAt ??= Date.now();
      const def = args.agent ? agents.get(args.agent) : undefined;
      const details: TaskDetails = {
        agent: args.agent ?? "agent",
        mission: missionFromPrompt(args.prompt ?? "Mission"),
        status: context.executionStarted ? "running" : "queued",
        startedAt: context.state.startedAt,
        model: args.model
          ? qualifyModel(args.model, agentProvider(def))
          : def?.model,
        thinking: def?.thinking,
        activities: [],
        attemptedModels: [],
        attemptFailures: [],
        turns: 0,
      };
      const call = renderTaskComponent(details, context.expanded, theme);
      // ToolExecutionComponent composes renderCall and renderResult. The
      // result renderer flips this shared state before the composed component
      // renders, preserving the queued/running call until a result exists and
      // then leaving exactly one live/final task display.
      return new WidthText((width) =>
        context.state.hasResult ? [] : call.render(width),
      );
    },
    renderResult(
      result,
      options,
      theme,
      context: ToolRenderContext<TaskRenderState, any>,
    ) {
      context.state.hasResult = true;
      const details = result.details as TaskDetails | undefined;
      if (!details)
        return new WidthText(() => [textContent(result) || "(no output)"]);
      if (!options.isPartial) context.state.endedAt ??= Date.now();
      return renderTaskComponent(details, options.expanded, theme);
    },
  });

  pi.on("session_shutdown", () => {
    for (const run of activeRuns) run.cancel?.("session shutdown");
    activeRuns.clear();
  });
}
