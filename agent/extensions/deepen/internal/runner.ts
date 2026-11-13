// Background read-only subagent runner for /deepen.
//
// Prefers the shared async task extension runner (`globalThis.__piTaskExtensionRunner`,
// installed by `task/async-task.ts`) so every /deepen run is tracked as a real
// `scribe` sub-agent in `/agents`, `task_list`/`task_status`, and footer status.
// Falls back to a standalone `pi --mode json -p` subprocess only when no task
// runner is registered (e.g. `--mode print` without `async-task`).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAgents,
  modelAttempts,
  resolveAgentThinking,
  type AgentDef,
} from "@pi/ui-kit";
import { killProcessTree } from "./process-tree-kill.ts";
import {
  buildDeepenMission,
  buildDeepenUserPrompt,
  DEEPEN_SYSTEM_INSTRUCTIONS,
  EXCLUDED_HELPER_TOOLS,
  parseDeepenReply,
  READ_ONLY_TOOLS,
  sanitizeStatusText,
  summarizeToolTarget,
  type ParsedDeepenReply,
} from "./prompt.ts";

export const DEFAULT_DEEPEN_AGENT = "scribe";

const TASK_EXTENSION_RUNNER_KEY = "__piTaskExtensionRunner";
const HARD_TIMEOUT_MS = 5 * 60_000;
const IDLE_TIMEOUT_MS = 120_000;
const MAX_HELPER_TURNS = 8;
const STATUS_THROTTLE_MS = 250;
const VALID_THINKING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

interface TaskExtensionWorkerSnapshot {
  id: string;
  agent: string;
  model: string;
  lifecycle: string;
  phase: string;
  tool?: string;
  toolSummary?: string;
  turns: number;
  sessionFile?: string;
}

interface TaskExtensionSpawnRequest {
  agent: string;
  prompt: string;
  cwd: string;
  mission?: string;
  forkSessionFile?: string;
  modelOverride?: string;
  thinkingOverride?: string;
  toolsOverride?: string;
  extraExcludedTools?: string;
  inheritSkillsOverride?: boolean;
  extraCliArgs?: string[];
  systemPromptOverride?: string;
  appendSystemPrompt?: string;
  omitHandoffInstruction?: boolean;
  envOverrides?: Record<string, string>;
  maxTurnsOverride?: number;
  timeoutSecOverride?: number;
  ctx?: unknown;
  onUpdate?: (snapshot: TaskExtensionWorkerSnapshot) => void;
}

type TaskExtensionOutcome =
  | {
      status: "settled";
      id: string;
      agent: string;
      model: string;
      turns: number;
      elapsedMs: number;
      rawText: string;
      sessionFile?: string;
    }
  | {
      status: "cancelled";
      id?: string;
      elapsedMs: number;
    }
  | {
      status: "failed";
      id?: string;
      agent: string;
      model: string;
      turns: number;
      elapsedMs: number;
      error: string;
      rawText?: string;
      sessionFile?: string;
    };

interface TaskExtensionRunHandle {
  readonly id: string;
  readonly agent: string;
  readonly model: string;
  readonly startedAt: number;
  snapshot(): TaskExtensionWorkerSnapshot;
  cancel(): Promise<void>;
  promise: Promise<TaskExtensionOutcome>;
}

interface TaskExtensionRunner {
  spawn(
    request: TaskExtensionSpawnRequest,
  ): Promise<
    { ok: true; handle: TaskExtensionRunHandle } | { ok: false; error: string }
  >;
}

export interface DeepenSettings {
  agent?: string;
  model?: string;
  thinking?: string;
}

export interface ResolvedDeepenTarget {
  agent: string;
  agentDef?: AgentDef;
  explicitModel?: string;
  explicitThinking?: string;
  label: string;
  provider?: string;
  modelId?: string;
  thinking?: string;
}

