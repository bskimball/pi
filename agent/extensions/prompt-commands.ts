// Native slash-command registration for browser/deploy handoffs and sticky
// strict-orchestrator mode. Browser/deploy implementation is neutral shared
// runtime so Apex Observatory can launch it without importing this extension.

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  runBrowserCommand,
  runDeployCommand,
} from "./prompt-commands/featured-commands.ts";

const ORCHESTRATE_STATUS_KEY = "orchestrate";
const ORCHESTRATE_STATUS_LABEL = "orchestrator";

const ORCHESTRATE_ENTRY_TYPE = "orchestrate-mode";

export const ORCHESTRATE_SYSTEM_BLOCK = `

## Strict orchestrator mode (active)

This mode overrides inline implementation until /orchestrate off. You remain the lead: decompose, dispatch, integrate, verify, and answer; specialists implement every code, UI, configuration, test, and prose unit. A tiny task is not an inline exemption.

- Use Scout only when broad retrieval is required. Skip it when you can already name the exact target files, relevant symbols, behavioral contract, and focused validation. Otherwise collect one Scout slice pack before writers, then pass its concise evidence rather than making writers rediscover the repository.
- Enforce an acceptance-sized decomposition before dispatch. A writer work order must own one cohesive outcome and one component/package boundary, explicit files, an observable acceptance condition, and the cheapest local check. If a proposed writer prompt names 3+ components/packages, 3+ ordered units, or combines discovery, architecture, implementation, integration, and broad verification, split it first. Never send a broad "implement the stage/feature" mission to one writer and decompose reactively through follow-up generations.
- When two or more writer slices or any prerequisite/finalization dependency is already known, use \`mission\` with explicit nodes and dependencies. Parallel writers require isolated worktrees plus scoped patch integration. Do not choose a persistent single writer merely to avoid integration. Use \`task_start\` only for one cohesive slice when steering is genuinely likely; writer prompt generations are limited to one corrective generation, then collect/close and dispatch a narrower fresh slice.
- Use synchronous \`task\` for one-shot barriers whose result is needed before proceeding: Scout discovery, Verifier/Stevedore integrated checks, Inspector live-page proof, and Oracle review. Independent one-shot calls may share one parallel tool turn. After writers settle, Inspector and Verifier may run concurrently; Oracle reviews the verified final diff after any resulting fixes.
- Require every mission writer report to end with an explicit \`Acceptance-Status: complete|partial|incomplete|failed\` line. Any status other than \`complete\` fails the slice. Do not continue the same broad mission repeatedly. Preserve its valid work, narrow the remaining contract, and respawn once with explicit missing acceptance criteria.
- Keep the lead context to decisions, slice contracts, assignments, bounded reports, blockers, integration, and gate status. Prefer mission telemetry over lifecycle narration. Before finalizing, inspect whether useful peak concurrency was 1 despite independent slices, whether single-active worker time dominated, and whether corrective generations indicate poor decomposition.
- Every implementation diff still requires Oracle review. UI behavior still requires one Inspector pass. Combined lint, format check, typecheck, tests, and build run only after writers settle, through Verifier or Stevedore verification-only mode. Route failures back to the owning writer, then run one combined pass after fixes.
- Advisor remains required for consequential choices or conflicting specialist findings; Librarian owns external/dependency research; Stevedore owns shipping and shared git/deploy mechanics; Picasso owns generated image files.

If credentials, interactive authentication, an irreversible choice, or a user-owned product decision prevents delegation, finish everything reachable and surface that blocker.`;

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

export function orchestrateStatusText(
  enabled: boolean,
  theme?: { fg?(key: string, text: string): string },
): string | undefined {
  if (!enabled) return undefined;
  try {
    const styled = theme?.fg?.("warning", ORCHESTRATE_STATUS_LABEL);
    if (typeof styled === "string" && styled.length > 0) return styled;
  } catch {}
  return ORCHESTRATE_STATUS_LABEL;
}

function syncOrchestrateStatus(ctx: ExtensionContext, enabled: boolean): void {
  try {
    ctx.ui.setStatus(
      ORCHESTRATE_STATUS_KEY,
      orchestrateStatusText(enabled, ctx.ui.theme),
    );
  } catch {}
}

export default function (pi: ExtensionAPI): void {
  let orchestrateMode = false;
  const footerPatchReady = Promise.resolve(false);

  const setOrchestrateMode = (
    enabled: boolean,
    ctx: ExtensionContext,
  ): void => {
    syncOrchestrateStatus(ctx, enabled);
    if (orchestrateMode === enabled) {
      notify(ctx, `Orchestrator mode already ${enabled ? "on" : "off"}.`);
      return;
    }
    orchestrateMode = enabled;
    pi.appendEntry(ORCHESTRATE_ENTRY_TYPE, { enabled });
    notify(
      ctx,
      enabled
        ? "Strict orchestrator mode ON — scout-first, small delegated slices."
        : "Strict orchestrator mode OFF — inline allowance restored.",
    );
  };

  pi.registerCommand("orchestrate", {
    description:
      "Toggle strict orchestrator mode (scout-first, small delegated slices)",
    handler: async (args, ctx) => {
      await footerPatchReady;
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
    await footerPatchReady;
    orchestrateMode = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === ORCHESTRATE_ENTRY_TYPE
      ) {
        const data = entry.data as { enabled?: boolean } | undefined;
        orchestrateMode = data?.enabled === true;
      }
    }
    syncOrchestrateStatus(ctx, orchestrateMode);
  });

  pi.on("before_agent_start", async (event) => {
    if (!orchestrateMode) return undefined;
    return { systemPrompt: event.systemPrompt + ORCHESTRATE_SYSTEM_BLOCK };
  });

  pi.registerCommand("browser", {
    description:
      "Attach to dedicated authenticated debug Chrome (no Allow spam)",
    handler: async (args, ctx) => runBrowserCommand(pi, args, ctx),
  });

  pi.registerCommand("deploy", {
    description:
      "Delegate lint, format, verify, and deploy to the stevedore subagent",
    handler: async (args, ctx) => runDeployCommand(pi, args, ctx),
  });
}
