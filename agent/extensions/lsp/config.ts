import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { configSearchPaths, LANGUAGE_KEYS, type LanguageKey } from "./paths.ts";

export interface ServerCommandSpec {
  command: string;
  args: string[];
}

export interface LanguageServerConfig {
  /** When false, this language is disabled. */
  enabled?: boolean;
  /** Executable name or path. */
  command?: string;
  /** Arguments after the command. */
  args?: string[];
  /** Alternate command candidates tried in order (first resolvable wins). */
  candidates?: ServerCommandSpec[];
  /** Extra initializationOptions. */
  initializationOptions?: Record<string, unknown>;
  /** Settings returned for workspace/configuration. */
  settings?: unknown;
  /** Root markers override. */
  rootMarkers?: string[];
}

export interface LspUserConfig {
  /** Per-language overrides. Unknown keys ignored. */
  servers?: Partial<Record<LanguageKey, LanguageServerConfig>>;
  /** Global request timeout ms. */
  timeoutMs?: number;
  /** Initialize timeout ms. */
  initializeTimeoutMs?: number;
  /** Diagnostics push settle / wait ms. */
  diagnosticsWaitMs?: number;
  /**
   * Directory of the loaded config file (parent of lsp.json).
   * Explicit relative server commands (`./bin/foo`) resolve against this directory.
   * Bare names never use this directory — they search PATH only.
   */
  configDir?: string;
}

export interface ResolvedServer {
  key: LanguageKey;
  enabled: boolean;
  /** Ordered candidates; first that resolves on PATH is used. */
  candidates: ServerCommandSpec[];
  initializationOptions: Record<string, unknown>;
  settings: unknown;
  /** Root markers for project root detection (override or language defaults). */
  rootMarkers?: string[];
  missingHint: string;
}

const DEFAULTS: Record<LanguageKey, ResolvedServer> = {
  typescript: {
    key: "typescript",
    enabled: true,
    candidates: [{ command: "typescript-language-server", args: ["--stdio"] }],
    initializationOptions: {},
    settings: {},
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    missingHint:
      "Install typescript-language-server (npm i -g typescript-language-server typescript) and ensure it is on PATH.",
  },
  python: {
    key: "python",
    enabled: true,
    candidates: [{ command: "pyright-langserver", args: ["--stdio"] }],
    initializationOptions: {},
    settings: {},
    rootMarkers: [
      "pyrightconfig.json",
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "poetry.lock",
      ".git",
    ],
    missingHint:
      "Install pyright (npm i -g pyright) so pyright-langserver is on PATH.",
  },
  go: {
    key: "go",
    enabled: true,
    candidates: [{ command: "gopls", args: [] }],
    initializationOptions: {},
    settings: {},
    rootMarkers: ["go.work", "go.mod", ".git"],
    missingHint:
      "Install gopls (go install golang.org/x/tools/gopls@latest) and ensure $(go env GOPATH)/bin is on PATH.",
  },
  php: {
    key: "php",
    enabled: true,
    candidates: [
      { command: "phpactor", args: ["language-server"] },
      { command: "intelephense", args: ["--stdio"] },
    ],
    initializationOptions: {},
    settings: {},
    rootMarkers: ["composer.json", "phpactor.json", ".git"],
    missingHint:
      "Install phpactor (https://phpactor.readthedocs.io) or intelephense (npm i -g intelephense) and ensure it is on PATH.",
  },
  rust: {
    key: "rust",
    enabled: true,
    candidates: [{ command: "rust-analyzer", args: [] }],
    initializationOptions: {},
    settings: {},
    rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
    missingHint: "Install rust-analyzer and keep it on PATH.",
  },
  zig: {
    key: "zig",
    enabled: true,
    candidates: [{ command: "zls", args: [] }],
    initializationOptions: {},
    settings: {},
    rootMarkers: ["build.zig", "build.zig.zon", ".git"],
    missingHint: "Install zls and keep it on PATH.",
  },
};

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_INIT_TIMEOUT_MS = 30_000;
export const DEFAULT_DIAGNOSTICS_WAIT_MS = 2_500;

