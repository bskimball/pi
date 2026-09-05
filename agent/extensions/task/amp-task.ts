// amp-task: synchronous task tool and subagent execution.
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
import * as path from "node:path";
import type { Readable } from "node:stream";
import { Type } from "typebox";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  agentParamDescription,
  composeSpecialistSharedPrompts,
  discoverAgents,
  modelAttempts,
  resolveAgentThinking,
  stderrDiagnostic,
} from "./runtime/agent-discovery.ts";
import { isolatedChildEnv } from "./runtime/child-process.ts";
import { missionFromPrompt, shortArgs } from "./presentation/task-view.ts";
import { writeLastPhase } from "./runtime/last-phase.ts";
import {
  boundExpandedCardText,
  boundText,
  capRenderedCardLines,
  extractAssistantText,
  extractAssistantThinking,
  renderedCardCharCount,
} from "./runtime/text-bounds.ts";
import { formatSettledResult } from "./runtime/worker-status.ts";
import {
  padStartToWidth,
  safeTruncateToWidth,
  safeVisibleWidth,
  wrapPlainText,
} from "./presentation/safe-text-layout.ts";
import {
  DURATION_COLUMN,
  TREE,
  WidthText,
  cleanInline,
  fitLine,
  formatDuration,
  textContent,
  type ToolRenderContext,
} from "./presentation/ui-common.ts";
import {
  activityRows,
  buildTreeLines,
  type TreeRow,
} from "./presentation/tree-view.ts";
import { ActivityLedger, type Activity } from "./runtime/activity-ledger.ts";
import { killProcessTree } from "./runtime/process-tree-kill.ts";
import { withTaskPresentation } from "./presentation/presentation.ts";
import {
  MODEL_IDLE_MS,
  TOOL_IDLE_MS,
} from "./runtime/worker-runtime.ts";

// ---------------------------------------------------------------- visual helpers


