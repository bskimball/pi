// skill-invocation: compact Apex chrome for Pi skill invocation messages.

import {
  SkillInvocationMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { apexPresentationEnabled } from "./presentation.ts";
import {
  fallbackTruncateToWidth,
  safeTruncateToWidth,
  stripTerminalSequences,
} from "./safe-text-layout.ts";
import { reportRenderFailure } from "./tool-receipt.ts";

const STATE_KEY = Symbol.for("pi.apex.skillInvocation.state");
const WRAPPER_VERSION = 1;

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
  if (current.installed && current.version >= WRAPPER_VERSION) return;
  const prototype = SkillInvocationMessageComponent.prototype as unknown as SkillComponent;
  if (!current.originalRender) current.originalRender = prototype.render;

  prototype.render = function renderApexSkill(width: number): string[] {
    const s = state();
    if (!apexPresentationEnabled() && s.originalRender) {
      return s.originalRender.call(this, width);
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
}
