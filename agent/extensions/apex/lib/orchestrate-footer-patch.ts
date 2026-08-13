// Narrow process-wide patch for Pi's stock FooterComponent.
//
// Pi's built-in footer owns every existing section. This patch only relocates
// the `orchestrate` extension status from the stock status row onto row 1.
// No custom footer is installed, and stock rendering remains authoritative.

import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  safeTruncateToWidth,
  safeVisibleWidth,
} from "./safe-text-layout.ts";

export const ORCHESTRATE_STATUS_KEY = "orchestrate";
export const ORCHESTRATE_STATUS_LABEL = "orchestrator";

const PATCH_KEY = Symbol.for("pi.apex.orchestrateFooterPatch.state");

type FooterRuntime = {
  footerData?: {
    getExtensionStatuses?: () => ReadonlyMap<string, string>;
  };
};

type FooterRender = (this: FooterRuntime, width: number) => string[];
type RelocateDelegate = (
  stockLines: string[],
  statuses: ReadonlyMap<string, string>,
  width: number,
) => string[];

type FooterPrototype = { render: FooterRender };
type FooterConstructor = { prototype: FooterPrototype };

type PatchRecord = {
  original: FooterRender;
  delegate: RelocateDelegate;
};

type PatchRegistry = {
  records: WeakMap<object, PatchRecord>;
};

const globalPatchState = globalThis as typeof globalThis & {
  [PATCH_KEY]?: PatchRegistry;
};

function registry(): PatchRegistry {
  return (globalPatchState[PATCH_KEY] ??= { records: new WeakMap() });
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function composeStockRowWithStatus(
  stockRow: string,
  status: string,
  width: number,
): string {
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (limit === 0) return "";

  const right = safeTruncateToWidth(sanitizeStatusText(status), limit);
  const rightWidth = safeVisibleWidth(right);
  if (rightWidth === 0) return safeTruncateToWidth(stockRow, limit);
  if (rightWidth + 1 > limit) return right;

  const left = safeTruncateToWidth(stockRow, limit - rightWidth - 1);
  const leftWidth = safeVisibleWidth(left);
  const padding = " ".repeat(Math.max(1, limit - leftWidth - rightWidth));
  return `${left}${padding}${right}`;
}

/**
 * Relocate only the orchestrator status. Without that key, stock output is
 * returned byte-for-byte and by reference.
 */
export function relocateOrchestrateStatus(
  stockLines: string[],
  statuses: ReadonlyMap<string, string>,
  width: number,
): string[] {
  if (!statuses.has(ORCHESTRATE_STATUS_KEY)) return stockLines;
  if (stockLines.length === 0) return stockLines;

  const orchestrate = statuses.get(ORCHESTRATE_STATUS_KEY) ?? "";
  const baseLines = stockLines.length > 2
    ? stockLines.slice(0, -1)
    : stockLines.slice();
  baseLines[0] = composeStockRowWithStatus(
    baseLines[0] ?? "",
    orchestrate,
    width,
  );

  const remainingStatuses = Array.from(statuses.entries())
    .filter(([key]) => key !== ORCHESTRATE_STATUS_KEY)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text));

  if (remainingStatuses.length > 0) {
    baseLines.push(
      safeTruncateToWidth(remainingStatuses.join(" "), width),
    );
  }
  return baseLines;
}

function resolvePrototype(
  target: FooterConstructor | FooterPrototype,
): FooterPrototype | undefined {
  const candidate = "prototype" in target ? target.prototype : target;
  return candidate && typeof candidate.render === "function"
    ? candidate
    : undefined;
}

/**
 * Patch a FooterComponent-compatible prototype exactly once. Reinstallation
 * updates the global delegate so `/reload` picks up new code without stacking
 * wrappers or retaining a stale module closure.
 */
export function installOrchestrateFooterPatch(
  target: FooterConstructor | FooterPrototype,
  delegate: RelocateDelegate = relocateOrchestrateStatus,
): boolean {
  const prototype = resolvePrototype(target);
  if (!prototype) return false;

  const records = registry().records;
  const existing = records.get(prototype);
  if (existing) {
    existing.delegate = delegate;
    return true;
  }

  const record: PatchRecord = {
    original: prototype.render,
    delegate,
  };

  prototype.render = function renderWithOrchestrator(width: number): string[] {
    const stockLines = record.original.call(this, width);
    try {
      const statuses = this.footerData?.getExtensionStatuses?.();
      if (!statuses || typeof statuses.has !== "function") return stockLines;
      return record.delegate(stockLines, statuses, width);
    } catch {
      return stockLines;
    }
  };

  records.set(prototype, record);
  return true;
}

/** Resolve the FooterComponent module beside the CLI that launched this process. */
export function resolveRuntimeFooterPath(
  cliPath: string | undefined,
): string | undefined {
  if (!cliPath) return undefined;
  try {
    return join(
      dirname(resolve(cliPath)),
      "modes",
      "interactive",
      "components",
      "footer.js",
    );
  } catch {
    return undefined;
  }
}

/** Patch the exact Pi package instance used by the running CLI. */
export async function installRuntimeOrchestrateFooterPatch(
  cliPath = process.argv[1],
): Promise<boolean> {
  const footerPath = resolveRuntimeFooterPath(cliPath);
  if (!footerPath) return false;
  try {
    const runtime = await import(pathToFileURL(footerPath).href) as {
      FooterComponent?: FooterConstructor;
    };
    return runtime.FooterComponent
      ? installOrchestrateFooterPatch(runtime.FooterComponent)
      : false;
  } catch {
    return false;
  }
}
