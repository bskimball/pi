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

The user has switched this session into strict orchestrator mode. This overrides the inline-by-default coordination model and base SYSTEM.md 2-3 fan-out until /orchestrate off. You are the lead: decompose, dispatch, integrate, verify, and answer; specialists execute the detailed units.

- Delegate implementation units to machinist (non-visual code/config/tests), artisan (visual/UI), or scribe (prose deliverables). Integrate returned work, but do not implement code inline in this mode.
- **Reconnaissance barrier.** When implementation needs repository scanning, launch scout first and wait for its slice pack before dispatching writers. Give each writer the scout's exact paths, symbols, contracts, hazards, and slice-local diagnostic. Writers may re-read their target regions and check dirty state, but must not repeat broad searches or architecture discovery. If the files and contracts are already known, skip scout.
- **Small slices.** Each writer owns one cohesive outcome, a narrow explicit file set, one acceptance condition, and one cheapest-applicable local correctness check. Writers skip full typecheck, broad tests, lint, format, and build. Split cross-layer features at stable contracts rather than giving one worker discovery, architecture, implementation, polish, and validation together. A writer that reaches acceptance stops; adjacent polish becomes a new slice only when the user requested it.
- **Role-tiered fan-out and rolling pipeline.** This block overrides base SYSTEM.md 2-3 fan-out while orchestrate is on. Maintain a total mental budget of ~5 live specialists across sync and async (prefer \`task_start\`). The runtime enforces 5 live async workers total, not the writer-3 policy. Read-only workers (scout, librarian, advisor, oracle, inspector) may fan out up to 5 and share a worktree. Writing workers (machinist, artisan, scribe, and any other editor) run at most 3 live at once; each in its own \`worktree add\` path passed as \`task_start cwd\`. Parallel writers require isolated worktrees; serialize writers that share writable files. Never make multiple workers rediscover the same context. Run a rolling pipeline instead of lockstep waves: as each writer settles, \`task_close\` it immediately and dispatch Oracle into that writer's worktree (\`cwd\` = that worktree, named files + diff), freeing a slot so the next writer can start immediately without waiting for all writers to finish. \`task_close\` Oracle workers as they settle so writer slots stay real. Merge or \`worktree remove\` a writer tree only after that tree's Oracle returns.
- **Close discipline.** Call \`task_close\` as soon as a worker's report is accepted. Settled workers occupy a live concurrency slot until closed; do not hold a settled worker for possible follow-up — respawn instead.
- **Oracle review.** Every implementation diff gets a fresh-eyes Oracle review of the actual changed files and diff in that writer's worktree, including UI code. Review once per implementation diff; a clean sequential merge does not get a second Oracle review. Dispatch an extra Oracle only if the merge was dirty (conflicts, glue commits, lead-edited integration) or a shared contract broke. The implementer's self-review and Inspector's browser verdict never close a code-review unit.
- **Sequential merge and verification.** Merge completed worktrees back into the main tree sequentially in dependency order (lead or one Stevedore rebases/merges; the worktree tool handles add/list/remove only). Conflicts become a new small slice for the owning writer. After all writers have settled and the integrated tree exists, send the combined worktree to one fresh Stevedore verification-only pass for the requested lint, format check, typecheck, tests, or build; inspect its result and route failures back to the owning slice. Run another combined pass only after those fixes settle. Never run integrated gates inside Artisan/Machinist, per-worktree, or while writers are active. UI and interaction slices are proven on the live page through Inspector after the integrated tree is real; writer-local checks and a passing Stevedore gate are not that proof. Route live browser and screenshot checks to Inspector without asking it to inspect source or diagnose code; use Artisan only when verification requires design judgment or implementation changes.
- **Context handoff.** Pass concise evidence from scout or completed prerequisites, not transcripts. State what is already decided, exact non-goals, and what the worker must not investigate again. If a worker still needs broad discovery, stop it and send that question to scout rather than letting an expensive implementation context expand.
- Do not read broadly yourself. Handle direct symbol/path lookups with \`rg\`; everything wider goes to scout. Keep lead context to scope, slice contracts, assignments, returned evidence, blockers, and verification status.
- Every task meeting the todo threshold gets a \`todo_write\` plan before the first dispatch, with one item per delegable unit.
- Prefer \`task_start\`, do independent lead work, then one \`task_wait\` (default 600s) per worker. Do not poll with \`task_status\`/\`task_wait\` loops, and do not use waiting time to duplicate a scout or writer's investigation. \`task_status\` is for blockers only. Keep returned evidence compact: outcome, files, findings, validation, blockers — not transcripts or full logs.
- Consult advisor before security-sensitive architecture, migrations, destructive data changes, public API architecture, other consequential approach choices, or when specialists return conflicting findings; use librarian when a unit depends on external/dependency internals.
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
