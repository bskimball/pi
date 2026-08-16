// First-class PowerShell tool: runs a direct PowerShell/pwsh child process,
// independent of the host shell (bash, cmd, or otherwise).
//
// Results are bounded plain text and use Pi's stock tool renderer.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { killProcessTree } from "./powershell/internal/process-tree-kill.ts";

type PowerShellArgs = { command?: string; timeout?: number };

/**
 * One-line command summary for the receipt header. Multi-line scripts collapse
 * to their first statement plus a line count, never the whole body.
 */
export function formatPowerShellCommand(
  command: unknown,
  budget = 120,
): string {
  const max = Math.max(0, Math.floor(budget));
  if (max === 0) return "";
  const lines = String(command ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (!lines.length) return "";
  const extra = lines.length - 1;
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const truncate = (value: string) =>
    value.length <= max ? value : value.slice(0, max);
  if (extra <= 0) return truncate(clean(lines[0]));
  const suffix = ` +${extra} ${extra === 1 ? "line" : "lines"}`;
  const head = clean(lines[0]).slice(0, Math.max(0, max - suffix.length));
  return truncate(`${head}${suffix}`);
}

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const PROBE_COMMAND = "$PSVersionTable.PSVersion.Major";
const PROBE_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  PROBE_COMMAND,
] as const;

type TruncationResult = {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.slice(start).toString("utf-8");
}

/** Keep the last N lines/bytes (command-output style). */
function truncateTail(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;

  for (
    let i = lines.length - 1;
    i >= 0 && outputLinesArr.length < maxLines;
    i--
  ) {
    const line = lines[i]!;
    const lineBytes =
      Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (outputLinesArr.length === 0) {
        const partial = truncateStringToBytesFromEnd(line, maxBytes);
        outputLinesArr.unshift(partial);
        outputBytesCount = Buffer.byteLength(partial, "utf-8");
        lastLinePartial = true;
      }
      break;
    }
    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: Buffer.byteLength(outputContent, "utf-8"),
    lastLinePartial,
  };
}

/**
 * Bounded in-memory tail of streamed output: enough for final
 * 2000-line / 50KB truncation, with accurate total line/byte counts.
 */
class OutputTail {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly decoder = new StringDecoder("utf8");
  private partial = "";
  private lines: string[] = [];
  private tailBytes = 0;
  totalLines = 0;
  totalBytes = 0;

  constructor(
    maxLines: number = DEFAULT_MAX_LINES,
    maxBytes: number = DEFAULT_MAX_BYTES,
  ) {
    this.maxLines = maxLines;
    // Keep a little headroom so a single oversize final line can still be
    // byte-truncated from the end by truncateTail.
    this.maxBytes = maxBytes;
  }

  private lineBytes(line: string, withSeparator: boolean): number {
    return Buffer.byteLength(line, "utf-8") + (withSeparator ? 1 : 0);
  }

  private pushCompleteLine(line: string): void {
    this.totalLines++;
    this.lines.push(line);
    this.tailBytes += this.lineBytes(line, this.lines.length > 1);
    this.trim();
  }

  private trim(): void {
    while (this.lines.length > this.maxLines) {
      this.dropFront();
    }
    while (this.lines.length > 1 && this.tailBytes > this.maxBytes) {
      this.dropFront();
    }
    // One remaining line may still exceed maxBytes; keep only its tail bytes.
    if (this.lines.length === 1 && this.tailBytes > this.maxBytes) {
      const only = this.lines[0]!;
      const trimmed = truncateStringToBytesFromEnd(only, this.maxBytes);
      this.lines[0] = trimmed;
      this.tailBytes = Buffer.byteLength(trimmed, "utf-8");
    }
  }

