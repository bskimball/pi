// /deepen — Grounded pre-send vertical prompt sharpener inspired by Felix
// Rieseberg's "#depth" essay, adapted to ~/.pi's standalone, subagent-isolated,
// and timer-free Windows Terminal rendering constraints.

import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { READ_ONLY_TOOLS } from "./deepen/internal/prompt.ts";
import {
  resolveDeepenTarget,
  startDeepenRun,
  type ActiveDeepenHandle,
  type DeepenOutcome,
} from "./deepen/internal/runner.ts";

const STATUS_KEY = "deepen";
const ALLOWED_HELPER_TOOLS = new Set<string>(READ_ONLY_TOOLS);

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

function clearFooterStatus(ctx: ExtensionContext | undefined): void {
  if (!ctx?.hasUI) return;
  try {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  } catch {
    // Ignore stale UI context on reload/shutdown.
  }
}

function hasConversationMessages(ctx: ExtensionContext): boolean {
  try {
    return ctx.sessionManager
      .getEntries()
      .some((entry) => entry.type === "message");
  } catch {
    return false;
  }
}

function formatSeconds(elapsedMs: number): string {
  return `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`;
}

export default function (pi: ExtensionAPI): void {
  // Inside the spawned helper child: enforce strict read-only tool execution
  // (including blocking bash/powershell) and skip interactive command setup.
  if (process.env.PI_DEEPEN_HELPER === "1") {
    pi.on("tool_call", (event) => {
      if (!ALLOWED_HELPER_TOOLS.has(event.toolName)) {
        return {
          block: true,
          reason: `Tool "${event.toolName}" is disabled in /deepen read-only helper. Use ${READ_ONLY_TOOLS.join(", ")}.`,
        };
      }
      return undefined;
    });
    return;
  }

  // Skip registering lead slash commands inside other subagent workers.
  if (process.env.PI_SUBAGENT === "1") {
    return;
  }

  let activeRun: ActiveDeepenHandle | undefined;
  let activeRunToken: symbol | undefined;
  let activeCtx: ExtensionContext | undefined;

  const stopActiveRun = () => {
    const current = activeRun;
    const ctx = activeCtx;
    activeRun = undefined;
    activeRunToken = undefined;
    activeCtx = undefined;
    current?.cancel();
    clearFooterStatus(ctx);
  };

  pi.on("session_shutdown", () => {
    stopActiveRun();
  });

  pi.registerCommand("deepen", {
    description:
      "Inspect workspace files read-only and stage a deeper, grounded prompt in the editor (/deepen [prompt|cancel|status])",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim().toLowerCase();
      const items = [
        {
          value: "cancel",
          label: "cancel",
          description: "Abort the running /deepen background pass",
        },
        {
          value: "status",
          label: "status",
          description: "Show current /deepen background status",
        },
      ];
      if (!trimmed) {
        return [
          {
            value: "",
            label: "<prompt>",
            description:
              "Draft prompt to deepen (or leave empty to deepen the in-progress task)",
          },
          ...items,
        ];
      }
      const matched = items.filter((item) => item.value.startsWith(trimmed));
      return matched.length ? matched : null;
    },
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const trimmed = rawArgs.trim();
      const lower = trimmed.toLowerCase();

      if (lower === "cancel" || lower === "abort" || lower === "stop") {
        if (!activeRun) {
          notify(ctx, "No /deepen pass is currently running.", "info");
          return;
        }
        stopActiveRun();
        notify(ctx, "Cancelled /deepen.", "info");
        return;
      }

      if (lower === "status") {
        if (!activeRun) {
          notify(ctx, "/deepen is idle.", "info");
          return;
        }
        const elapsed = formatSeconds(Date.now() - activeRun.startedAt);
        const worker = activeRun.workerId?.();
        const parts = [
          worker,
          activeRun.agentLabel,
          activeRun.modelLabel(),
          `turn ${Math.max(1, activeRun.turns())}`,
          elapsed,
        ].filter(Boolean);
        notify(
          ctx,
          `/deepen running (${parts.join(", ")}): ${activeRun.currentPhase()}`,
          "info",
        );
        return;
      }

      if (activeRun) {
        notify(
          ctx,
          "/deepen is already running. Use `/deepen cancel` to stop it first.",
          "warning",
        );
        return;
      }

      const hasHistory = hasConversationMessages(ctx);
      if (!trimmed && !hasHistory) {
        notify(
          ctx,
          "Usage: `/deepen <prompt>` (or run `/deepen` in an active conversation to deepen the task in progress).",
          "warning",
        );
        return;
      }

      const target = resolveDeepenTarget(
        pi.getSettings(),
        ctx.cwd,
        ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
        ctx.thinkingLevel ?? pi.getThinkingLevel(),
      );
      if (!target) {
        notify(
          ctx,
          "No active model or agent found for /deepen. Select a model or configure `\"deepen\": { \"agent\": \"scribe\", \"model\": \"provider/id\" }` in settings.json.",
          "error",
        );
        return;
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      const forkSessionFile =
        hasHistory && sessionFile && existsSync(sessionFile)
          ? sessionFile
          : undefined;

      const runToken = Symbol("deepen-run");
      activeRunToken = runToken;
      activeCtx = ctx;
      const handle = startDeepenRun({
        cwd: ctx.cwd,
        draftPrompt: trimmed,
        forkSessionFile,
        target,
        ctx,
        onStart: ({ workerId, agent, model }) => {
          if (activeRunToken !== runToken || !ctx.hasUI) return;
          const details = [workerId, model, "read-only"]
            .filter(Boolean)
            .join(", ");
          const trackHint = workerId ? "Track in /agents or run" : "Run";
          notify(
            ctx,
            `Deepening prompt with ${agent} (${details})... ${trackHint} \`/deepen cancel\` to stop.`,
            "info",
          );
        },
        onStatus: (statusText) => {
          if (activeRunToken !== runToken || !ctx.hasUI) return;
          try {
            ctx.ui.setStatus(STATUS_KEY, statusText);
          } catch {
            // Ignore transient UI errors.
          }
        },
      });
      activeRun = handle;

      const deliver = (outcome: DeepenOutcome) => {
        if (activeRunToken === runToken) {
          activeRun = undefined;
          activeRunToken = undefined;
          activeCtx = undefined;
          clearFooterStatus(ctx);
        }

        if (outcome.status === "cancelled") {
          return;
        }

        if (outcome.status === "error") {
          const meta = [outcome.workerId, outcome.agent, outcome.model]
            .filter(Boolean)
            .join(", ");
          notify(
            ctx,
            `/deepen failed (${meta}): ${outcome.message}`,
            "error",
          );
          return;
        }

        if (outcome.status === "parse_error") {
          const meta = [outcome.workerId, outcome.agent, outcome.model]
            .filter(Boolean)
            .join(", ");
          notify(
            ctx,
            `/deepen reply missed <improved-prompt> tags (${meta}); raw reply saved to ${outcome.savedPath}`,
            "warning",
          );
          return;
        }

        const { notes, improvedPrompt } = outcome.parsed;
        try {
          pi.appendEntry("deepen", {
            workerId: outcome.workerId,
            agent: outcome.agent,
            sessionFile: outcome.sessionFile,
            draftPrompt: trimmed,
            notes,
            improvedPrompt,
            model: outcome.model,
            turns: outcome.turns,
            elapsedMs: outcome.elapsedMs,
          });
        } catch {
          // Non-fatal if session persistence is disabled.
        }

        if (ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc")) {
          const existingDraft = ctx.ui.getEditorText();
          const mergedDraft = existingDraft.trim()
            ? `${improvedPrompt}\n\n${existingDraft}`
            : improvedPrompt;
          ctx.ui.setEditorText(mergedDraft);

          const meta = [
            outcome.workerId,
            outcome.agent,
            outcome.model,
            formatSeconds(outcome.elapsedMs),
          ]
            .filter(Boolean)
            .join(", ");
          const summaryLines = [
            `Deepened prompt staged in editor (${meta}) - review and press Enter to send.`,
            ...(notes ? ["", notes] : []),
          ];
          notify(ctx, summaryLines.join("\n"), "info");
          return;
        }

        // Non-interactive print / json fallback: emit bounded output directly.
        const block = [
          notes ? `${notes}\n` : "",
          "<improved-prompt>",
          improvedPrompt,
          "</improved-prompt>",
        ]
          .filter(Boolean)
          .join("\n");
        process.stdout.write(`${block}\n`);
      };

      if (ctx.mode === "print" || ctx.mode === "json") {
        const outcome = await handle.promise;
        deliver(outcome);
        return;
      }

      void handle.promise.then(deliver);
    },
  });
}