export function loadUserConfig(cwd: string): LspUserConfig {
  for (const path of configSearchPaths(cwd)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const cfg = sanitizeConfig(parsed as Record<string, unknown>);
      // Project: .../cwd/.pi/lsp.json → configDir is .../cwd/.pi
      // User:    ~/.pi/agent/lsp.json → configDir is ~/.pi/agent
      cfg.configDir = dirname(path);
      return cfg;
    } catch {
      // Missing or malformed config fails soft.
    }
  }
  return {};
}

function sanitizeConfig(obj: Record<string, unknown>): LspUserConfig {
  const out: LspUserConfig = {};
  if (typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs)) {
    out.timeoutMs = Math.max(1_000, Math.floor(obj.timeoutMs));
  }
  if (typeof obj.initializeTimeoutMs === "number" && Number.isFinite(obj.initializeTimeoutMs)) {
    out.initializeTimeoutMs = Math.max(1_000, Math.floor(obj.initializeTimeoutMs));
  }
  if (typeof obj.diagnosticsWaitMs === "number" && Number.isFinite(obj.diagnosticsWaitMs)) {
    out.diagnosticsWaitMs = Math.max(0, Math.floor(obj.diagnosticsWaitMs));
  }
  if (obj.servers && typeof obj.servers === "object" && !Array.isArray(obj.servers)) {
    const servers: LspUserConfig["servers"] = {};
    for (const key of LANGUAGE_KEYS) {
      const entry = (obj.servers as Record<string, unknown>)[key];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      servers[key] = sanitizeServer(entry as Record<string, unknown>);
    }
    out.servers = servers;
  }
  return out;
}

function sanitizeServer(entry: Record<string, unknown>): LanguageServerConfig {
  const cfg: LanguageServerConfig = {};
  if (typeof entry.enabled === "boolean") cfg.enabled = entry.enabled;
  if (typeof entry.command === "string" && entry.command.trim()) cfg.command = entry.command.trim();
  if (Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string")) {
    cfg.args = entry.args as string[];
  }
  if (Array.isArray(entry.candidates)) {
    const candidates: ServerCommandSpec[] = [];
    for (const c of entry.candidates) {
      if (!c || typeof c !== "object") continue;
      const command = (c as { command?: unknown }).command;
      const args = (c as { args?: unknown }).args;
      if (typeof command !== "string" || !command.trim()) continue;
      candidates.push({
        command: command.trim(),
        args: Array.isArray(args) && args.every((a) => typeof a === "string") ? (args as string[]) : [],
      });
    }
    if (candidates.length) cfg.candidates = candidates;
  }
  if (entry.initializationOptions && typeof entry.initializationOptions === "object") {
    cfg.initializationOptions = entry.initializationOptions as Record<string, unknown>;
  }
  if ("settings" in entry) cfg.settings = entry.settings;
  if (Array.isArray(entry.rootMarkers) && entry.rootMarkers.every((m) => typeof m === "string")) {
    cfg.rootMarkers = entry.rootMarkers as string[];
  }
  return cfg;
}

export function resolveServer(key: LanguageKey, user: LspUserConfig): ResolvedServer {
  const base = DEFAULTS[key];
  const override = user.servers?.[key];
  if (!override) {
    return {
      ...base,
      candidates: base.candidates.map((c) => ({ ...c, args: [...c.args] })),
      rootMarkers: base.rootMarkers ? [...base.rootMarkers] : undefined,
    };
  }

  const enabled = override.enabled !== false;
  let candidates = base.candidates.map((c) => ({ command: c.command, args: [...c.args] }));
  if (override.candidates?.length) {
    candidates = override.candidates.map((c) => ({ command: c.command, args: [...c.args] }));
  } else if (override.command) {
    candidates = [{ command: override.command, args: override.args ? [...override.args] : [] }];
  }

  const rootMarkers = override.rootMarkers?.length
    ? [...override.rootMarkers]
    : base.rootMarkers
      ? [...base.rootMarkers]
      : undefined;

  return {
    key,
    enabled,
    candidates,
    initializationOptions: {
      ...base.initializationOptions,
      ...override.initializationOptions,
    },
    settings: override.settings !== undefined ? override.settings : base.settings,
    rootMarkers,
    missingHint: base.missingHint,
  };
}

export function timeouts(user: LspUserConfig) {
  return {
    requestMs: user.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    initializeMs: user.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
    diagnosticsWaitMs: user.diagnosticsWaitMs ?? DEFAULT_DIAGNOSTICS_WAIT_MS,
  };
}
