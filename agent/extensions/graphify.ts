/**
 * Opt-in local Graphify integration: one LLM tool + /graphify handoff.
 * Safe/inert when project artifacts are absent. No file mutation, no shell strings.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export const GRAPHIFY_TOOL_NAME = "graphify";
export const GRAPHIFY_STATUS_KEY = "graphify";
export const DEFAULT_EXECUTABLE = "graphify";
export const DEFAULT_OUTPUT_DIR = "graphify-out";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 180_000;
export const DEFAULT_BUDGET = 2000;
export const MIN_BUDGET = 1;
export const MAX_BUDGET = 50_000;
export const OUTPUT_CAP_CHARS = 12_288;
export const TRUNCATION_MARKER = "\n...[truncated]";
const SYSTEM_BLOCK_MAX_LINES = 10;

function textResult(text: string, isError = false, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

export type GraphifyOperation = "query" | "path" | "explain";
export type GraphifyQueryMode = "bfs" | "dfs";
export type GraphifyQueryScope =
  | "all"
  | "runtime"
  | "config"
  | "tests"
  | "docs"
  | "reference";
export const QUERY_SCOPES = ["all", "runtime", "config", "tests", "docs", "reference"] as const;

export type GraphifyConfig = {
  enabled: boolean;
  executable: string;
  outputDir: string;
  timeoutMs: number;
  configDir: string | null;
  configPath: string | null;
};

export type GraphifyArtifacts = {
  outputDir: string;
  exists: boolean;
  wiki: string | null;
  report: string | null;
  graph: string | null;
  needsUpdate: boolean;
  needsUpdatePath: string;
};

const OPERATIONS = ["query", "path", "explain"] as const;

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

export function clampBudget(value: unknown, fallback = DEFAULT_BUDGET): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, n));
}

export function clampTimeoutMs(value: unknown, fallback = DEFAULT_TIMEOUT_MS): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, n));
}

/** True when resolvedPath is inside projectCwd (Windows-safe). */
export function isPathInside(projectCwd: string, resolvedPath: string): boolean {
  const root = resolve(projectCwd);
  const target = resolve(resolvedPath);
  if (root === target) return true;
  const rel = relative(root, target);
  if (!rel || rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false; // different drive on Windows
  return true;
}

export function resolveOutputDir(projectCwd: string, configured: string): string | null {
  const raw = configured.trim() || DEFAULT_OUTPUT_DIR;
  const resolved = isAbsolute(raw) ? normalize(raw) : resolve(projectCwd, raw);
  if (!isPathInside(projectCwd, resolved)) return null;
  return resolved;
}

export function isBareExecutable(name: string): boolean {
  const raw = name.trim();
  if (!raw) return true;
  if (isAbsolute(raw)) return false;
  if (raw.includes("/") || raw.includes("\\")) return false;
  return true;
}

/**
 * Bare names stay bare (PATH lookup).
 * Relative paths resolve against configDir (else projectCwd).
 * Absolute/relative paths are accepted only if the resolved file stays inside projectCwd.
 */
export function resolveExecutable(
  configured: string,
  configDir: string | null,
  projectCwd: string,
): string | null {
  const raw = configured.trim() || DEFAULT_EXECUTABLE;
  if (isBareExecutable(raw)) return raw;
  const resolved = isAbsolute(raw) ? normalize(raw) : resolve(configDir ?? projectCwd, raw);
  if (!isPathInside(projectCwd, resolved)) return null;
  return resolved;
}

export function graphFileMtimeMs(graphPath: string | null | undefined): number | null {
  if (!graphPath) return null;
  try {
    return statSync(graphPath).mtimeMs;
  } catch {
    return null;
  }
}

export function loadGraphifyConfig(projectCwd: string): GraphifyConfig {
  const defaults: GraphifyConfig = {
    enabled: true,
    executable: DEFAULT_EXECUTABLE,
    outputDir: DEFAULT_OUTPUT_DIR,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    configDir: null,
    configPath: null,
  };
  const configPath = join(projectCwd, ".pi", "graphify.json");
  if (!existsSync(configPath)) return defaults;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const obj = parsed as Record<string, unknown>;
    const enabled = typeof obj.enabled === "boolean" ? obj.enabled : true;
    const executable =
      typeof obj.executable === "string" && obj.executable.trim()
        ? obj.executable.trim()
        : DEFAULT_EXECUTABLE;
    const outputDir =
      typeof obj.outputDir === "string" && obj.outputDir.trim()
        ? obj.outputDir.trim()
        : DEFAULT_OUTPUT_DIR;
    const timeoutMs = clampTimeoutMs(obj.timeoutMs);
    return {
      enabled,
      executable,
      outputDir,
      timeoutMs,
      configDir: dirname(configPath),
      configPath,
    };
  } catch {
    return defaults;
  }
}

