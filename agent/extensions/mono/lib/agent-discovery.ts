// Specialist agent discovery / model attempt helpers.
// Canonical Agent Catalog used by amp-task (sync) and async-task (RPC workers).

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

/** Global agents dir plus project override. Project wins on name collision. */
function agentDirs(): string[] {
  return [
    path.join(getAgentDir(), "agents"),
    path.join(process.cwd(), ".pi", "agents"),
  ];
}

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
  for (const dir of agentDirs()) {
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
  for (const dir of [...agentDirs()].reverse()) {
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
  // A bare override inherits only the primary model's provider. Inferring from
  // a fallback could silently route it to an unrelated provider.
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
 * Empty chain returns `[undefined]` so a single default-model attempt still runs.
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
  // An explicit override replaces only the primary model. The agent's declared
  // fallback chain remains available, while its default primary stays excluded
  // so review-diversity overrides cannot silently fall back to that model even
  // if it was accidentally repeated in fallbackModels.
  const chain = override
    ? [
        qualifyModel(override, provider),
        ...qualifiedFallbacks.filter((model) => model !== defaultPrimary),
      ]
    : [defaultPrimary, ...qualifiedFallbacks];
  const attempts = [
    ...new Set(chain.filter((model): model is string => !!model)),
  ];
  return attempts.length ? attempts : [undefined];
}

/** Prefer a decisive CLI diagnostic over trailing docs/help text. */
export function stderrDiagnostic(stderr: string): string | undefined {
  const lines = stderr
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500),
    )
    .filter(Boolean);
  if (!lines.length) return undefined;

  const documentationOnly = (line: string) => {
    const withoutSee = line.replace(/^see:\s*/i, "");
    return (
      !withoutSee ||
      /(?:^|[\\/])docs[\\/](?:models|providers)\.md\b/i.test(withoutSee)
    );
  };
  const useful = lines.filter((line) => !documentationOnly(line));
  const decisive = useful.find((line) =>
    /no api key|unauthori[sz]ed|forbidden|rate limit|authentication|something went wrong|\b(?:error|exception|failed|invalid|unknown|not found|timed out|terminated|refused)\b|\b(?:ECONN\w*|ENOTFOUND|EAI_AGAIN)\b/i.test(
      line,
    ),
  );
  // CLI errors normally lead with the cause and append login/help text. When
  // no keyword matches, the first non-documentation line is more useful than
  // the trailing help line.
  const candidate = decisive ?? useful.at(0) ?? lines.at(0);
  return candidate ? candidate.slice(0, 400) : undefined;
}