  private dropFront(): void {
    if (this.lines.length === 0) return;
    this.lines.shift();
    if (this.lines.length === 0) {
      this.tailBytes = 0;
      return;
    }
    // Recompute: first line has no leading separator in join accounting.
    this.tailBytes = 0;
    for (let i = 0; i < this.lines.length; i++) {
      this.tailBytes += this.lineBytes(this.lines[i]!, i > 0);
    }
  }

  /** Ingest a raw stdout/stderr chunk (bytes). */
  write(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    const text = this.decoder
      .write(chunk)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    this.partial += text;
    let idx: number;
    while ((idx = this.partial.indexOf("\n")) !== -1) {
      const line = this.partial.slice(0, idx);
      this.partial = this.partial.slice(idx + 1);
      this.pushCompleteLine(line);
    }
  }

  /** Flush decoder / trailing partial line at stream end. */
  end(): void {
    const rest = this.decoder
      .end()
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    this.partial += rest;
    if (this.partial.length > 0) {
      this.pushCompleteLine(this.partial);
      this.partial = "";
    }
  }

  /** Materialize the bounded tail for truncateTail. */
  getTailContent(): string {
    return this.lines.join("\n");
  }

  isOverLimit(): boolean {
    return this.totalLines > this.maxLines || this.totalBytes > this.maxBytes;
  }
}

export type PowerShellResolveOptions = {
  envPath?: string | null;
  candidates?: string[];
  platform?: NodeJS.Platform;
  probe?: (executable: string) => boolean;
};

export type PowerShellExecuteOptions = {
  timeout?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  executable?: string;
};

export type PowerShellExecuteResult = {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  fullOutputPath?: string;
  timedOut: boolean;
  aborted: boolean;
  executable: string;
};

function textResult(
  text: string,
  details: Record<string, unknown> = {},
  isError = false,
) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}

