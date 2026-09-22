import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getUsage, isSupportedModel, type UsageStatus } from "./usage.ts";

const STATUS_KEY = "codex-usage";

function format(status: UsageStatus): string | undefined {
  const parts = [
    status.fiveHourRemaining === undefined ? undefined : `5h ${Math.round(status.fiveHourRemaining)}% left`,
    status.weeklyRemaining === undefined ? undefined : `weekly ${Math.round(status.weeklyRemaining)}% left`,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? `Codex usage: ${parts.join(" · ")}` : undefined;
}

export default function codexUsage(pi: ExtensionAPI): void {
  let generation = 0;
  let stopped = false;

  const clear = (ctx: ExtensionContext) => {
    generation++;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };
  const refresh = async (ctx: ExtensionContext) => {
    const current = ++generation;
    if (stopped || !isSupportedModel(ctx.model)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const status = await getUsage(ctx);
    if (!stopped && current === generation) ctx.ui.setStatus(STATUS_KEY, status ? format(status) : undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    stopped = false;
    return refresh(ctx);
  });
  pi.on("model_select", async (_event, ctx) => refresh(ctx));
  pi.on("agent_end", async (_event, ctx) => refresh(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    stopped = true;
    clear(ctx);
  });
}
