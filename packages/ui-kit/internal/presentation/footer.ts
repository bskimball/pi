// footer: the contract between the kit-owned footer runtime and each UI's
// footer renderer.
//
// The kit collects a FooterSnapshot from Pi events (never during render) and
// installs one footer component per active UI. Each UI owns only the look:
// a pure BuildFooter that maps a snapshot to styled lines. The kit bounds
// and width-truncates whatever the renderer returns.

import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { fallbackTruncateToWidth, safeTruncateToWidth } from "./safe-text-layout.ts";
import { reportRenderFailure } from "./tool-receipt.ts";
import { cleanInline, stripAnsi } from "./ui-common.ts";

export interface FooterUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface FooterStatus {
  /** Extension status key (setStatus key), e.g. "codex-usage", "jev". */
  key: string;
  /** Plain, single-line, ANSI-free text. */
  text: string;
}

export interface FooterSnapshot {
  /** Working directory with the home prefix shortened to `~`. */
  cwd: string;
  branch?: string;
  sessionName?: string;
  model?: { id: string; provider: string; reasoning: boolean };
  /** Thinking level; set only when the model supports reasoning. */
  thinking?: string;
  /** More than one provider is configured, so the provider is worth showing. */
  multiProvider: boolean;
  /** The model runs on a subscription/OAuth login rather than metered billing. */
  subscription: boolean;
  usage: FooterUsage;
  /** percent is 0-100, or null when unknown (e.g. right after compaction). */
  context: { percent: number | null; window: number };
  /** Plain text of the "mode" extension status (e.g. "Fusion"), when set. */
  mode?: string;
  /** Every other extension status, sorted by key. */
  statuses: FooterStatus[];
}

export interface FooterPaint {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

/** Pure renderer: at most FOOTER_MAX_LINES lines, each fitted to width. */
export type BuildFooter = (snapshot: FooterSnapshot, width: number, paint: FooterPaint) => string[];

export const FOOTER_MAX_LINES = 3;

/** Snapshot fields derived from events; branch and statuses are read live. */
type FooterBase = Omit<FooterSnapshot, "branch" | "mode" | "statuses" | "multiProvider">;

function shortenHome(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  if (rel === "") return "~";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return cwd;
  return `~${sep}${rel}`;
}

function addUsage(totals: FooterUsage, usage: any): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

/** Cumulative usage over every session entry, matching Pi's stock footer. */
function usageTotals(entries: readonly any[]): FooterUsage {
  const totals: FooterUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    if (entry.type === "usage") addUsage(totals, entry.usage);
    else if (entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) {
      addUsage(totals, entry.message.usage);
    } else if (entry.type === "branch_summary" || entry.type === "compaction") addUsage(totals, entry.usage);
  }
  return totals;
}

function captureBase(ctx: ExtensionContext, pi: ExtensionAPI, model = ctx.model, thinking?: string): FooterBase {
  let subscription = false;
  try {
    subscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
  } catch {
    // cosmetic
  }
  const usage = ctx.getContextUsage();
  return {
    cwd: shortenHome(ctx.sessionManager.getCwd()),
    sessionName: ctx.sessionManager.getSessionName(),
    model: model ? { id: model.id, provider: model.provider, reasoning: Boolean(model.reasoning) } : undefined,
    thinking: model?.reasoning ? (thinking ?? pi.getThinkingLevel()) : undefined,
    subscription,
    usage: usageTotals(ctx.sessionManager.getEntries()),
    context: {
      percent: usage ? usage.percent : 0,
      window: usage?.contextWindow ?? model?.contextWindow ?? 0,
    },
  };
}

function liveSnapshot(base: FooterBase, footerData: ReadonlyFooterDataProvider): FooterSnapshot {
  let mode: string | undefined;
  const statuses: FooterStatus[] = [];
  for (const [key, raw] of footerData.getExtensionStatuses()) {
    const text = cleanInline(stripAnsi(String(raw ?? "")));
    if (!text) continue;
    if (key === "mode") mode = text;
    else statuses.push({ key, text });
  }
  statuses.sort((a, b) => a.key.localeCompare(b.key));
  return {
    ...base,
    branch: footerData.getGitBranch() ?? undefined,
    mode,
    statuses,
    multiProvider: footerData.getAvailableProviderCount() > 1,
  };
}

export interface FooterRuntime {
  /** Install the kit footer, or restore Pi's when the active UI has no renderer. */
  install(ctx: ExtensionContext): void;
  clear(ctx: ExtensionContext): void;
}

/**
 * Event-driven footer: the snapshot is rebuilt on session/model/turn events
 * (never in render) and the footer repaints through Pi's render scheduler.
 * The renderer is resolved per render so a live /ui switch restyles it.
 */
export function createFooterRuntime(
  pi: ExtensionAPI,
  activeBuild: () => BuildFooter | undefined,
): FooterRuntime {
  let base: FooterBase | undefined;
  let tui: TUI | undefined;

  const refresh = (ctx: ExtensionContext, model = ctx.model, thinking?: string) => {
    if (!ctx.hasUI || !activeBuild()) return;
    try {
      base = captureBase(ctx, pi, model, thinking);
      tui?.requestRender();
    } catch (error) {
      reportRenderFailure("footer", error);
    }
  };
  pi.on("session_tree", (_event, ctx) => refresh(ctx));
  pi.on("session_compact", (_event, ctx) => refresh(ctx));
  pi.on("turn_end", (_event, ctx) => refresh(ctx));
  pi.on("agent_end", (_event, ctx) => refresh(ctx));
  pi.on("model_select", (event, ctx) => refresh(ctx, event.model));
  pi.on("thinking_level_select", (event, ctx) => refresh(ctx, ctx.model, event.level));

  class KitFooter implements Component {
    private unsubscribe: () => void;
    constructor(
      private owner: TUI,
      private theme: Theme,
      private footerData: ReadonlyFooterDataProvider,
    ) {
      this.unsubscribe = footerData.onBranchChange(() => owner.requestRender());
    }
    render(width: number): string[] {
      const w = Math.max(0, Math.floor(width));
      const build = activeBuild();
      if (!w || !base || !build) return [];
      try {
        const paint: FooterPaint = {
          fg: (color, text) => this.theme.fg(color, text),
          bold: (text) => this.theme.bold(text),
        };
        return build(liveSnapshot(base, this.footerData), w, paint)
          .slice(0, FOOTER_MAX_LINES)
          .map((line) => safeTruncateToWidth(line, w));
      } catch (error) {
        reportRenderFailure("footer", error);
        const plain = `${base.cwd}  ${base.model?.id ?? "no model"}`;
        return [this.theme.fg("dim", fallbackTruncateToWidth(plain, w))];
      }
    }
    invalidate(): void {}
    dispose(): void {
      this.unsubscribe();
      if (tui === this.owner) tui = undefined;
    }
  }

  return {
    install(ctx) {
      if (!ctx.hasUI) return;
      if (!activeBuild()) {
        this.clear(ctx);
        return;
      }
      ctx.ui.setFooter((owner, theme, footerData) => {
        tui = owner;
        return new KitFooter(owner, theme, footerData);
      });
      refresh(ctx);
    },
    clear(ctx) {
      if (ctx.hasUI) ctx.ui.setFooter(undefined);
    },
  };
}