const RESET = "\x1b[0m";
const ansiFg = (hex: string, text: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}${RESET}`;
};

// Agent hues live in the active theme's `vars` (agent<Name>) so they stay part
// of one palette family.
//
// They are read from the theme JSON rather than declared as `colors` tokens:
// Pi's published theme schema declares `colors` closed, so custom tokens would
// be flagged as invalid in editors even though the runtime validator currently
// accepts them. Staying in `vars` keeps the theme file schema-clean. Every step
// below is guarded; any failure falls back to this built-in set, which matches
// the shipped apex-dark values.
const DEFAULT_AGENT_HUES: Record<string, string> = {
  advisor: "#94e2d5",
  artisan: "#cba6f7",
  inspector: "#89b4fa",
  librarian: "#89dceb",
  machinist: "#a6e3a1",
  oracle: "#b4befe",
  picasso: "#fab387",
  scout: "#f9e2af",
  scribe: "#f5c2e7",
  stevedore: "#74c7ec",
  fallback: "#6c7086",
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function loadThemeAgentHues(): Record<string, string> {
  const hues = { ...DEFAULT_AGENT_HUES };
  try {
    const agentDir = getAgentDir();
    const settingsPath = path.join(agentDir, "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const themeName = String(settings?.theme ?? "").replace(/[^\w.-]/g, "");
    if (!themeName) return hues;
    const themePath = path.join(agentDir, "themes", `${themeName}.json`);
    const vars = JSON.parse(fs.readFileSync(themePath, "utf8"))?.vars;
    if (!vars || typeof vars !== "object") return hues;
    for (const [key, value] of Object.entries(vars)) {
      const match = /^agent([A-Z]\w*)$/.exec(key);
      // Resolve one level of var indirection, then require a literal hex.
      const resolved =
        typeof value === "string" && !HEX_RE.test(value)
          ? (vars as Record<string, unknown>)[value]
          : value;
      if (match && typeof resolved === "string" && HEX_RE.test(resolved)) {
        hues[match[1].toLowerCase()] = resolved;
      }
    }
  } catch {
    // Keep the built-in palette.
  }
  return hues;
}

const AGENT_HUES = loadThemeAgentHues();
const agentHue = (agent: string): string =>
  AGENT_HUES[agent.toLowerCase()] ?? AGENT_HUES.fallback ?? "#8b949e";

function exitedFailure(
  model: string,
  exitCode: number | null,
  stderr: string,
): string {
  const diagnostic = stderrDiagnostic(stderr);
  return `${model}: subagent exited ${exitCode}${diagnostic ? `: ${diagnostic}` : ""}`;
}

// ---------------------------------------------------------------- task state

type MissionActivity = Activity;

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
  /** Wall-clock time of the last observed child event, for liveness only. */
  lastEventAt?: number;
  /** Which idle budget currently applies to the child. */
  phase?: "model" | "tool";
  idleMs?: number;
  toolIdleMs?: number;
  timeoutMs?: number;
  maxTurns?: number;
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

// Task progress already has dedicated live receipts and task_list/task_status.
// Do not duplicate it in Pi's extension-status row: leaving that map empty
// keeps the stable built-in footer at its native two-line height.
function updateStatus(ctx: ExtensionContext) {
  try {
    ctx.ui.setStatus("tasks", undefined);
  } catch {}
}

// Full Pi subprocesses are expensive on Windows. The shared bounded setting
// defaults to five; larger fan-outs queue rather than oversubscribing.
const DEFAULT_MAX_CONCURRENT = 5;
const MAX_CONFIGURED_CONCURRENT = 8;
export function configuredSyncTaskLimit(
  raw = process.env.PI_TASK_MAX_WORKERS,
): number {
  if (!raw?.trim()) return DEFAULT_MAX_CONCURRENT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_CONFIGURED_CONCURRENT
    ? value
    : DEFAULT_MAX_CONCURRENT;
}
const MAX_CONCURRENT = configuredSyncTaskLimit();
let running = 0;

interface SlotWaiter {
  settled: boolean;
  settle: (granted: boolean) => void;
}
const waiters: SlotWaiter[] = [];

/**
 * Reserve one concurrency slot.
 *
 * `acquired` resolves true only when the slot is actually held, and false when
 * `cancel()` ran first, so a queued task can be aborted without ever calling
 * `release()`. The slot count is incremented at hand-off time (not after the
 * waiter resumes) so a cancelled waiter can never be granted a slot twice and
 * a fresh caller cannot slip into a slot that was already handed over.
 */
function acquireSlot(): { acquired: Promise<boolean>; cancel: () => void } {
  if (running < MAX_CONCURRENT) {
    running++;
    return { acquired: Promise.resolve(true), cancel: () => {} };
  }
  let resolve!: (granted: boolean) => void;
  const acquired = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  const waiter: SlotWaiter = {
    settled: false,
    settle: (granted) => {
      if (waiter.settled) return;
      waiter.settled = true;
      if (granted) running++;
      resolve(granted);
    },
  };
  waiters.push(waiter);
  return {
    acquired,
    cancel: () => {
      if (waiter.settled) return;
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      waiter.settle(false);
    },
  };
}

/** Only call after `acquired` resolved true, exactly once. */
function release() {
  running--;
  waiters.shift()?.settle(true);
}

/** Coarse label for a guard budget: minutes above a minute, else seconds. */
function budgetLabel(ms: number): string {
  return ms >= 60_000
    ? `${Math.round(ms / 60_000)}m`
    : `${Math.max(1, Math.round(ms / 1000))}s`;
}

type LivenessTier = "normal" | "quiet" | "stale" | "risk";

// Liveness is derived only from silence since the last child event and the
// idle budget that the kill timer is actually using, so the label can never
// claim forward progress the extension has not observed.
function liveness(
  details: TaskDetails,
  now: number,
  width: number,
): { text: string; tier: LivenessTier } | undefined {
  if (details.status !== "running" || !details.lastEventAt) return undefined;
  const toolPhase = details.phase === "tool";
  const budget = (toolPhase ? details.toolIdleMs : details.idleMs) ?? 0;
  if (budget <= 0) return { text: toolPhase ? "tool" : "thinking", tier: "normal" };
  const silent = Math.max(0, now - details.lastEventAt);
  const ratio = silent / budget;
  // Only wide layouts get the phase prefix; the status column stays compact.
  const prefix = toolPhase && width >= 60 ? "tool " : "";
  if (ratio < 0.1)
    return { text: toolPhase ? "tool" : "thinking", tier: "normal" };
  if (ratio < 0.35)
    return { text: `${prefix}quiet ${formatDuration(silent)}`, tier: "quiet" };
  if (ratio < 0.7)
    return { text: `${prefix}stale ${formatDuration(silent)}`, tier: "stale" };
  return {
    text: `${prefix}guard ${budgetLabel(silent)}/${budgetLabel(budget)}`,
    tier: "risk",
  };
}

function guardLine(
  details: TaskDetails,
  theme: any,
  width: number,
): string | undefined {
  const parts = [
    details.idleMs && `idle ${budgetLabel(details.idleMs)}`,
    details.toolIdleMs && `tool ${budgetLabel(details.toolIdleMs)}`,
    details.timeoutMs && `hard ${budgetLabel(details.timeoutMs)}`,
    details.maxTurns && `turns ${details.turns}/${details.maxTurns}`,
  ]
    .filter(Boolean)
    .join(" · ");
  if (!parts) return undefined;
  return safeTruncateToWidth(
    `${theme.fg("dim", TREE.rail)}  ${theme.fg("dim", `guards: ${parts}`)}`,
    width,
  );
}

function taskHeader(
  details: TaskDetails,
  theme: any,
  width: number,
  now: number,
): string {
  // One saturated hue per line: the agent name carries the only chroma, the
  // constant "task" label drops to dim, and the mission gets the brightest
  // value because it is the line's actual content.
  const badge = ansiFg(agentHue(details.agent), details.agent);
  const meta = [
    details.model,
    details.thinking && `think:${details.thinking}`,
    details.fallbackUsed && "fallback",
    details.turns > 0 &&
      `${details.turns} turn${details.turns === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const left = `${theme.fg("dim", TREE.header)} ${theme.fg("dim", "task")} ${badge}${meta ? ` ${theme.fg("dim", `(${meta})`)}` : ""}  ${theme.fg("text", details.mission)}`;
  const live = liveness(details, now, width);
  const status =
    details.status === "queued"
      ? `${theme.fg("warning", "queued")} ${theme.fg("dim", "· waiting for slot")}`
      : live
        ? theme.fg(
            live.tier === "risk"
              ? "error"
              : live.tier === "quiet"
                ? "muted"
                : "warning",
            live.text,
          )
        : details.status === "running"
          ? theme.fg("warning", "running")
          : details.status === "completed"
            ? theme.fg("success", "complete")
            : theme.fg("error", details.status);
  const elapsed = padStartToWidth(
    formatDuration(details.duration ?? now - details.startedAt),
    DURATION_COLUMN,
  );
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
    const now = Date.now();
    const reportFollows = !isRunning && !!details.finalReport;
    const rows: TreeRow[] = activityRows(
      theme,
      width,
      details.activities ?? [],
      {
        expanded,
        collapsedLimit: 4,
        expandedLimit: 16,
        now,
      },
    );
    const failures = expanded
      ? details.attemptFailures.slice(-8)
      : details.attemptFailures.slice(-1);
    for (const failure of failures) {
      rows.push({
        line: (rail) =>
          safeTruncateToWidth(
            `${theme.fg("dim", rail)} ${theme.fg("error", "×")} ${theme.fg("error", cleanInline(failure, 180))}`,
            width,
          ),
      });
    }
    const railText: string[] = [];
    // Guards are only meaningful once the child is actually executing. A queued
    // task has no idle/turn budget running yet, so listing them would imply
    // supervision that is not active.
    if (expanded && details.status === "running") {
      const guards = guardLine(details, theme, width);
      if (guards) railText.push(guards);
    }
    const lines = buildTreeLines(
      theme,
      width,
      taskHeader(details, theme, width, now),
      rows,
      railText,
      { hasFollowingContent: reportFollows },
    );
    if (!isRunning && details.finalReport) {
      // Body width accounts for the gutter (collapsed) or card padding
      // (expanded) so wrapped text never overflows its container.
      const bodyWidth = Math.max(8, width - (expanded ? 2 : 4));
      const reportLimit = expanded ? 16 : 12;
      const bounded = boundExpandedCardText(details.finalReport, {
        maxLines: expanded ? 16 : 12,
      });
      let moreContent = bounded.truncated;
      const source = bounded.text.trim().replace(/\t/g, "   ");
      const sourceLines = source.split("\n").map((line) => line.replace(/\r$/, ""));

      const reportLines: string[] = [];
      // Returns false once enough lines exist to render the limit plus prove
      // that more content follows.
      const pushReport = (line: string): boolean => {
        reportLines.push(line);
        if (reportLines.length > reportLimit) {
          moreContent = true;
          return false;
        }
        return true;
      };
      let blankRun = 0;
      source_lines: for (const raw of sourceLines) {
        if (!raw.trim()) {
          // Collapse runs of blank lines to a single spacer.
          blankRun++;
          continue;
        }
        // A heading binds to the content beneath it, so no spacer before it
        // when it directly follows a single blank.
        const heading = raw.match(/^#{1,6}\s+(.+)$/);
        if (blankRun > 0 && reportLines.length > 0) {
          if (!pushReport("")) break source_lines;
        }
        blankRun = 0;
        // Wrapping is bounded by what the report can still display (plus the
        // one extra line that proves more content follows) instead of a small
        // per-line cap. Any line that fills the remaining capacity also drives
        // pushReport past the limit, so truncation always sets moreContent.
        const capacity = Math.max(1, reportLimit + 1 - reportLines.length);
        if (heading) {
          for (const line of wrapPlainText(heading[1], bodyWidth, {
            maxLines: capacity,
          }))
            if (!pushReport(theme.fg("toolTitle", line))) break source_lines;
          continue;
        }
        const bullet = raw.match(/^(\s*)[-*]\s+(.+)$/);
        if (bullet) {
          const wrapped = wrapPlainText(bullet[2], bodyWidth - 2, {
            hangingIndent: 0,
            maxLines: capacity,
          });
          for (const [index, line] of wrapped.entries()) {
            const styled =
              index === 0
                ? `${theme.fg("accent", "•")} ${theme.fg("toolOutput", line)}`
                : `  ${theme.fg("toolOutput", line)}`;
            if (!pushReport(styled)) break source_lines;
          }
          continue;
        }
        for (const line of wrapPlainText(raw, bodyWidth, {
          maxLines: capacity,
        }))
          if (!pushReport(theme.fg("toolOutput", line))) break source_lines;
      }
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
        for (const line of shownReport) {
          lines.push(
            safeTruncateToWidth(`${theme.fg("dim", TREE.rail)}  ${line}`, width),
          );
        }
      }
      if (moreContent || reportLines.length > shownReport.length) {
        // The exact unseen line count is unknown because preprocessing stops
        // early, so the signal states that content remains rather than
        // inventing a number.
        lines.push(
          `${theme.fg("dim", TREE.last)} ${theme.fg("muted", "▸ more report content · ctrl+o")}`,
        );
      }
    }
    return expanded ? capRenderedCardLines(lines) : lines;
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
      description: agentParamDescription(agents),
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
          "Optional explicit model override. Leave unset to use the agent's configured default (plus automatic fallback chain). Set only when the user explicitly requested a different model for this delegation; it replaces the primary, declared fallbacks still apply. Oracle thinking is raised automatically when the parent thinking level is the same or higher.",
      }),
    ),
  });

  pi.registerTool({
    name: "task",
    label: "Task",
    description: `Delegate a bounded unit of work to a specialist subagent running in its own process with a fresh context window. Returns the agent's final report. Issue multiple task calls in one message to run agents in parallel (only with disjoint file ownership for writers).\n\nAvailable agents:\n${agentList}`,
    parameters: TaskParams,
    executionMode: "parallel",

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

      const timeoutMs = (def.timeoutSec ?? 1800) * 1000;
      const idleMs = MODEL_IDLE_MS;
      const toolIdleMs = TOOL_IDLE_MS;
      const maxTurns = def.maxTurns ?? 30;
      const thinking = resolveAgentThinking(def, pi.getThinkingLevel());
      const attempts = modelAttempts(def, params.model?.trim() || undefined);

      const ledger = new ActivityLedger({ maxActivities: 400 });
      const attemptedModels: string[] = [];
      const attemptFailures: string[] = [];
      const hasActiveTools = () => ledger.hasActiveTools();
      let turns = 0;
      let killReason: string | undefined;
      let finalExitCode: number | null = null;
      let finalAssistantText = "";
      let currentModel: string | undefined;
      // Liveness mirrors the idle timer: it only advances on events that also
      // reset the kill budget, so the label can never outrun the guard.
      let lastEventAt: number | undefined;
      let phase: "model" | "tool" = "model";

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
        activities: ledger.snapshot(),
        attemptedModels: [...attemptedModels],
        attemptFailures: [...attemptFailures],
        model: currentModel,
        thinking,
        fallbackUsed: attemptedModels.length > 1,
        turns,
        exitCode: finalExitCode,
        killReason,
        finalReport,
        lastEventAt: status === "running" ? lastEventAt : undefined,
        phase,
        idleMs,
        toolIdleMs,
        timeoutMs,
        maxTurns,
      });
      const emit = (status: TaskDetails["status"] = "running") => {
        try {
          onUpdate?.({
            content: [{ type: "text", text: `[${def.name}] ${mission}` }],
            details: snapshot(status),
          });
        } catch {}
      };
      const closeAllRunning = (
        status: MissionActivity["status"] = "completed",
      ) => {
        ledger.closeAll(status);
      };

      const run: TaskRun = { agent: def.name, done: false };
      // Set while this task is parked in the concurrency queue, so a kill can
      // withdraw the waiter instead of leaving it to be granted a slot later.
      let cancelSlot: (() => void) | undefined;
      const kill = (reason: string) => {
        if (killReason) return;
        killReason = reason;
        cancelSlot?.();
        const child = run.child;
        if (!child?.pid) return;
        killProcessTree(child.pid);
      };
      run.cancel = kill;
      // Queued work is registered before the queue wait so abort, session
      // shutdown, and the global tasks status all cover it.
      activeRuns.add(run);
      updateStatus(ctx);
      // The hard timeout starts before the queue wait, so the published
      // `hard` budget honestly bounds queue wait plus execution.
      const hardTimer = setTimeout(
        () => kill(`exceeded ${timeoutMs / 1000}s time limit`),
        timeoutMs,
      );
      const onAbort = () => kill("aborted by user");
      signal?.addEventListener("abort", onAbort);
      if (signal?.aborted) onAbort();

      // The queue wait lives inside the try so the timer, run registration,
      // and slot are always cleaned up, including if the wait itself throws.
      let acquired = false;
      try {
        // Show a real queued state before blocking on a slot, so queue wait is
        // never presented as silent model work.
        emit("queued");
        const slot = acquireSlot();
        cancelSlot = slot.cancel;
        // An abort that landed before the waiter existed must still withdraw it.
        if (killReason) slot.cancel();
        acquired = await slot.acquired;
        cancelSlot = undefined;
        // No idle timer is armed until the child spawns, so no liveness is
        // published here; the frame renders as plain running.
        lastEventAt = undefined;

        // No emit here: the attempt loop publishes immediately after selecting
        // a model, so the first "running" snapshot already carries the model
        // and fallback metadata instead of a blank running frame.
        for (
          let attemptIndex = 0;
          acquired && attemptIndex < attempts.length;
          attemptIndex++
        ) {
          if (killReason) break;
          const model = attempts[attemptIndex];
          lastEventAt = undefined;
          phase = "model";
          const modelLabel = model ?? "default model";
          currentModel = modelLabel;
          attemptedModels.push(modelLabel);
          run.model = modelLabel;
          updateStatus(ctx);
          // Publish the chosen model and fallback flag before the child starts
          // its first (silent) thinking stretch.
          emit();

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
          if (thinking) args.push("--thinking", thinking);
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
          const shared = composeSpecialistSharedPrompts("sync");
          const systemPrompt = [shared.systemPreamble, def.body]
            .filter(Boolean)
            .join("\n\n");
          if (systemPrompt) args.push("--system-prompt", systemPrompt);
          if (shared.appendSystemPrompt) {
            args.push("--append-system-prompt", shared.appendSystemPrompt);
          }
          args.push(params.prompt);

          let child: ChildProcessByStdio<null, Readable, Readable>;
          let spawnFailure: string | undefined;
          try {
            child = spawn(process.execPath, args, {
              cwd: childCwd,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
              env: isolatedChildEnv({
                PI_SUBAGENT: "1",
                PI_SUBAGENT_AGENT: def.name,
                PI_SUBAGENT_MODEL: modelLabel,
              }),
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
          // Streamed partial text only — used when message_end/turn_end/agent_end
          // never yield usable completed assistant content (some providers).
          let streamedAssistantText = "";
          let assistantError: string | undefined;
          // Diagnostic only: last empty completed assistant turn (stopReason +
          // content block types + thinking preview). Gemini often exits with
          // thinking-only content and no visible text.
          let emptyAssistantDiag: string | undefined;
          let stderrTail = "";
          let attemptTurns = 0;
          // Cap recovered stream text so a runaway stream cannot blow the parent
          // context. The returned report is also bounded by formatSettledResult.
          const STREAM_ASSISTANT_CAP = 12_000;
          const STREAM_ASSISTANT_LINES = 200;
          const describeEmptyAssistant = (message: unknown): string | undefined => {
            if (!message || typeof message !== "object") return undefined;
            const m = message as {
              role?: string;
              stopReason?: string;
              content?: unknown;
            };
            if (m.role && m.role !== "assistant") return undefined;
            if (extractAssistantText(message)) return undefined;
            const types: string[] = [];
            if (Array.isArray(m.content)) {
              for (const item of m.content) {
                if (item && typeof item === "object") {
                  types.push(String((item as { type?: string }).type ?? "?"));
                }
              }
            } else if (m.content == null) {
              types.push("(no content)");
            } else {
              types.push(typeof m.content);
            }
            const thinking = extractAssistantThinking(message);
            const typeLabel = types.length ? types.join("+") : "empty";
            const stop = m.stopReason ? ` stop=${m.stopReason}` : "";
            if (thinking) {
              return `thinking-only (${typeLabel}${stop}): ${cleanInline(thinking, 160)}`;
            }
            return `no visible text (${typeLabel}${stop})`;
          };
          const takeCompletedAssistant = (message: unknown): string => {
            const text = extractAssistantText(message);
            if (!text) {
              const diag = describeEmptyAssistant(message);
              if (diag) emptyAssistantDiag = diag;
            } else {
              emptyAssistantDiag = undefined;
            }
            return text;
          };
          const takeStreamedAssistant = (message: unknown): string => {
            const text = extractAssistantText(message);
            if (!text) return "";
            return boundText(text, STREAM_ASSISTANT_CAP, STREAM_ASSISTANT_LINES)
              .text;
          };
          // Tools may legitimately stay quiet longer than model turns, but
          // still need an idle bound below the hard process timeout. The
          // running-activity maps decide the phase, so overlapping calls
          // cannot end one another's budget.
          //
          // Publishing is part of the reset: the rendered lastEventAt/phase is
          // the same value the kill timer just armed with, so liveness can
          // never drift from the guard. Idle/kill timers still arm on every
          // byte; raw stream onUpdate is monotonically throttled so token-rate
          // chunks cannot publish at stream cadence. Tool/turn/failure frames
          // force an immediate publish. No presentation setInterval is used.
          //
          // Within one synchronous chunk handler nothing can render, so the
          // resets in it are coalesced into a single emission carrying the
          // final state. That is still exact, just not redundant.
          const STREAM_PUBLISH_MS = 250;
          let deferEmit = false;
          let pendingEmit = false;
          let pendingForcePublish = false;
          let lastPublishAt = 0;
          const publish = (force = false) => {
            if (deferEmit) {
              pendingEmit = true;
              if (force) pendingForcePublish = true;
              return;
            }
            const now = Date.now();
            if (!force && now - lastPublishAt < STREAM_PUBLISH_MS) return;
            emit();
            lastPublishAt = now;
          };
          const flushEmit = () => {
            deferEmit = false;
            if (!pendingEmit) return;
            const force = pendingForcePublish;
            pendingEmit = false;
            pendingForcePublish = false;
            publish(force);
          };
          const resetIdle = (forcePublish = true) => {
            if (idleTimer) clearTimeout(idleTimer);
            const toolPhase = hasActiveTools();
            lastEventAt = Date.now();
            phase = toolPhase ? "tool" : "model";
            const budgetMs = toolPhase ? toolIdleMs : idleMs;
            const phaseNote = toolPhase ? " during tool execution" : "";
            idleTimer = setTimeout(
              () => kill(`idle for ${budgetMs / 1000}s${phaseNote}`),
              budgetMs,
            );
            publish(forcePublish);
          };
          resetIdle();

          child.stdout.on("data", (chunk: Buffer) => {
            deferEmit = true;
            try {
              // Raw stdout always resets the idle budget; liveness publish is
              // throttled unless a structured event below forces one.
              resetIdle(false);
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
                    // Publish the new turn count with the matching timer state.
                    resetIdle();
                  } else if (event.type === "tool_execution_start") {
                    const callId =
                      event.toolCallId == null
                        ? undefined
                        : String(event.toolCallId);
                    ledger.start(
                      cleanInline(event.toolName, 40),
                      shortArgs(event.args),
                      callId,
                    );
                    // Reset (and force-publish) after the running set changed
                    // so the emitted phase reflects the new tool budget.
                    resetIdle();
                  } else if (event.type === "tool_execution_end") {
                    const callId =
                      event.toolCallId == null
                        ? undefined
                        : String(event.toolCallId);
                    ledger.end(callId, Boolean(event.isError));
                    resetIdle();
                  } else if (
                    event.type === "message_end" &&
                    event.message?.role === "assistant"
                  ) {
                    // Canonical path: finalized assistant message.
                    const message = event.message;
                    assistantError =
                      message.stopReason === "error" || message.errorMessage
                        ? String(message.errorMessage ?? "provider/model error")
                        : undefined;
                    const text = takeCompletedAssistant(message);
                    if (text) assistantText = text;
                    resetIdle();
                  } else if (
                    event.type === "turn_end" &&
                    event.message?.role === "assistant"
                  ) {
                    // Completed turn message — prefer over partial stream text.
                    const text = takeCompletedAssistant(event.message);
                    if (text) assistantText = text;
                    resetIdle();
                  } else if (event.type === "agent_end") {
                    // Last assistant message in the run, if message_end was missed.
                    const messages = Array.isArray(event.messages)
                      ? event.messages
                      : [];
                    for (let i = messages.length - 1; i >= 0; i--) {
                      const msg = messages[i];
                      if (!msg || msg.role !== "assistant") continue;
                      const text = takeCompletedAssistant(msg);
                      if (text) {
                        assistantText = text;
                        break;
                      }
                    }
                    resetIdle();
                  } else if (
                    event.type === "message_update" &&
                    event.message?.role === "assistant"
                  ) {
                    // Bounded partial stream only; never overrides completed text.
                    const text = takeStreamedAssistant(event.message);
                    if (text) streamedAssistantText = text;
                    // High-frequency: idle still reset by raw stdout path above.
                  }
                } catch {}
              }
            } finally {
              flushEmit();
            }
          });
          child.stderr.on("data", (chunk: Buffer) => {
            // stderr resets the idle budget too; raw publish stays throttled.
            resetIdle(false);
            // Keep enough context to retain the decisive diagnostic even when
            // the CLI follows it with login help and documentation paths.
            stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8000);
          });

          // Slot release waits for confirmed process death. A post-spawn
          // "error" (stdio/kill issues) must not resolve the waiter while the
          // child may still be alive; only a failed launch (no pid) or an
          // already-reaped child may settle early.
          const exitCode: number | null = await new Promise((resolve) => {
            let settled = false;
            const settle = (code: number | null) => {
              if (!settled) {
                settled = true;
                resolve(code);
              }
            };
            child.on("close", (code) => settle(code));
            child.on("error", (error) => {
              const message = error.message;
              stderrTail = (stderrTail + `\nprocess error: ${message}`).slice(
                -8000,
              );
              const neverStarted = child.pid == null;
              const alreadyDead =
                child.exitCode !== null || child.signalCode !== null;
              if (neverStarted) {
                // Async spawn failure: process never launched.
                spawnFailure = message;
                settle(-1);
                return;
              }
              if (alreadyDead) {
                settle(child.exitCode ?? -1);
                return;
              }
              // Still alive: keep run.child until "close". If a kill was
              // already requested, re-issue a direct kill so a failed first
              // attempt cannot strand the concurrency slot forever.
              if (killReason) {
                try {
                  child.kill();
                } catch {}
              }
            });
          });
          if (idleTimer) clearTimeout(idleTimer);
          // The idle timer is cleared, so post-close frames publish no
          // liveness metadata that no guard is backing.
          lastEventAt = undefined;
          phase = "model";
          // The child is gone, so any call still marked running ended with it.
          closeAllRunning(
            killReason || exitCode !== 0 ? "error" : "completed",
          );
          run.child = undefined;
          // Prefer completed assistant content; fall back to bounded stream text.
          if (!assistantText && streamedAssistantText) {
            assistantText = streamedAssistantText;
          }
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
                  ? `${modelLabel}: completed without an assistant result${
                      emptyAssistantDiag
                        ? ` — ${emptyAssistantDiag}`
                        : ""
                    }`
                  : undefined;
          if (retryFailure) {
            attemptFailures.push(retryFailure);
            emit();
            continue;
          }

          const rawReport =
            attemptIndex > 0
              ? `[${def.name}] succeeded with fallback model ${modelLabel} after ${attemptIndex} failed attempt${attemptIndex === 1 ? "" : "s"}.\n\n${assistantText || "(no output)"}`
              : assistantText || "(no output)";
          const report = formatSettledResult(rawReport).text;
          return {
            content: [{ type: "text", text: report }],
            isError: false,
            details: snapshot("completed", report),
          };
        }

        const allFailed =
          !killReason && attemptFailures.length === attemptedModels.length;
        const text = formatSettledResult(
          allFailed
            ? `[${def.name}] all model attempts failed:\n${attemptFailures.map((failure) => `- ${failure}`).join("\n")}`
            : `[${def.name}] stopped: ${killReason} (${turns} turns). Partial result:\n\n${finalAssistantText || "(no output)"}`,
        ).text;
        return {
          content: [{ type: "text", text }],
          isError: allFailed || (!!killReason && !finalAssistantText),
          details: snapshot(allFailed ? "failed" : "stopped", text),
        };
      } finally {
        clearTimeout(hardTimer);
        signal?.removeEventListener("abort", onAbort);
        closeAllRunning(killReason ? "error" : "completed");
        run.done = true;
        run.child = undefined;
        activeRuns.delete(run);
        updateStatus(ctx);
        // Never release a slot that was never held.
        if (acquired) release();
      }
    },

    ...withTaskPresentation({
      renderShell: "self" as const,
      renderCall(
        args: any,
        theme: any,
        context: ToolRenderContext<TaskRenderState, any>,
      ) {
        context.state.startedAt ??= Date.now();
        const def = args.agent ? agents.get(args.agent) : undefined;
        const details: TaskDetails = {
          agent: args.agent ?? "agent",
          mission: missionFromPrompt(args.prompt ?? "Mission"),
          // `executionStarted` only means `execute` was entered; the task may
          // still be waiting for a concurrency slot. Stay queued here and let
          // the first emitted snapshot (rendered by renderResult) prove that
          // the child is actually running, so a queued task never flickers
          // through a false "running" frame.
          status: "queued",
          startedAt: context.state.startedAt,
          model: def?.model,
          thinking: def
            ? resolveAgentThinking(def, pi.getThinkingLevel())
            : undefined,
          activities: [],
          attemptedModels: [],
          attemptFailures: [],
          turns: 0,
        };
        const call = renderTaskComponent(details, context.expanded, theme);
        if (context.expanded) {
          writeLastPhase(
            `task-card:expand kind=task-call chars=${renderedCardCharCount(call.render(80))}`,
          );
        }
        // ToolExecutionComponent composes renderCall and renderResult. The
        // result renderer flips this shared state before the composed component
        // renders, preserving the queued/running call until a result exists and
        // then leaving exactly one live/final task display.
        return new WidthText((width) =>
          context.state.hasResult ? [] : call.render(width),
        );
      },
      renderResult(
        result: any,
        options: { expanded: boolean; isPartial: boolean },
        theme: any,
        context: ToolRenderContext<TaskRenderState, any>,
      ) {
        context.state.hasResult = true;
        const details = result.details as TaskDetails | undefined;
        if (!details)
          return new WidthText(() => [textContent(result) || "(no output)"]);
        if (!options.isPartial) context.state.endedAt ??= Date.now();
        const expanded = context.expanded || options.expanded;
        const card = renderTaskComponent(details, expanded, theme);
        if (expanded) {
          writeLastPhase(
            `task-card:expand kind=task chars=${renderedCardCharCount(card.render(80))}`,
          );
        }
        return card;
      },
    }),
  });

  pi.on("session_shutdown", () => {
    for (const run of activeRuns) run.cancel?.("session shutdown");
    activeRuns.clear();
  });
}
