import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

/** Language id and server key for a file path. */
export type LanguageKey = "typescript" | "python" | "go" | "php";

const EXT_TO_LANG: Record<string, { languageId: string; key: LanguageKey }> = {
  ".ts": { languageId: "typescript", key: "typescript" },
  ".tsx": { languageId: "typescriptreact", key: "typescript" },
  ".js": { languageId: "javascript", key: "typescript" },
  ".jsx": { languageId: "javascriptreact", key: "typescript" },
  ".mjs": { languageId: "javascript", key: "typescript" },
  ".cjs": { languageId: "javascript", key: "typescript" },
  ".mts": { languageId: "typescript", key: "typescript" },
  ".cts": { languageId: "typescript", key: "typescript" },
  ".py": { languageId: "python", key: "python" },
  ".pyi": { languageId: "python", key: "python" },
  ".go": { languageId: "go", key: "go" },
  ".php": { languageId: "php", key: "php" },
};

const ROOT_MARKERS: Record<LanguageKey, string[]> = {
  typescript: [
    "tsconfig.json",
    "jsconfig.json",
    "package.json",
    ".git",
  ],
  python: [
    "pyrightconfig.json",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "poetry.lock",
    ".git",
  ],
  go: ["go.work", "go.mod", ".git"],
  php: ["composer.json", "phpactor.json", ".git"],
};

export function languageForPath(filePath: string): { languageId: string; key: LanguageKey } | undefined {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext];
}

export function resolvePath(filePath: string, cwd: string): string {
  const raw = filePath.trim();
  if (!raw) return resolve(cwd);
  return isAbsolute(raw) ? normalize(raw) : resolve(cwd, raw);
}

/**
 * Walk up from fileDir toward stopDir (inclusive) looking for markers.
 * Prefers the nearest marker that is not only `.git` when a language marker exists.
 * Never walks above stopDir or the filesystem root.
 */
export function detectRoot(
  filePath: string,
  cwd: string,
  languageKey?: LanguageKey,
  rootMarkers?: string[],
): string {
  const absolute = resolvePath(filePath, cwd);
  let startDir: string;
  try {
    startDir = statSync(absolute).isDirectory() ? absolute : dirname(absolute);
  } catch {
    startDir = dirname(absolute);
  }

  const stop = normalize(cwd);
  const key = languageKey ?? languageForPath(absolute)?.key;
  const markers =
    rootMarkers?.length
      ? rootMarkers
      : key
        ? ROOT_MARKERS[key]
        : [".git", "package.json", "go.mod", "pyproject.toml", "composer.json"];

  let dir = startDir;
  let fallbackGit: string | undefined;
  let best: string | undefined;

  for (;;) {
    for (const marker of markers) {
      const candidate = join(dir, marker);
      if (!existsSync(candidate)) continue;
      if (marker === ".git") {
        fallbackGit ??= dir;
        continue;
      }
      // Prefer nearest non-git marker.
      best = dir;
      return best;
    }
    if (pathsEqual(dir, stop) || isFsRoot(dir)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    // Do not walk above stop (ctx.cwd).
    if (!isWithinOrEqual(parent, stop) && !pathsEqual(parent, stop)) break;
    dir = parent;
  }

  return best ?? fallbackGit ?? stop;
}

function isFsRoot(dir: string): boolean {
  const n = normalize(dir);
  return n === dirname(n);
}

function pathsEqual(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (process.platform === "win32") return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

function isWithinOrEqual(path: string, root: string): boolean {
  const nPath = normalize(path);
  const nRoot = normalize(root);
  if (pathsEqual(nPath, nRoot)) return true;
  const prefix = nRoot.endsWith(sep) ? nRoot : nRoot + sep;
  if (process.platform === "win32") {
    return nPath.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return nPath.startsWith(prefix);
}

/** File URI with normalized Windows drive casing (uppercase). */
export function pathToUri(filePath: string): string {
  const absolute = resolve(filePath);
  const url = pathToFileURL(absolute);
  // pathToFileURL already uppercases drive letters on recent Node; normalize anyway.
  return url.href.replace(/^file:\/\/\/([a-z]):/i, (_, d: string) => `file:///${d.toUpperCase()}:`);
}

export function uriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return uri;
    let p = decodeURIComponent(url.pathname);
    // Windows: /C:/...
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    if (process.platform === "win32") p = p.replace(/\//g, "\\");
    return normalize(p);
  } catch {
    return uri;
  }
}

export function formatLocation(filePath: string, line1: number, column1: number): string {
  return `${filePath}:${line1}:${column1}`;
}

export function configSearchPaths(cwd: string): string[] {
  const home = homedir();
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
    || (process.env.XDG_CONFIG_HOME?.trim()
      ? join(process.env.XDG_CONFIG_HOME, "pi", "agent")
      : join(home, ".pi", "agent"));
  return [
    join(cwd, ".pi", "lsp.json"),
    join(agentDir, "lsp.json"),
  ];
}
