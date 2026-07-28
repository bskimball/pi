// Specialist agent discovery / model attempt helpers for async RPC workers.
// Intentionally duplicated from amp-task.ts rather than extracted, to avoid
// a risky refactor of the stability-sensitive sync task extension.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  fallbackModels: string[];
  thinking?: string;
  tools?: string;
  maxTurns?: number;
  timeoutSec?: number;
  /** Skills are prompt-injected and read via the read tool; false passes --no-skills. */
  inheritSkills: boolean;
  body: string;
  file: string;
}

const AGENT_DIRS = [
  path.join(os.homedir(), ".pi", "agent", "agents"),
  path.join(process.cwd(), ".pi", "agents"),
];

export function parseAgentFile(file: string): AgentDef | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return undefined;
    const fm = m[1];
    const body = m[2].trim();
    const get = (key: string): string | undefined => {
      const line = fm.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
      return line ? line[1].trim() : undefined;
    };
    const getList = (key: string): string[] => {
      const inline = get(key);
      const clean = (value: string) =>
        value
          .trim()
          .replace(/^(["'])(.*)\1$/, "$2")
          .trim();
      if (inline) {
        return inline
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map(clean)
          .filter(Boolean);
      }
      const block = fm.match(
        new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]+-.*(?:\\r?\\n|$))+)`, "m"),
      );
      if (!block) return [];
      return block[1]
        .split(/\r?\n/)
        .map((line) =>
          clean(line.match(/^[ \t]+-[ \t]*(.+?)[ \t]*$/)?.[1] ?? ""),
        )
        .filter(Boolean);
    };
    return {
      name: get("name") ?? path.basename(file, ".md"),
      description: get("description") ?? "",
      model: get("model"),
      fallbackModels: getList("fallbackModels"),
      thinking: get("thinking"),
      tools: get("tools"),
      maxTurns: get("maxTurns")
        ? Number(get("maxTurns")) || undefined
        : undefined,
      timeoutSec: get("timeoutSec")
        ? Number(get("timeoutSec")) || undefined
        : undefined,
      inheritSkills: get("inheritSkills") !== "false",
      body,
      file,
    };
  } catch {
    return undefined;
  }
}

export function discoverAgents(): Map<string, AgentDef> {
  const agents = new Map<string, AgentDef>();
  for (const dir of AGENT_DIRS) {
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md") && !f.startsWith("_"));
    } catch {
      continue;
    }
    for (const file of files) {
      const def = parseAgentFile(path.join(dir, file));
      if (def) agents.set(def.name, def);
    }
  }
  return agents;
}

/** Shared preamble (_shared.md) and handoff (_handoff.md); project overrides global. */
export function readSharedFile(name: string): string | undefined {
  for (const dir of [...AGENT_DIRS].reverse()) {
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8").trim();
      if (text) return text;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export function modelProvider(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

export function agentProvider(def: AgentDef | undefined): string | undefined {
  return modelProvider(def?.model);
}

export function qualifyModel(
  model: string | undefined,
  provider: string | undefined,
): string | undefined {
  if (!model || model.includes("/") || !provider) return model;
  return `${provider}/${model}`;
}

/**
 * Build ordered model attempts. Explicit override replaces only the primary;
 * declared fallbacks remain, excluding the default primary.
 */
export function modelAttempts(
  def: AgentDef,
  override?: string,
): Array<string | undefined> {
  const provider = agentProvider(def);
  const defaultPrimary = qualifyModel(def.model, provider);
  const qualifiedFallbacks = def.fallbackModels.map((model) =>
    qualifyModel(model, provider),
  );
  const chain = override
    ? [
        qualifyModel(override, provider),
        ...qualifiedFallbacks.filter((model) => model !== defaultPrimary),
      ]
    : [defaultPrimary, ...qualifiedFallbacks];
  return [
    ...new Set(chain.filter((model): model is string => !!model)),
  ];
}

export function stderrDiagnostic(stderr: string): string | undefined {
  const text = stderr.replace(/\r\n/g, "\n").trim();
  if (!text) return undefined;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const withoutSee = lines
    .filter(
      (line) =>
        !/^(?:see|docs?|http)/i.test(line) &&
        !/(?:^|[\\/])docs[\\/](?:models|providers)\.md\b/i.test(line),
    )
    .join(" ");
  const candidate = (withoutSee || lines.join(" ")).slice(0, 400);
  return candidate || undefined;
}
