// Background read-only Pi subprocess runner for /deepen.
//
// Spawns `pi --mode json -p` with subagent/headless env isolation so lead-only
// hooks, UI chrome, terminal watchdogs, and MCP startups stay off while
// provider adapters (claude-bridge, antigravity, muse) and pi-fff stay active.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessTree } from "./process-tree-kill.ts";
import {
  buildDeepenUserPrompt,
  DEEPEN_SYSTEM_INSTRUCTIONS,
  EXCLUDED_HELPER_TOOLS,
  parseDeepenReply,
  READ_ONLY_TOOLS,
  sanitizeStatusText,
  summarizeToolTarget,
  type ParsedDeepenReply,
} from "./prompt.ts";

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

export interface DeepenSettings {
  model?: string;
  thinking?: string;
}

export interface ResolvedModelTarget {
  provider?: string;
  modelId: string;
  label: string;
  thinking?: string;
}

export interface DeepenRunOptions {
  cwd: string;
  draftPrompt: string;
  forkSessionFile?: string;
  target: ResolvedModelTarget;
  onStatus?: (statusText: string) => void;
}

export type DeepenOutcome =
  | {
      status: "ok";
      parsed: ParsedDeepenReply;
      rawReply: string;
      model: string;
      turns: number;
      elapsedMs: number;
    }
  | {
      status: "cancelled";
      elapsedMs: number;
    }
  | {
      status: "parse_error";
      savedPath: string;
      model: string;
      elapsedMs: number;
    }
  | {
      status: "error";
      message: string;
      model: string;
      elapsedMs: number;
    };

export interface ActiveDeepenHandle {
  readonly startedAt: number;
  readonly modelLabel: string;
  readonly currentPhase: () => string;
  readonly turns: () => number;
  cancel: () => void;
  promise: Promise<DeepenOutcome>;
}

export function resolveModelTarget(
  settings: unknown,
  activeModel: { provider: string; id: string } | undefined,
  activeThinking: string | undefined,
): ResolvedModelTarget | undefined {
  const cfg =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? ((settings as Record<string, unknown>).deepen as DeepenSettings | undefined)
      : undefined;

  const configuredModel =
    typeof cfg?.model === "string" ? cfg.model.trim() : "";
  const configuredThinking =
    typeof cfg?.thinking === "string" && VALID_THINKING.has(cfg.thinking.trim())
      ? cfg.thinking.trim()
      : undefined;
  const fallbackThinking =
    typeof activeThinking === "string" && VALID_THINKING.has(activeThinking.trim())
      ? activeThinking.trim()
      : undefined;
  const thinking = configuredThinking ?? fallbackThinking;

  if (configuredModel) {
    const slash = configuredModel.indexOf("/");
    if (slash > 0) {
      const provider = configuredModel.slice(0, slash).trim();
      const modelId = configuredModel.slice(slash + 1).trim();
      if (provider && modelId) {
        return {
          provider,
          modelId,
          label: `${provider}/${modelId}`,
          thinking,
        };
      }
    }
    return {
      modelId: configuredModel,
      label: configuredModel,
      thinking,
    };
  }

  if (!activeModel?.id) return undefined;
  return {
    provider: activeModel.provider,
    modelId: activeModel.id,
    label: `${activeModel.provider}/${activeModel.id}`,
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

export function startDeepenRun(options: DeepenRunOptions): ActiveDeepenHandle {
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
    options.onStatus(`deepen \u00b7 ${phase}`);
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

    if (options.target.provider) {
      args.push("--provider", options.target.provider, "--model", options.target.modelId);
    } else {
      args.push("--model", options.target.modelId);
    }
    if (options.target.thinking) {
      args.push("--thinking", options.target.thinking);
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
          PI_SUBAGENT_AGENT: "deepen",
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
        model: options.target.label,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

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
          if (partial) streamedText = partial.slice(0, 24_000);
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
          model: options.target.label,
          elapsedMs,
        });
        return;
      }

      const parsed = parseDeepenReply(rawReply);
      if (!parsed) {
        const savedPath = join(tmpdir(), `pi-deepen-reply-${Date.now()}.md`);
        try {
          writeFileSync(savedPath, rawReply, "utf8");
        } catch {
          // Fall through with path report if write failed.
        }
        finish({
          status: "parse_error",
          savedPath,
          model: options.target.label,
          elapsedMs,
        });
        return;
      }

      finish({
        status: "ok",
        parsed,
        rawReply,
        model: options.target.label,
        turns: turnCount,
        elapsedMs,
      });
    });
  });

  return {
    startedAt,
    modelLabel: options.target.label,
    currentPhase: () => phase,
    turns: () => turnCount,
    cancel,
    promise,
  };
}