export function detectArtifacts(projectCwd: string, outputDirName: string): GraphifyArtifacts | null {
  const outputDir = resolveOutputDir(projectCwd, outputDirName);
  if (!outputDir) return null;
  const wikiPath = join(outputDir, "wiki", "index.md");
  const reportPath = join(outputDir, "GRAPH_REPORT.md");
  const graphPath = join(outputDir, "graph.json");
  const needsUpdatePath = join(outputDir, "needs_update");
  const wiki = existsSync(wikiPath) ? wikiPath : null;
  const report = existsSync(reportPath) ? reportPath : null;
  const graph = existsSync(graphPath) ? graphPath : null;
  return {
    outputDir,
    exists: Boolean(wiki || report || graph),
    wiki,
    report,
    graph,
    needsUpdate: existsSync(needsUpdatePath),
    needsUpdatePath,
  };
}

/** Project-relative forward-slash path for prompts; filesystem stays absolute. */
export function toProjectRelPath(projectCwd: string, absPath: string): string {
  const rel = relative(resolve(projectCwd), resolve(absPath));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return absPath.replace(/\\/g, "/");
  }
  return rel.split(sep).join("/");
}

export function buildGraphifyArgv(args: {
  operation: GraphifyOperation;
  question?: string;
  mode?: GraphifyQueryMode;
  budget?: number;
  from?: string;
  to?: string;
  concept?: string;
  scope?: GraphifyQueryScope;
  graphPath?: string;
}): string[] {
  const graphPair =
    typeof args.graphPath === "string" && args.graphPath.trim()
      ? ["--graph", args.graphPath]
      : [];
  if (args.operation === "query") {
    const argv = ["query", args.question ?? "", ...graphPair];
    if (args.mode === "dfs") argv.push("--dfs");
    argv.push("--budget", String(clampBudget(args.budget)));
    if (args.scope && (QUERY_SCOPES as readonly string[]).includes(args.scope)) {
      argv.push("--scope", args.scope);
    }
    return argv;
  }
  if (args.operation === "path") {
    return ["path", args.from ?? "", args.to ?? "", ...graphPair];
  }
  return ["explain", args.concept ?? "", ...graphPair];
}

export function boundModelOutput(stdout: string, stderr: string, cap = OUTPUT_CAP_CHARS): string {
  const parts = [stdout ?? "", stderr ?? ""].filter((p) => p.length > 0);
  const combined = parts.join(parts.length === 2 ? "\n" : "");
  if (combined.length <= cap) return combined;
  const keep = Math.max(0, cap - TRUNCATION_MARKER.length);
  return `${combined.slice(0, keep)}${TRUNCATION_MARKER}`;
}

export function isLikelyCodePath(filePath: string, outputDir: string): boolean {
  const resolved = resolve(filePath);
  if (isPathInside(outputDir, resolved)) return false;
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)(\.git|node_modules|\.pi)(\/|$)/.test(normalized)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|php|rb|c|cc|cpp|h|hpp|swift|sql|vue|svelte)$/i.test(
    normalized,
  );
}

