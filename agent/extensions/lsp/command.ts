import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, normalize, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { killWindowsProcessTree as killSharedWindowsProcessTree } from "./internal/process-tree-kill.ts";

export interface SpawnCommand {
  command: string;
  args: string[];
  shell: boolean;
  /** When true, pass args to CreateProcess without Node re-quoting (required for cmd /S). */
  windowsVerbatimArguments?: boolean;
}

const DEFAULT_WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Windows executable extensions from PATHEXT (or defaults), with leading dots.
 * Bare (extensionless) names are never preferred over these.
 */
export function windowsExecutableExtensions(
  pathExtEnv: string = process.env.PATHEXT ?? DEFAULT_WIN_PATHEXT,
): string[] {
  const parts = pathExtEnv
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith(".") ? part : `.${part}`));
  return parts.length ? parts : DEFAULT_WIN_PATHEXT.split(";");
}

function tryFile(file: string): string | undefined {
  try {
    if (existsSync(file) && statSync(file).isFile()) return file;
  } catch {
    /* ignore */
  }
  return undefined;
}

function candidatesForBase(
  base: string,
  platform: NodeJS.Platform,
  pathExtEnv: string,
): string[] {
  if (platform !== "win32") return [base];
  if (/\.(exe|cmd|bat|com)$/i.test(base)) return [base];
  const exts = windowsExecutableExtensions(pathExtEnv);
  // PATHEXT order first; bare shim last (npm globals ship both).
  return [...exts.map((ext) => `${base}${ext}`), base];
}

/** True when command is an explicit filesystem path (absolute or ./ / ../ relative). */
export function isExplicitCommandPath(command: string): boolean {
  const raw = command.trim();
  if (!raw) return false;
  if (isAbsolute(raw)) return true;
  // Relative path forms only — bare names like "gopls" are PATH lookups.
  if (raw.startsWith("./") || raw.startsWith(".\\") || raw.startsWith("../") || raw.startsWith("..\\")) {
    return true;
  }
  // Drive-relative Windows path (C:foo) is rare; treat as explicit if it has a separator.
  if (raw.includes("/") || raw.includes("\\")) return true;
  return false;
}

/**
 * Resolve an executable.
 *
 * Security:
 * - Bare names (e.g. `gopls`) search PATH only — never the process cwd or project root.
 * - Explicit absolute paths, or relative paths starting with `./` / `../` (or containing a
 *   path separator), resolve against `baseDir` when provided (config file directory),
 *   otherwise against `process.cwd()`. Relative resolution is only for trusted config.
 *
 * On Windows, PATHEXT extensions are tried before a bare (extensionless) shim.
 */
export function resolveCommandPath(
  command: string,
  /**
   * @deprecated Ignored for bare names (PATH-only). Kept optional for call-site compatibility.
   * Use `baseDir` for explicit relative paths.
   */
  _cwd?: string,
  platform: NodeJS.Platform = process.platform,
  pathEnv: string = process.env.PATH ?? process.env.Path ?? "",
  pathExtEnv: string = process.env.PATHEXT ?? DEFAULT_WIN_PATHEXT,
  /** Directory used to resolve explicit relative command paths (config file dir). */
  baseDir?: string,
): string | undefined {
  const raw = command.trim();
  if (!raw) return undefined;

  if (isExplicitCommandPath(raw)) {
    const absolute = isAbsolute(raw)
      ? normalize(raw)
      : resolve(baseDir ?? process.cwd(), raw);
    for (const candidate of candidatesForBase(absolute, platform, pathExtEnv)) {
      const hit = tryFile(candidate);
      if (hit) return hit;
    }
    return undefined;
  }

  // Bare name: PATH only (never cwd).
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidatesForBase(join(dir, raw), platform, pathExtEnv)) {
      const hit = tryFile(candidate);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * cmd.exe cannot reliably preserve literal `%` (env expansion) or embedded `"`
 * through /S /C quoting. Reject before spawn with an actionable error rather than
 * silently corrupting tokens.
 */
export function assertCmdSafeToken(value: string, label: string): void {
  if (value.includes("%") || value.includes('"')) {
    throw new Error(
      `Windows .cmd/.bat ${label} cannot contain % or " ` +
        `(cmd.exe cannot preserve them reliably through /d /s /c). ` +
        `Got: ${JSON.stringify(value)}. Use a path/args without those characters, or an .exe language server.`,
    );
  }
}

/**
 * Quote one argument for cmd.exe /S /C when tokens are free of % and ".
 * - Rejects % and " (see assertCmdSafeToken)
 * - Wraps in double quotes (spaces safe)
 * - Caret-escapes cmd metacharacters (& | < > ^ ! ( ))
 */
export function quoteCmdArg(value: string): string {
  assertCmdSafeToken(value, "argument");
  const escaped = String(value).replace(/([()!^&|<>])/g, "^$1");
  return `"${escaped}"`;
}

/**
 * Build the single /c payload for `cmd.exe /d /s /c`.
 * Outer quotes are required so CreateProcess + cmd /S hand the line off correctly
 * when the script path contains spaces. Command path and args must not contain % or ".
 */
export function buildCmdExeCLine(command: string, args: string[]): string {
  assertCmdSafeToken(command, "command path");
  for (const arg of args) assertCmdSafeToken(arg, "argument");
  const inner = [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
  return `"${inner}"`;
}

/**
 * Windows .cmd/.bat must be launched via cmd.exe /d /s /c with a carefully quoted line.
 * Supports spaces and metacharacters & | < > ^ ! ( ) in tokens; rejects % and ".
 * Requires spawn({ windowsVerbatimArguments: true }).
 */
export function resolveSpawnCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
): SpawnCommand {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: comSpec?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdExeCLine(command, args)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
  return { command, args, shell: false };
}

export function firstResolvable(
  candidates: Array<{ command: string; args: string[] }>,
  /**
   * Base directory for explicit relative command paths from config.
   * Bare names never search this directory.
   */
  baseDir?: string,
): { command: string; args: string[]; resolved: string } | undefined {
  for (const c of candidates) {
    const resolved = resolveCommandPath(
      c.command,
      undefined,
      process.platform,
      process.env.PATH ?? process.env.Path ?? "",
      process.env.PATHEXT ?? DEFAULT_WIN_PATHEXT,
      baseDir,
    );
    if (resolved) return { command: c.command, args: c.args, resolved };
  }
  return undefined;
}

/** True when the resolved command must be wrapped in cmd.exe (tree-kill on shutdown). */
export function isWindowsCmdScript(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/**
 * LSP compatibility adapter over the shared ProcessTree module. The injected
 * spawn seam remains for command-resolution tests.
 */
export function killWindowsProcessTree(
  pid: number,
  spawnImpl: typeof spawn = spawn,
): Promise<void> {
  return killSharedWindowsProcessTree(pid, { spawnImpl });
}
