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
function agentDirs(cwd: string = process.cwd()): string[] {
  return [
    path.join(getAgentDir(), "agents"),
    path.join(cwd, ".pi", "agents"),
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

export function discoverAgents(cwd: string = process.cwd()): Map<string, AgentDef> {
  const agents = new Map<string, AgentDef>();
  for (const dir of agentDirs(cwd)) {
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

/**
 * Routing hint for the `agent` parameter of the task tools. Kept here so the
 * sync and async schemas cannot drift apart, and so clauses naming an agent the
 * catalog does not contain are dropped instead of pointing at nothing.
 */
const ROUTING_CLAUSES: ReadonlyArray<{ agents: string[]; text: string }> = [
  {
    agents: ["artisan"],
    text: "substantial visual design work needing separate creative judgment to artisan",
  },
  {
    agents: ["inspector"],
    text: "live-page checks to inspector",
  },
  {
    agents: ["scribe"],
    text: "units whose deliverable is prose (docs, READMEs, changelogs, guides, copy) to scribe",
  },
  {
    agents: ["machinist"],
    text: "independent separable non-visual implementation slices to machinist",
  },
  {
    agents: ["stevedore"],
    text: "integrated lint, typecheck, test, build, git, and shipping work to stevedore",
  },
];

export function routingHint(agents: Map<string, AgentDef>): string {
  const clauses = ROUTING_CLAUSES.filter((clause) =>
    clause.agents.every((name) => agents.has(name)),
  ).map((clause) => clause.text);
  if (clauses.length === 0) return "";
  return `This parameter chooses a specialist after delegation is justified; it does not decide whether to delegate. Route ${clauses.join("; ")}. Route by the reason for delegation and deliverable, not file extension.`;
}

/** `agent` parameter description shared by the sync `task` and async `task_start` tools. */
export function agentParamDescription(agents: Map<string, AgentDef>): string {
  const hint = routingHint(agents);
  return `Agent to run. One of: ${[...agents.keys()].join(", ")}.${hint ? ` ${hint}` : ""}`;
}

/** True when an agent definition lives under the project-local `.pi/agents` tree. */
export function isProjectAgentFile(file: string, cwd: string = process.cwd()): boolean {
  const projectAgents = path.resolve(cwd, ".pi", "agents");
  const resolved = path.resolve(file);
  return (
    resolved === projectAgents ||
    resolved.startsWith(projectAgents + path.sep)
  );
}

/** Shared prompt fragments (_shared.md, _shared-sync.md, …); project overrides global. */
export function readSharedFile(name: string, cwd: string = process.cwd()): string | undefined {
  for (const dir of [...agentDirs(cwd)].reverse()) {
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8").trim();
      if (text) return text;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export type SpecialistWorkerMode = "sync" | "async";

/**
 * Mode-correct shared specialist prompt pieces.
 * Common norms (_shared.md) plus a small mode file (_shared-sync.md / _shared-async.md),
 * with optional handoff (_handoff.md). Project copies override global per file.
 */
export function composeSpecialistSharedPrompts(
  mode: SpecialistWorkerMode,
  cwd: string = process.cwd(),
): { systemPreamble?: string; appendSystemPrompt?: string } {
  const modeFile = mode === "async" ? "_shared-async.md" : "_shared-sync.md";
  const systemPreamble = [readSharedFile("_shared.md", cwd), readSharedFile(modeFile, cwd)]
    .filter((part): part is string => !!part?.trim())
    .join("\n\n");
  const appendSystemPrompt = readSharedFile("_handoff.md", cwd);
  return {
    systemPreamble: systemPreamble || undefined,
    appendSystemPrompt: appendSystemPrompt || undefined,
  };
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

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export function thinkingRank(level: string | undefined): number {
  if (!level) return -1;
  return (THINKING_LEVELS as readonly string[]).indexOf(level);
}

export function nextThinkingLevel(level: string | undefined): string | undefined {
  const rank = thinkingRank(level);
  if (rank < 0) return undefined;
  return THINKING_LEVELS[Math.min(rank + 1, THINKING_LEVELS.length - 1)];
}

/**
 * Oracle thinking must stay at least as high as its configured default, and
 * must step above the parent when the parent is at that default or higher.
 * Example: configured high + parent high -> xhigh. Never drops below configured.
 */
export function resolveOracleThinking(
  configured: string | undefined,
  parent: string | undefined,
): string | undefined {
  const configuredRank = thinkingRank(configured);
  const parentRank = thinkingRank(parent);
  if (parentRank >= 0 && parentRank >= Math.max(configuredRank, 0)) {
    return nextThinkingLevel(parent) ?? configured ?? parent;
  }
  return configured ?? parent;
}

export function resolveAgentThinking(
  def: Pick<AgentDef, "name" | "thinking">,
  parent?: string,
): string | undefined {
  return def.name === "oracle"
    ? resolveOracleThinking(def.thinking, parent)
    : def.thinking;
}

/**
 * Build ordered model attempts. New spawns omit override so the configured
 * primary plus declared fallbacks run, unless the user explicitly requested a
 * different model for that delegation. Rebind may pass the sidecar model so a
 * recovered worker resumes on the model it already landed on.
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
  // An explicit override (user-requested model or rebind recovery) replaces
  // only the primary. Declared fallbacks remain; the default primary stays
  // excluded so a recovered fallback session cannot silently return to a
  // primary that already failed.
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