/** Graphify 0.9.44 non-rebuild / read / management first tokens. Unknown first args are treated as direct paths (ambiguous with a future subcommand). */
const GRAPHIFY_NON_REBUILD_SUBCOMMANDS = new Set([
  "install",
  "uninstall",
  "path",
  "explain",
  "diagnose",
  "clone",
  "merge-driver",
  "merge-graphs",
  "add",
  "watch",
  "label",
  "query",
  "affected",
  "god-nodes",
  "save-result",
  "reflect",
  "check-update",
  "tree",
  "hook",
  "serve",
  "export",
  "upgrade",
  "help",
  "version",
]);
const GRAPHIFY_REBUILD_SUBCOMMANDS = new Set(["update", "extract", "cluster-only", "build"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Quote-aware whitespace tokenizer. Not a shell parser: no escapes, no $(), no
 * operators, no comment stripping. Conservative: only `'` / `"` pairing.
 */
export function parseGraphifyCommandTokens(command: string): string[] {
  const text = (command ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function firstInvocationIndex(tokens: string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    if (ENV_ASSIGN.test(tokens[i]!)) continue;
    return i;
  }
  return -1;
}

/**
 * True only when the first actual invocation token is `graphify` / `graphify.exe`
 * (quotes already stripped). Optional leading `KEY=value` env assignments are skipped.
 * Rebuild forms: `graphify .|src|./src|C:/repo` (unknown first args = direct paths),
 * or `graphify update|extract|cluster-only|build …`. Known 0.9.44 non-rebuild
 * subcommands and -h/-v/--help/--version are false. First token must be graphify.
 */
export function isGraphifyUpdateCommand(command: string): boolean {
  const tokens = parseGraphifyCommandTokens(command);
  const idx = firstInvocationIndex(tokens);
  if (idx < 0) return false;
  const exe = tokens[idx]!;
  if (!/^graphify(?:\.exe)?$/i.test(exe)) return false;
  const rest = tokens.slice(idx + 1).filter((t) => t && t !== "--");
  if (rest.length === 0) return false;
  const first = rest[0]!;
  if (first.startsWith("-")) {
    const flag = first.toLowerCase();
    if (flag === "-v" || flag === "--version" || flag === "-h" || flag === "--help") return false;
    return false;
  }
  const sub = first.toLowerCase();
  if (GRAPHIFY_NON_REBUILD_SUBCOMMANDS.has(sub)) return false;
  if (GRAPHIFY_REBUILD_SUBCOMMANDS.has(sub)) return true;
  // Unknown first argument: treat as a direct path (`.` / `src` / `C:/repo`).
  return true;
}

function handOff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
    return;
  }
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  notify(ctx, "Agent is busy; queued as follow-up.", "info");
}

export function graphifyHandoffInstruction(userArgs: string): string {
  const raw = userArgs.trim();
  const tokens = raw ? raw.split(/\s+/) : [];
  const first = (tokens[0] ?? "").toLowerCase();
  let execHint: string;
  if (!raw || first === "build") {
    const pathArg = first === "build" ? tokens.slice(1).join(" ") : raw;
    const target = pathArg.trim() || ".";
    execHint = [
      `Load and follow the local skill agent/skills/graphify/SKILL.md for the full Graphify build of ${target}.`,
      "`/graphify build [path]` means that skill build for the path — never execute the CLI as `graphify build`.",
      "Upstream CLI rebuilds are `graphify <path>` (or `.`), not `graphify build`.",
      "When no GEMINI_API_KEY/GOOGLE_API_KEY is already set, use serialized harness `machinist` workers (`task` or `task_start` + `task_close`) for semantic chunks — one distinct chunk per worker, same worktree, never scout (read-only).",
      "Do not ask for an API key. Do not fall back to `graphify . --code-only` merely because no key exists.",
    ].join(" ");
  } else if (first === "update") {
    const target = tokens.slice(1).join(" ").trim() || ".";
    execHint = [
      `Load and follow the local skill agent/skills/graphify/SKILL.md incremental/update flow for ${target} (see that skill's --update section and references/update.md).`,
      "Do not treat a raw shell `graphify update` as the complete operation — that CLI updates code/structure only and skips agent semantic extraction for docs/papers/images.",
      "When no GEMINI_API_KEY/GOOGLE_API_KEY is already set, use serialized harness `machinist` workers (`task` or `task_start` + `task_close`) for semantic chunks — one distinct chunk per worker, same worktree, never scout (read-only).",
      "Do not ask for an API key. Do not fall back to `graphify . --code-only` merely because no key exists.",
    ].join(" ");
  } else if (first === "query" || first === "path" || first === "explain") {
    execHint = "Use the graphify tool for query, path, and explain — never shell those operations.";
  } else {
    const target = raw || ".";
    execHint = [
      `Load and follow the local skill agent/skills/graphify/SKILL.md for the full Graphify build of ${target}.`,
      "Never execute the CLI as `graphify build`.",
      "When no GEMINI_API_KEY/GOOGLE_API_KEY is already set, use serialized harness `machinist` workers (`task` or `task_start` + `task_close`) for semantic chunks — one distinct chunk per worker, same worktree, never scout (read-only).",
      "Do not ask for an API key. Do not fall back to `graphify . --code-only` merely because no key exists.",
      "For query/path/explain use the graphify tool.",
    ].join(" ");
  }
  const invoked = raw || "build";
  return [
    `The user invoked /graphify ${invoked}.`,
    execHint,
    "Do not invent a Windows-only shell string.",
    "Do not mutate files except via the user's requested Graphify maintenance.",
  ].join(" ");
}

export function buildSystemBlock(
  artifacts: GraphifyArtifacts,
  sessionStale: boolean,
  projectCwd?: string,
): string {
  const root = projectCwd ?? join(artifacts.outputDir, "..");
  const lines: string[] = ["## Graphify"];
  if (artifacts.wiki) lines.push(`Wiki: ${toProjectRelPath(root, artifacts.wiki)}`);
  if (artifacts.report) lines.push(`Report: ${toProjectRelPath(root, artifacts.report)}`);
  if (artifacts.graph) lines.push(`Graph: ${toProjectRelPath(root, artifacts.graph)}`);
  lines.push("Prefer graphify query/path/explain, then confirm in targeted source.");
  if (artifacts.needsUpdate || sessionStale) {
    lines.push(
      "Graph may be stale (needs_update or in-session code edits). Rebuild with /graphify (alias `/graphify build` translates to upstream `graphify .`, not `graphify build`).",
    );
  }
  return lines.slice(0, SYSTEM_BLOCK_MAX_LINES).join("\n");
}

export function graphifyStatusText(
  artifacts: GraphifyArtifacts | null,
  enabled: boolean,
  sessionStale = false,
): string | undefined {
  if (!enabled || !artifacts?.exists) return undefined;
  if (artifacts.needsUpdate || sessionStale) return "graphify stale";
  return undefined;
}

function isCommandNotFound(error: unknown, stderr: string): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  const blob = `${msg}\n${stderr}`.toLowerCase();
  return (
    blob.includes("enoent") ||
    blob.includes("not found") ||
    blob.includes("is not recognized") ||
    blob.includes("cannot find")
  );
}

