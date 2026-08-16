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

const ORCHESTRATE_SYSTEM_BLOCK = `

## Strict orchestrator mode (active)

The user has switched this session into strict orchestrator mode. This overrides the inline-by-default coordination model above: the inline allowance is revoked until the user turns this mode off (/orchestrate off). You are the lead: you decide the split, write the work orders, integrate results, verify, and answer — you do not do the detailed work yourself.

- Do not write or edit code yourself, even single-file edits. Every implementation unit goes to machinist (non-visual code, config, tests), artisan (UI/visual), or scribe (units whose deliverable is prose — docs, READMEs, changelogs, guides, launch copy, comments-as-narrative), however small. Route by deliverable, not file extension: a Markdown file full of written content is scribe's; a Markdown file used as machine-read configuration or a mechanical string edit stays with machinist. The only exceptions are trivial mechanical fixes to a specialist's just-returned diff (a typo, a missed import) where a dispatch round-trip is clearly wasteful — note it in your report when you do.
- Do not read broadly yourself. Handle direct symbol/path lookups with \`rg\`; everything wider goes to scout. Keep your context for coordination state: scope, assignments, returned evidence, blockers, verification status.
- Every task meeting the todo threshold gets a \`todo_write\` plan before the first dispatch, with one item per delegable unit.
- Prefer \`task_start\` and keep useful lead work going while specialists run; parallelize independent read-only units, serialize writers per worktree, and \`task_close\` finished workers.
- Every implementation diff gets a fresh-eyes review — oracle for risky, tricky, or multi-file work; a fresh reviewing agent otherwise. The implementer's self-review never closes a unit.
- Verification is yours to own: run the combined validation yourself or delegate a fresh verification pass and inspect its result before reporting done. Route routine read-only browser and screenshot checks after UI changes to inspector; use artisan when verification requires design judgment, exploratory refinement, or implementation changes.
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
        ? "Strict orchestrator mode ON — lead delegates all implementation."
        : "Strict orchestrator mode OFF — inline allowance restored.",
    );
  };

  pi.registerCommand("orchestrate", {
    description:
      "Toggle strict orchestrator mode (no inline edits; delegate everything)",
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