export interface DeepenRunOptions {
  cwd: string;
  draftPrompt: string;
  forkSessionFile?: string;
  target: ResolvedDeepenTarget;
  ctx?: unknown;
  onStart?: (info: { workerId?: string; agent: string; model: string }) => void;
  onStatus?: (statusText: string) => void;
}

export type DeepenOutcome =
  | {
      status: "ok";
      parsed: ParsedDeepenReply;
      rawReply: string;
      agent: string;
      model: string;
      workerId?: string;
      sessionFile?: string;
      turns: number;
      elapsedMs: number;
    }
  | {
      status: "cancelled";
      workerId?: string;
      elapsedMs: number;
    }
  | {
      status: "parse_error";
      savedPath: string;
      agent: string;
      model: string;
      workerId?: string;
      sessionFile?: string;
      elapsedMs: number;
    }
  | {
      status: "error";
      message: string;
      agent: string;
      model: string;
      workerId?: string;
      sessionFile?: string;
      elapsedMs: number;
    };

export interface ActiveDeepenHandle {
  readonly startedAt: number;
  readonly agentLabel: string;
  readonly modelLabel: () => string;
  readonly workerId?: () => string | undefined;
  readonly sessionFile?: () => string | undefined;
  readonly currentPhase: () => string;
  readonly turns: () => number;
  cancel: () => void;
  promise: Promise<DeepenOutcome>;
}

function getTaskExtensionRunner(): TaskExtensionRunner | undefined {
  const candidate = (globalThis as Record<string, unknown>)[
    TASK_EXTENSION_RUNNER_KEY
  ] as Partial<TaskExtensionRunner> | undefined;
  if (candidate && typeof candidate.spawn === "function") {
    return candidate as TaskExtensionRunner;
  }
  return undefined;
}

function parseProviderModel(spec: string): {
  provider?: string;
  modelId: string;
} {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash).trim();
    const modelId = spec.slice(slash + 1).trim();
    if (provider && modelId) {
      return { provider, modelId };
    }
  }
  return { modelId: spec };
}

export function resolveDeepenTarget(
  settings: unknown,
  cwd: string,
  activeModel?: { provider: string; id: string },
  activeThinking?: string,
): ResolvedDeepenTarget | undefined {
  const cfg =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? ((settings as Record<string, unknown>).deepen as DeepenSettings | undefined)
      : undefined;

  const agent =
    typeof cfg?.agent === "string" && cfg.agent.trim()
      ? cfg.agent.trim()
      : DEFAULT_DEEPEN_AGENT;
  const agentDef = discoverAgents(cwd).get(agent);

  const configuredModel =
    typeof cfg?.model === "string" && cfg.model.trim()
      ? cfg.model.trim()
      : undefined;
  const explicitThinking =
    typeof cfg?.thinking === "string" && VALID_THINKING.has(cfg.thinking.trim())
      ? cfg.thinking.trim()
      : undefined;
  const validActiveThinking =
    typeof activeThinking === "string" && VALID_THINKING.has(activeThinking.trim())
      ? activeThinking.trim()
      : undefined;

  const attempts = agentDef
    ? modelAttempts(agentDef, configuredModel)
    : configuredModel
      ? [configuredModel]
      : [];
  const primaryAttempt = attempts.find((m): m is string => Boolean(m));

  let explicitModel = configuredModel;
  let resolvedSpec = primaryAttempt;
  if (!resolvedSpec && activeModel?.id) {
    resolvedSpec = `${activeModel.provider}/${activeModel.id}`;
    if (!explicitModel) {
      explicitModel = resolvedSpec;
    }
  }

  if (!resolvedSpec) {
    return undefined;
  }

  const parsed = parseProviderModel(resolvedSpec);
  const thinking =
    explicitThinking ??
    (agentDef ? resolveAgentThinking(agentDef, validActiveThinking) : undefined) ??
    validActiveThinking;

  return {
    agent,
    agentDef,
    explicitModel,
    explicitThinking,
    label: parsed.provider
      ? `${parsed.provider}/${parsed.modelId}`
      : parsed.modelId,
    provider: parsed.provider,
    modelId: parsed.modelId,
    thinking,
  };
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.join("\n").trim();
}