function collectPathsFromToolInput(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const keys = ["path", "file", "filePath", "target"];
  const out: string[] = [];
  for (const key of keys) {
    if (typeof obj[key] === "string") out.push(obj[key] as string);
  }
  if (Array.isArray(obj.paths)) {
    for (const p of obj.paths) if (typeof p === "string") out.push(p);
  }
  return out;
}

export default function graphifyExtension(pi: ExtensionAPI): void {
  let sessionStale = false;
  let remindedThisTurn = false;
  let staleGraphMtime: number | null = null;

  const refresh = (cwd: string) => {
    const config = loadGraphifyConfig(cwd);
    const artifacts = config.enabled ? detectArtifacts(cwd, config.outputDir) : null;
    return { config, artifacts };
  };

  pi.registerCommand("graphify", {
    description: "Handoff Graphify build/query instructions to the agent.",
    handler: async (args, ctx) => {
      handOff(pi, ctx, graphifyHandoffInstruction(args ?? ""));
    },
  });

  pi.registerTool({
    name: GRAPHIFY_TOOL_NAME,
    label: "Graphify",
    description: [
      "Read a project Graphify knowledge graph (query, path, explain).",
      "Requires graph artifacts in the configured outputDir (default graphify-out).",
      "If graph.json is missing, tell the user to run /graphify (or /graphify build), which translates to upstream `graphify .` — never `graphify build`.",
      "query: question (required), optional mode bfs|dfs, optional budget (default 2000), optional scope all|runtime|config|tests|docs|reference (architecture default is runtime+config; use all to include tests/docs/reference).",
      "path: from and to node ids/names.",
      "explain: concept.",
      "Does not build or mutate the graph.",
    ].join(" "),
    parameters: Type.Object({
      operation: Type.Union(OPERATIONS.map((value) => Type.Literal(value)), {
        description: "query | path | explain",
      }),
      question: Type.Optional(Type.String({ description: "Required for query." })),
      mode: Type.Optional(
        Type.Union([Type.Literal("bfs"), Type.Literal("dfs")], {
          description: "Traversal mode for query (default bfs).",
        }),
      ),
      budget: Type.Optional(Type.Number({ description: "Query budget (default 2000)." })),
      scope: Type.Optional(
        Type.Union(QUERY_SCOPES.map((value) => Type.Literal(value)), {
          description:
            "Query corpus scope. Architecture default is runtime+config. Use all to include tests, docs, and reference.",
        }),
      ),
      from: Type.Optional(Type.String({ description: "Required for path." })),
      to: Type.Optional(Type.String({ description: "Required for path." })),
      concept: Type.Optional(Type.String({ description: "Required for explain." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      const { config, artifacts } = refresh(cwd);
      if (!config.enabled) {
        return textResult("Graphify is disabled in .pi/graphify.json.", true);
      }
      const outputDir = resolveOutputDir(cwd, config.outputDir);
      if (!outputDir) {
        return textResult(
          "Configured outputDir is outside the project directory and was rejected.",
          true,
        );
      }
      if (!artifacts?.exists) {
        return textResult(
          "No Graphify artifacts found. Ask the user to run /graphify (or /graphify build, which translates to upstream `graphify .`).",
          true,
        );
      }
      if (!artifacts.graph) {
        return textResult(
          "graph.json is missing. Rebuild with /graphify (or /graphify build, which translates to upstream `graphify .`).",
          true,
        );
      }

      const operation = params.operation as GraphifyOperation;
      if (operation === "query" && !String(params.question ?? "").trim()) {
        return textResult("query requires question.", true);
      }
      if (operation === "path" && (!String(params.from ?? "").trim() || !String(params.to ?? "").trim())) {
        return textResult("path requires from and to.", true);
      }
      if (operation === "explain" && !String(params.concept ?? "").trim()) {
        return textResult("explain requires concept.", true);
      }

      const executable = resolveExecutable(config.executable, config.configDir, cwd);
      if (!executable) {
        return textResult(
          "Configured executable resolves outside the project directory and was rejected.",
          true,
        );
      }
      const argv = buildGraphifyArgv({
        operation,
        question: params.question,
        mode: params.mode as GraphifyQueryMode | undefined,
        budget: params.budget,
        from: params.from,
        to: params.to,
        concept: params.concept,
        scope: params.scope as GraphifyQueryScope | undefined,
        graphPath: artifacts.graph,
      });

      try {
        const result = await pi.exec(executable, argv, {
          cwd,
          signal,
          timeout: config.timeoutMs,
        });
        const text = boundModelOutput(result.stdout ?? "", result.stderr ?? "");
        const failed = result.code !== 0;
        return textResult(
          text || (failed ? `graphify exited ${result.code}` : "(no output)"),
          failed,
          { code: result.code, killed: result.killed },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isCommandNotFound(error, "")) {
          return textResult(
            `graphify executable not found (${executable}). Install Graphify and keep a bare name on PATH, or set executable in .pi/graphify.json.`,
            true,
          );
        }
        return textResult(`graphify failed: ${message}`, true);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionStale = false;
    staleGraphMtime = null;
    const { config, artifacts } = refresh(ctx.cwd);
    try {
      ctx.ui.setStatus(GRAPHIFY_STATUS_KEY, graphifyStatusText(artifacts, config.enabled, sessionStale));
    } catch {}
  });

  pi.on("turn_start", async () => {
    remindedThisTurn = false;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (process.env.PI_SUBAGENT === "1") return;
    const cwd = ctx.cwd;
    if (!cwd) return;
    const { config, artifacts } = refresh(cwd);
    if (!config.enabled || !artifacts?.exists) return;
    const block = buildSystemBlock(artifacts, sessionStale, cwd);
    const ev = event as { systemPrompt?: string };
    if (typeof ev.systemPrompt === "string") {
      ev.systemPrompt = `${ev.systemPrompt}\n\n${block}`;
    }
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    try {
      if (event.isError) return;
      const cwd = ctx.cwd;
      if (!cwd) return;
      const { config, artifacts } = refresh(cwd);
      if (!config.enabled || !artifacts) return;
      const outputDir = artifacts.outputDir;
      const name = (event.toolName ?? "").toLowerCase();
      const existing = Array.isArray(event.content) ? event.content : [];

      if (name === "edit" || name === "write") {
        const paths = collectPathsFromToolInput(event.input);
        const marked = paths.some((p) => isLikelyCodePath(resolve(cwd, p), outputDir));
        if (marked) {
          sessionStale = true;
          staleGraphMtime = graphFileMtimeMs(artifacts.graph);
          try {
            ctx.ui.setStatus(
              GRAPHIFY_STATUS_KEY,
              graphifyStatusText(artifacts, true, sessionStale),
            );
          } catch {}
          if (!remindedThisTurn) {
            remindedThisTurn = true;
            const reminder =
              "[graphify] Code changed; graph may be stale. Rebuild with /graphify (runs `graphify .`).";
            // Host merge: ToolResultEventResult.content replaces the result (runner.js emitToolResult).
            return {
              content: [
                ...existing,
                { type: "text" as const, text: reminder },
              ],
            };
          }
        }
        return;
      }

      if (name === "bash" || name === "powershell") {
        const input = event.input as { command?: string } | undefined;
        const command = typeof input?.command === "string" ? input.command : "";
        if (isGraphifyUpdateCommand(command)) {
          const latest = detectArtifacts(cwd, config.outputDir);
          const nextMtime = graphFileMtimeMs(latest?.graph);
          // Clear only when graph.json exists and mtime advanced (or appeared).
          // Equal mtime = treat as unchanged; needs_update stays authoritative.
          const advanced =
            latest?.graph != null &&
            nextMtime != null &&
            (staleGraphMtime == null || nextMtime > staleGraphMtime);
          if (advanced) {
            sessionStale = false;
            staleGraphMtime = null;
          }
          if (latest) {
            try {
              ctx.ui.setStatus(
                GRAPHIFY_STATUS_KEY,
                graphifyStatusText(latest, true, sessionStale),
              );
            } catch {}
          }
        }
      }
    } catch {
      // ignore hook errors
    }
  });
}