function defaultProbe(executable: string): boolean {
  try {
    const result = spawnSync(executable, [...PROBE_ARGS], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function defaultCandidates(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return ["pwsh.exe", "pwsh", "powershell.exe"];
  }
  return ["pwsh", "pwsh.exe"];
}

/**
 * Build the script body written to the temp .ps1 file.
 * Always sets $ErrorActionPreference = 'Stop' and enables native-command
 * error preference when the host PowerShell supports it.
 * Epilogue propagates native $LASTEXITCODE for Windows PowerShell 5.1.
 */
export function buildPowerShellScript(command: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {",
    "  $PSNativeCommandUseErrorActionPreference = $true",
    "}",
    command,
    // Propagate native exit codes for Windows PowerShell 5.1 (and any host
    // that does not turn native failures into terminating errors).
    "if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {",
    "  exit [int]$LASTEXITCODE",
    "}",
    "",
  ].join("\n");
}

/**
 * Resolve a usable PowerShell executable.
 * Order: explicit/env path (hard-fail if set and unusable), then injected or
 * default candidates probed with -Command $PSVersionTable.PSVersion.Major.
 */
export function resolvePowerShellExecutable(
  options: PowerShellResolveOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? defaultProbe;
  const envPath =
    options.envPath === undefined
      ? process.env.PI_POWERSHELL_PATH?.trim() || undefined
      : options.envPath?.trim() || undefined;

  if (envPath) {
    if (!probe(envPath)) {
      throw new Error(
        `PI_POWERSHELL_PATH is set to "${envPath}" but that executable is not a working PowerShell. Fix the path or unset PI_POWERSHELL_PATH.`,
      );
    }
    return envPath;
  }

  const candidates =
    options.candidates ?? defaultCandidates(platform);

  for (const candidate of candidates) {
    if (probe(candidate)) return candidate;
  }

  const tried = candidates.join(", ");
  throw new Error(
    `No working PowerShell executable found (tried: ${tried}). Install PowerShell 7+ (pwsh) or set PI_POWERSHELL_PATH.`,
  );
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite positive number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`,
    );
  }
  return timeoutMs;
}

function cleanupTemp(dir: string | undefined, file: string | undefined): void {
  if (file) {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function formatFromTail(
  tail: OutputTail,
  fullOutputPath: string,
): { text: string; truncated: boolean; fullOutputPath?: string } {
  const tailContent = tail.getTailContent();
  // truncateTail recomputes from the bounded in-memory suffix; overlay the
  // streamed totals so notices still reflect the full capture.
  const truncation = truncateTail(tailContent, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  const totalLines = Math.max(truncation.totalLines, tail.totalLines);
  const totalBytes = Math.max(truncation.totalBytes, tail.totalBytes);
  const overLimit =
    tail.isOverLimit() ||
    totalLines > DEFAULT_MAX_LINES ||
    totalBytes > DEFAULT_MAX_BYTES;

  if (!overLimit) {
    return {
      text: truncation.content || "(no output)",
      truncated: false,
    };
  }

  let truncatedBy: "lines" | "bytes" =
    truncation.truncatedBy ??
    (totalLines > DEFAULT_MAX_LINES ? "lines" : "bytes");
  // If the full stream exceeded the line budget but the bounded tail still
  // looks "complete" to truncateTail, force a lines truncation notice.
  if (!truncation.truncated && totalLines > DEFAULT_MAX_LINES) {
    truncatedBy = "lines";
  } else if (!truncation.truncated && totalBytes > DEFAULT_MAX_BYTES) {
    truncatedBy = "bytes";
  }

  const effective: TruncationResult = {
    content: truncation.content,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: truncation.outputLines,
    outputBytes: truncation.outputBytes,
    lastLinePartial: truncation.lastLinePartial,
  };

  const startLine = Math.max(
    1,
    effective.totalLines - effective.outputLines + 1,
  );
  const endLine = effective.totalLines;
  let notice: string;
  if (effective.lastLinePartial) {
    notice = `[Showing last ${formatSize(effective.outputBytes)} of line ${endLine}. Full output: ${fullOutputPath}]`;
  } else if (effective.truncatedBy === "lines") {
    notice = `[Showing lines ${startLine}-${endLine} of ${effective.totalLines}. Full output: ${fullOutputPath}]`;
  } else {
    notice = `[Showing lines ${startLine}-${endLine} of ${effective.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
  }

  const body = effective.content || "(no output)";
  return {
    text: `${body}\n\n${notice}`,
    truncated: true,
    fullOutputPath,
  };
}

/**
 * Execute a PowerShell command via a temp .ps1 script and a direct child process.
 */
export async function executePowerShell(
  command: string,
  cwd: string,
  options: PowerShellExecuteOptions = {},
): Promise<PowerShellExecuteResult> {
  const executable =
    options.executable ?? resolvePowerShellExecutable();
  const timeoutMs = resolveTimeoutMs(options.timeout);
  const signal = options.signal;

  if (signal?.aborted) {
    return {
      exitCode: null,
      output: "Command aborted",
      truncated: false,
      timedOut: false,
      aborted: true,
      executable,
    };
  }

  let scriptDir: string | undefined;
  let scriptPath: string | undefined;
  let outputDir: string | undefined;
  let outputPath: string | undefined;
  let outputFd: number | undefined;
  let child: ChildProcess | undefined;
  let timedOut = false;
  let aborted = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let retainFullOutput = false;
  const processGroup = process.platform !== "win32";

  const onAbort = () => {
    aborted = true;
    if (child?.pid) killProcessTree(child.pid, { processGroup });
  };

  try {
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-powershell-"));
    scriptPath = path.join(scriptDir, "script.ps1");
    fs.writeFileSync(scriptPath, buildPowerShellScript(command), "utf8");

    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-powershell-out-"));
    outputPath = path.join(outputDir, "output.txt");
    outputFd = fs.openSync(outputPath, "w");

    const tail = new OutputTail(DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
    const isWin = process.platform === "win32";

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child = spawn(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          scriptPath!,
        ],
        {
          cwd,
          env: options.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          // Detached process group on non-Windows so -pid kills the tree.
          detached: !isWin,
        },
      );

      const onChunk = (data: Buffer) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (outputFd !== undefined) {
          try {
            fs.writeSync(outputFd, buf);
          } catch {
            // best-effort full capture
          }
        }
        tail.write(buf);
      };

      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);

      child.once("error", (err) => {
        reject(err);
      });

      child.once("close", (code) => {
        resolve(code);
      });

      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child?.pid) killProcessTree(child.pid, { processGroup });
        }, timeoutMs);
      }

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    tail.end();
    if (outputFd !== undefined) {
      try {
        fs.closeSync(outputFd);
      } catch {
        // ignore
      }
      outputFd = undefined;
    }

    const formatted = formatFromTail(tail, outputPath);
    retainFullOutput = formatted.truncated === true;

    if (aborted || signal?.aborted) {
      const text = formatted.text === "(no output)"
        ? "Command aborted"
        : `${formatted.text}\n\nCommand aborted`;
      return {
        exitCode: null,
        output: text,
        truncated: formatted.truncated,
        fullOutputPath: formatted.fullOutputPath,
        timedOut: false,
        aborted: true,
        executable,
      };
    }

    if (timedOut) {
      const secs = options.timeout;
      const status = `Command timed out after ${secs} seconds`;
      const text = formatted.text === "(no output)"
        ? status
        : `${formatted.text}\n\n${status}`;
      return {
        exitCode: null,
        output: text,
        truncated: formatted.truncated,
        fullOutputPath: formatted.fullOutputPath,
        timedOut: true,
        aborted: false,
        executable,
      };
    }

    let text = formatted.text;
    if (exitCode !== 0 && exitCode !== null) {
      const status = `Command exited with code ${exitCode}`;
      text = text === "(no output)" ? status : `${text}\n\n${status}`;
    }

    return {
      exitCode,
      output: text,
      truncated: formatted.truncated,
      fullOutputPath: formatted.fullOutputPath,
      timedOut: false,
      aborted: false,
      executable,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener("abort", onAbort);
    if (outputFd !== undefined) {
      try {
        fs.closeSync(outputFd);
      } catch {
        // ignore
      }
    }
    cleanupTemp(scriptDir, scriptPath);
    if (!retainFullOutput) {
      cleanupTemp(outputDir, outputPath);
    }
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "powershell",
    label: "PowerShell",
    description: [
      "Execute a PowerShell command as a direct PowerShell child process, independent of the host shell (not cmd, bash, or the parent shell).",
      "Writes a temp .ps1 with $ErrorActionPreference='Stop' and runs it via pwsh/powershell -File.",
      `Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); if truncated, full output is saved to a temp file.`,
      "Use for Windows-native work (.ps1, registry, services, certificates, .NET). Prefer bash for portable shell tasks.",
      "Optional timeout is in seconds.",
    ].join(" "),
    parameters: Type.Object({
      command: Type.String({
        description: "PowerShell command or script body to execute",
      }),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Timeout in seconds (optional, no default timeout; positive finite only)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const command = typeof params.command === "string" ? params.command : "";
      if (!command.trim()) {
        return textResult("command is required.", {}, true);
      }

      let executable: string;
      try {
        executable = resolvePowerShellExecutable();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(message, { unavailable: true }, true);
      }

      try {
        const result = await executePowerShell(command, ctx.cwd, {
          timeout: params.timeout,
          signal,
          executable,
        });

        const isError =
          result.aborted ||
          result.timedOut ||
          (result.exitCode !== 0 && result.exitCode !== null);

        return textResult(
          result.output,
          {
            exitCode: result.exitCode,
            truncated: result.truncated,
            fullOutputPath: result.fullOutputPath,
            timedOut: result.timedOut,
            aborted: result.aborted,
            executable: result.executable,
          },
          isError,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(message, { executable }, true);
      }
    },
  });
}