function resolvePiEntrypoint(): { command: string; prefixArgs: string[] } {
  const cliJs = process.argv[1];
  if (cliJs && /(?:^|[\\/])(?:cli|pi)\.[cm]?js$/i.test(cliJs) && existsSync(cliJs)) {
    return { command: process.execPath, prefixArgs: [cliJs] };
  }
  try {
    const distIndex = fileURLToPath(
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const distDir = dirname(distIndex);
    for (const candidate of [
      join(distDir, "bundle", "cli.js"),
      join(distDir, "cli.js"),
    ]) {
      if (existsSync(candidate)) {
        return { command: process.execPath, prefixArgs: [candidate] };
      }
    }
  } catch {
    // Fall back to process.argv[1] if module resolution is unavailable.
  }
  if (cliJs && existsSync(cliJs)) {
    return { command: process.execPath, prefixArgs: [cliJs] };
  }
  return { command: "pi", prefixArgs: [] };
}

function saveUnparsedReply(rawReply: string): string {
  const savedPath = join(tmpdir(), `pi-deepen-reply-${Date.now()}.md`);
  try {
    writeFileSync(savedPath, rawReply, "utf8");
  } catch {
    // Fall through with path report if write failed.
  }
  return savedPath;
}

function startViaTaskRunner(
  taskRunner: TaskExtensionRunner,
  options: DeepenRunOptions,
): ActiveDeepenHandle {
  const startedAt = Date.now();
  let phase = "starting";
  let turnCount = 0;
  let cancelled = false;
  let currentWorkerId: string | undefined;
  let currentModel = options.target.label;
  let currentSessionFile: string | undefined;
  let taskHandle: TaskExtensionRunHandle | undefined;
  let lastStatusAt = 0;

  const emitStatus = (nextPhase: string, force = false) => {
    phase = sanitizeStatusText(nextPhase, 56) || "working";
    if (!options.onStatus) return;
    const now = Date.now();
    if (!force && now - lastStatusAt < STATUS_THROTTLE_MS) return;
    lastStatusAt = now;
    const prefix = currentWorkerId
      ? `deepen \u00b7 ${currentWorkerId} \u00b7 ${options.target.agent}`
      : `deepen \u00b7 ${options.target.agent}`;
    options.onStatus(`${prefix} \u00b7 ${phase}`);
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (taskHandle) {
      void taskHandle.cancel();
    }
  };

  emitStatus("starting", true);

  const promise = (async (): Promise<DeepenOutcome> => {
    const spawnResult = await taskRunner.spawn({
      agent: options.target.agent,
      prompt: buildDeepenUserPrompt(options.draftPrompt),
      cwd: options.cwd,
      mission: buildDeepenMission(options.draftPrompt),
      forkSessionFile: options.forkSessionFile,
      modelOverride: options.target.explicitModel,
      thinkingOverride: options.target.explicitThinking,
      toolsOverride: READ_ONLY_TOOLS.join(","),
      extraExcludedTools: EXCLUDED_HELPER_TOOLS.join(","),
      inheritSkillsOverride: false,
      extraCliArgs: ["--no-mcp", "--no-prompt-templates", "--no-themes"],
      appendSystemPrompt: DEEPEN_SYSTEM_INSTRUCTIONS,
      omitHandoffInstruction: true,
      envOverrides: {
        PI_DEEPEN_HELPER: "1",
        PI_CUA_ENABLED: "0",
        PI_CUA_PARENT_PID: "",
      },
      maxTurnsOverride: MAX_HELPER_TURNS,
      timeoutSecOverride: Math.round(HARD_TIMEOUT_MS / 1000),
      ctx: options.ctx,
      onUpdate: (snapshot) => {
        if (snapshot.id) currentWorkerId = snapshot.id;
        if (snapshot.model) currentModel = snapshot.model;
        if (snapshot.sessionFile) currentSessionFile = snapshot.sessionFile;
        turnCount = snapshot.turns;
        const nextPhase =
          snapshot.toolSummary ||
          snapshot.tool ||
          snapshot.phase ||
          snapshot.lifecycle ||
          "working";
        emitStatus(nextPhase, false);
      },
    });

    if (!spawnResult.ok) {
      if (cancelled) {
        return { status: "cancelled", elapsedMs: Date.now() - startedAt };
      }
      return {
        status: "error",
        message: sanitizeStatusText(spawnResult.error, 180),
        agent: options.target.agent,
        model: currentModel,
        elapsedMs: Date.now() - startedAt,
      };
    }

    taskHandle = spawnResult.handle;
    currentWorkerId = taskHandle.id;
    currentModel = taskHandle.model || currentModel;
    const initialSnapshot = taskHandle.snapshot();
    if (initialSnapshot?.sessionFile) {
      currentSessionFile = initialSnapshot.sessionFile;
    }

    if (cancelled) {
      void taskHandle.cancel();
      return {
        status: "cancelled",
        workerId: currentWorkerId,
        elapsedMs: Date.now() - startedAt,
      };
    }

    emitStatus(initialSnapshot?.phase || "starting", true);
    options.onStart?.({
      workerId: currentWorkerId,
      agent: options.target.agent,
      model: currentModel,
    });

    const outcome = await taskHandle.promise;
    const elapsedMs = outcome.elapsedMs ?? Date.now() - startedAt;

    if (cancelled || outcome.status === "cancelled") {
      return {
        status: "cancelled",
        workerId: currentWorkerId,
        elapsedMs,
      };
    }

    if (outcome.status === "failed") {
      return {
        status: "error",
        message: sanitizeStatusText(outcome.error, 180),
        agent: outcome.agent || options.target.agent,
        model: outcome.model || currentModel,
        workerId: outcome.id || currentWorkerId,
        sessionFile: outcome.sessionFile || currentSessionFile,
        elapsedMs,
      };
    }

    const rawReply = outcome.rawText.trim();
    const agent = outcome.agent || options.target.agent;
    const model = outcome.model || currentModel;
    const workerId = outcome.id || currentWorkerId;
    const sessionFile = outcome.sessionFile || currentSessionFile;

    if (!rawReply) {
      return {
        status: "error",
        message: "empty reply from deepen subagent",
        agent,
        model,
        workerId,
        sessionFile,
        elapsedMs,
      };
    }

    const parsed = parseDeepenReply(rawReply);
    if (!parsed) {
      return {
        status: "parse_error",
        savedPath: saveUnparsedReply(rawReply),
        agent,
        model,
        workerId,
        sessionFile,
        elapsedMs,
      };
    }

    return {
      status: "ok",
      parsed,
      rawReply,
      agent,
      model,
      workerId,
      sessionFile,
      turns: outcome.turns,
      elapsedMs,
    };
  })();

  return {
    startedAt,
    agentLabel: options.target.agent,
    modelLabel: () => currentModel,
    workerId: () => currentWorkerId,
    sessionFile: () => currentSessionFile,
    currentPhase: () => phase,
    turns: () => turnCount,
    cancel,
    promise,
  };
}

function startStandaloneFallback(options: DeepenRunOptions): ActiveDeepenHandle {
  const startedAt = Date.now();
  let phase = "starting";
  let turnCount = 0;
  let cancelled = false;
  let killReason: string | undefined;
  let child: ChildProcess | undefined;
  let tempSessionDir: string | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let lastStatusAt = 0;

  const emitStatus = (nextPhase: string, force = false) => {
    phase = sanitizeStatusText(nextPhase, 56) || "working";
    if (!options.onStatus) return;
    const now = Date.now();
    if (!force && now - lastStatusAt < STATUS_THROTTLE_MS) return;
    lastStatusAt = now;
    options.onStatus(`deepen \u00b7 ${options.target.agent} \u00b7 ${phase}`);
  };

  const cleanupSessionDir = () => {
    if (!tempSessionDir) return;
    const dir = tempSessionDir;
    tempSessionDir = undefined;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  };

  const clearTimers = () => {
    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = undefined;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const terminate = (reason?: string) => {
    if (reason && !killReason) killReason = reason;
    clearTimers();
    if (child?.pid) {
      killProcessTree(child.pid);
    }
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    terminate("cancelled");
  };

  const promise = new Promise<DeepenOutcome>((resolve) => {
    const { command, prefixArgs } = resolvePiEntrypoint();
    const args = [
      ...prefixArgs,
      "--mode",
      "json",
      "-p",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--tools",
      READ_ONLY_TOOLS.join(","),
      "--exclude-tools",
      EXCLUDED_HELPER_TOOLS.join(","),
    ];

    if (options.forkSessionFile && existsSync(options.forkSessionFile)) {
      try {
        tempSessionDir = mkdtempSync(join(tmpdir(), "pi-deepen-"));
        args.push("--session-dir", tempSessionDir, "--fork", options.forkSessionFile);
      } catch {
        args.push("--no-session");
      }
    } else {
      args.push("--no-session");
    }

    if (options.target.provider && options.target.modelId) {
      args.push("--provider", options.target.provider, "--model", options.target.modelId);
    } else if (options.target.modelId) {
      args.push("--model", options.target.modelId);
    }
    if (options.target.thinking) {
      args.push("--thinking", options.target.thinking);
    }

    if (options.target.agentDef?.body) {
      args.push("--system-prompt", options.target.agentDef.body);
    }
    args.push("--append-system-prompt", DEEPEN_SYSTEM_INSTRUCTIONS);
    args.push("--", buildDeepenUserPrompt(options.draftPrompt));

    emitStatus("starting", true);

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          PI_SUBAGENT: "1",
          PI_SUBAGENT_AGENT: options.target.agent,
          PI_SUBAGENT_MODEL: options.target.label,
          PI_DEEPEN_HELPER: "1",
          PI_CUA_ENABLED: "0",
          PI_CUA_PARENT_PID: "",
          PI_UI_CHROME: "0",
          PI_APEX_UI: "0",
          PI_TASK_UI: "0",
          PI_TERMINAL_WATCHDOG: "0",
        },
      });
    } catch (error) {
      cleanupSessionDir();
      const msg = error instanceof Error ? error.message : String(error);
      resolve({
        status: "error",
        message: sanitizeStatusText(`spawn failed: ${msg}`, 160),
        agent: options.target.agent,
        model: options.target.label,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

    options.onStart?.({
      agent: options.target.agent,
      model: options.target.label,
    });

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        terminate(`idle timeout (${Math.round(IDLE_TIMEOUT_MS / 1000)}s)`);
      }, IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };

    hardTimer = setTimeout(() => {
      terminate(`exceeded ${Math.round(HARD_TIMEOUT_MS / 1000)}s limit`);
    }, HARD_TIMEOUT_MS);
    hardTimer.unref?.();
    resetIdleTimer();

    let stdoutBuffer = "";
    let stderrTail = "";
    let completedText = "";
    let streamedText = "";
    let assistantError: string | undefined;
    let settled = false;

    const finish = (outcome: DeepenOutcome) => {
      if (settled) return;
      settled = true;
      clearTimers();
      cleanupSessionDir();
      resolve(outcome);
    };

    const handleEvent = (event: Record<string, unknown>) => {
      const type = event.type;
      if (type === "turn_start") {
        turnCount += 1;
        if (turnCount > MAX_HELPER_TURNS) {
          terminate(`exceeded ${MAX_HELPER_TURNS} turns`);
          return;
        }
        emitStatus(turnCount === 1 ? "thinking" : `turn ${turnCount}`, true);
        return;
      }
      if (type === "tool_execution_start") {
        emitStatus(summarizeToolTarget(String(event.toolName ?? "read"), event.args), true);
        return;
      }
      if (type === "tool_execution_end") {
        emitStatus(`synthesizing (turn ${Math.max(1, turnCount)})`, false);
        return;
      }
      if (type === "message_update") {
        const msg = event.message as { role?: unknown } | undefined;
        if (msg?.role === "assistant") {
          const partial = extractAssistantText(msg);
          if (partial) streamedText = partial;
        }
        return;
      }
      if (type === "message_end" || type === "turn_end") {
        const msg = event.message as {
          role?: unknown;
          stopReason?: unknown;
          errorMessage?: unknown;
        } | undefined;
        if (msg?.role === "assistant") {
          if (msg.stopReason === "error" || msg.errorMessage) {
            assistantError = String(msg.errorMessage ?? "provider/model error");
          }
          const text = extractAssistantText(msg);
          if (text) completedText = text;
        }
        return;
      }
      if (type === "agent_end") {
        const messages = Array.isArray(event.messages) ? event.messages : [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as { role?: unknown } | undefined;
          if (msg?.role !== "assistant") continue;
          const text = extractAssistantText(msg);
          if (text) {
            completedText = text;
            break;
          }
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      resetIdleTimer();
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed && typeof parsed === "object") {
              handleEvent(parsed);
            }
          } catch {
            // Ignore non-JSON lines.
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      resetIdleTimer();
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2_000);
    });

    child.once("error", (error) => {
      finish({
        status: cancelled ? "cancelled" : "error",
        message: sanitizeStatusText(error.message, 160),
        agent: options.target.agent,
        model: options.target.label,
        elapsedMs: Date.now() - startedAt,
      });
    });

    child.once("close", (code) => {
      const trailing = stdoutBuffer.trim();
      if (trailing) {
        try {
          const parsed = JSON.parse(trailing) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") handleEvent(parsed);
        } catch {
          // Ignore partial trailing line.
        }
      }

      const elapsedMs = Date.now() - startedAt;
      if (cancelled) {
        finish({ status: "cancelled", elapsedMs });
        return;
      }

      const rawReply = (completedText || streamedText).trim();
      if (killReason && !rawReply) {
        finish({
          status: "error",
          message: killReason,
          agent: options.target.agent,
          model: options.target.label,
          elapsedMs,
        });
        return;
      }

      if (!rawReply) {
        const detail =
          assistantError ||
          stderrTail.trim().split(/\r?\n/).pop() ||
          `helper exited with code ${code ?? "null"}`;
        finish({
          status: "error",
          message: sanitizeStatusText(detail, 180),
          agent: options.target.agent,
          model: options.target.label,
          elapsedMs,
        });
        return;
      }

      const parsed = parseDeepenReply(rawReply);
      if (!parsed) {
        finish({
          status: "parse_error",
          savedPath: saveUnparsedReply(rawReply),
          agent: options.target.agent,
          model: options.target.label,
          elapsedMs,
        });
        return;
      }

      finish({
        status: "ok",
        parsed,
        rawReply,
        agent: options.target.agent,
        model: options.target.label,
        turns: turnCount,
        elapsedMs,
      });
    });
  });

  return {
    startedAt,
    agentLabel: options.target.agent,
    modelLabel: () => options.target.label,
    currentPhase: () => phase,
    turns: () => turnCount,
    cancel,
    promise,
  };
}

export function startDeepenRun(options: DeepenRunOptions): ActiveDeepenHandle {
  const taskRunner = getTaskExtensionRunner();
  if (taskRunner) {
    return startViaTaskRunner(taskRunner, options);
  }
  return startStandaloneFallback(options);
}
