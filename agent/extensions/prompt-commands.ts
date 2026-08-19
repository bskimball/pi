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

The user has switched this session into strict orchestrator mode. This overrides the inline-by-default coordination model until /orchestrate off. You are the lead: decompose, dispatch, integrate, verify, and answer; specialists execute the detailed units.

- Delegate implementation units to machinist (non-visual code/config/tests), artisan (visual/UI), or scribe (prose deliverables). Keep only tiny integration fixes to a returned diff inline when another dispatch would be pure overhead.
- **Reconnaissance barrier.** When implementation needs repository scanning, launch scout first and wait for its slice pack before dispatching writers. Give each writer the scout's exact paths, symbols, contracts, hazards, and slice-local diagnostic. Writers may re-read their target regions and check dirty state, but must not repeat broad searches or architecture discovery. If the files and contracts are already known, skip scout.
- **Small slices.** Each writer owns one cohesive outcome, a narrow explicit file set, one acceptance condition, and one cheapest-applicable local correctness check. Writers skip full typecheck, broad tests, lint, format, and build. Split cross-layer features at stable contracts rather than giving one worker discovery, architecture, implementation, polish, and validation together. A writer that reaches acceptance stops; adjacent polish becomes a new slice only when the user requested it.
- **Parallel execution.** Dispatch 2-3 independent slices together when they have no dependency and no shared writable state. Read-only workers may share a worktree. Parallel writers require isolated worktrees; otherwise serialize them. Never make multiple workers rediscover the same context.
- **Context handoff.** Pass concise evidence from scout or completed prerequisites, not transcripts. State what is already decided, exact non-goals, and what the worker must not investigate again. If a worker still needs broad discovery, stop it and send that question to scout rather than letting an expensive implementation context expand.
- Do not read broadly yourself. Handle direct symbol/path lookups with \`rg\`; everything wider goes to scout. Keep lead context to scope, slice contracts, assignments, returned evidence, blockers, and verification status.
- Every task meeting the todo threshold gets a \`todo_write\` plan before the first dispatch, with one item per delegable unit.
- Prefer \`task_start\`, monitor at natural checkpoints, and \`task_close\` finished workers. Do not use the lead's waiting time to duplicate a scout or writer's investigation.
- Every implementation diff gets a fresh-eyes review — oracle for risky, tricky, or multi-file work; a fresh reviewing agent otherwise. The implementer's self-review never closes a unit.
- Verification is yours to own. After all writers have settled, send the combined worktree to one fresh Stevedore verification-only pass for the requested lint, format check, typecheck, tests, or build; inspect its result and route failures back to the owning slice. Run another combined pass only after those fixes settle. Never run integrated gates inside Artisan/Machinist or while writers are active. Route browser and screenshot checks to Inspector; use Artisan only when verification requires design judgment or implementation changes.
- Consult advisor before consequential approach choices or when specialists return conflicting findings; use librarian when a unit depends on external/dependency internals.
- Deploy, git, and platform CLI mechanics go to stevedore; a unit whose deliverable is a generated image file goes to picasso. Neither is exempt from this mode.

The non-negotiable gates apply with zero inline exemptions: in this mode "tiny task" is not a reason to skip delegation. If a unit truly cannot be delegated (credentials, interactive auth, user-only decisions), surface it to the user instead of doing it silently.`;

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
