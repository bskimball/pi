// skill-invocation: compact Apex chrome for Pi skill invocation messages.

import {
  SkillInvocationMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { apexPresentationEnabled } from "./presentation.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  fallbackTruncateToWidth,
  safeTruncateToWidth,
  stripTerminalSequences,
} from "./safe-text-layout.ts";
import { reportRenderFailure } from "./tool-receipt.ts";

const STATE_KEY = Symbol.for("pi.apex.skillInvocation.state");
const WRAPPER_VERSION = 2;

type SkillBlock = {
  name?: string;
  location?: string;
  content?: string;
};

type SkillComponent = {
  expanded?: boolean;
  skillBlock?: SkillBlock;
  render(width: number): string[];
};

type SkillState = {
  version: number;
  installed: boolean;
  originalRender?: (this: SkillComponent, width: number) => string[];
  /** Pristine render of the bundled live copy, captured on first patch. */
  liveOriginalRender?: (this: SkillComponent, width: number) => string[];
  /** The bundled live copy has been attempted (patched, cleanly absent, or loudly failed). */
  liveAttempted?: boolean;
};

type SkillGlobal = typeof globalThis & {
  [STATE_KEY]?: SkillState;
};

function state(): SkillState {
  const global = globalThis as SkillGlobal;
  return (global[STATE_KEY] ??= { version: WRAPPER_VERSION, installed: false });
}

function sanitizeLine(value: unknown): string {
  return stripTerminalSequences(String(value ?? ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function clean(value: unknown): string {
  return String(value ?? "")
    .split(/\r?\n/)
    .map(sanitizeLine)
    .join(" ")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function apexSkillLines(component: SkillComponent, width: number): string[] {
  const skill = component.skillBlock ?? {};
  const name = clean(skill.name) || "skill";
  const location = clean(skill.location);
  const head = location ? `skill ${name} ${location}` : `skill ${name}`;
  if (!component.expanded) return [safeTruncateToWidth(head, width)];

  const body = String(skill.content ?? "")
    .split(/\r?\n/)
    .slice(0, 120)
    .map((line) =>
      safeTruncateToWidth(
        sanitizeLine(line).replace(/\t/g, "   "),
        Math.max(0, width - 2),
      ),
    );
  return [safeTruncateToWidth(head, width), ...body.map((line) => `  ${line}`)];
}

export function installSkillInvocationChrome(): void {
  const current = state();
  if (current.installed && current.version >= WRAPPER_VERSION) {
    if (!current.liveAttempted) void patchLiveBundleSkill(current);
    return;
  }
  const prototype = SkillInvocationMessageComponent.prototype as unknown as SkillComponent;
  if (!current.originalRender) current.originalRender = prototype.render;
  const originalRender = current.originalRender;

  prototype.render = function renderApexSkill(width: number): string[] {
    if (!apexPresentationEnabled() && originalRender) {
      return originalRender.call(this, width);
    }
    try {
      return apexSkillLines(this, width);
    } catch (error) {
      reportRenderFailure("skill", error);
      return [fallbackTruncateToWidth("[skill unavailable]", width)];
    }
  };
  current.version = WRAPPER_VERSION;
  current.installed = true;
  if (!current.liveAttempted) void patchLiveBundleSkill(current);
}

/**
 * Chrome the bundled copy of SkillInvocationMessageComponent that the live
 * TUI instantiates. The imported SDK class can differ from the bundled live
 * class. Pi has no public renderer registration for its skill messages yet;
 * this is the remaining presentation adapter that needs bundle access.
 * Fire-and-forget; a missing bundle (dev/test) silently skips, anything else
 * that fails is logged once to pi-render.log.
 */
async function patchLiveBundleSkill(current: SkillState): Promise<void> {
  if (current.liveAttempted) return;
  current.liveAttempted = true;
  const exported = await importLiveBundleModule()
    .then((ns) => ns.SkillInvocationMessageComponent)
    .catch(() => undefined);
  const prototype =
    typeof exported === "function"
      ? ((exported as { prototype?: unknown }).prototype as SkillComponent | undefined)
      : undefined;
  if (!prototype || prototype === (SkillInvocationMessageComponent.prototype as unknown)) {
    // Unbundled runtime (or no bundle): the primary patch already covers it.
    return;
  }
  if (typeof prototype.render !== "function") {
    reportRenderFailure(
      "skill",
      new Error(
        "Bundled SkillInvocationMessageComponent has no render method; skill chrome unavailable for live messages.",
      ),
    );
    return;
  }
  if (!current.liveOriginalRender) current.liveOriginalRender = prototype.render;
  const originalRender = current.liveOriginalRender;
  prototype.render = function renderApexSkillLive(width: number): string[] {
    if (!apexPresentationEnabled() && originalRender) {
      return originalRender.call(this, width);
    }
    try {
      return apexSkillLines(this, width);
    } catch (error) {
      reportRenderFailure("skill", error);
      return [fallbackTruncateToWidth("[skill unavailable]", width)];
    }
  };
}

/**
 * File URL of the bundled core entry that owns the live component copies, if
 * this install has one. Derived from the already-resolved core entry so it
 * works regardless of where Pi is installed; undefined on unbundled runtimes
 * (SDK/tests without a bundle).
 */
function resolveLiveBundleEntryUrl(): string | undefined {
  let entry: string;
  try {
    entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  } catch {
    return undefined;
  }
  const suffix = "/dist/index.js";
  if (!entry.endsWith(suffix)) return undefined;
  const candidate = `${entry.slice(0, -suffix.length)}/dist/bundle/index.js`;
  let path: string;
  try {
    path = fileURLToPath(candidate);
  } catch {
    return undefined;
  }
  return existsSync(path) ? candidate : undefined;
}

/**
 * Import the bundled core entry (the module object behind dist/bundle).
 * Private to skill-message chrome; tool receipts use the public resolver.
 * Rejects when the runtime has no bundled core entry.
 */
function importLiveBundleModule(): Promise<Record<string, unknown>> {
  const url = resolveLiveBundleEntryUrl();
  if (!url)
    return Promise.reject(new Error("No bundled core entry in this install."));
  return import(url) as Promise<Record<string, unknown>>;
}
