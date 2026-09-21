// Pure log-rotation helpers. No Pi imports.

import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_LOG_BYTES = 1024 * 1024;
const ROTATED_LOG_SUFFIX = ".log";

function rotatedLogPrefix(logPath: string): string {
  return `${path.basename(logPath, path.extname(logPath))}.rotated.`;
}

export function rotateIfNeeded(logPath: string): void {
  try {
    if (fs.statSync(logPath).size < MAX_LOG_BYTES) return;

    // Rename the active file instead of rewriting it in place. Other Pi
    // processes may append concurrently: on POSIX an already-open writer keeps
    // writing to the renamed file, while on Windows the rename fails safely if
    // another process holds the file open. Neither case overwrites new evidence.
    const directory = path.dirname(logPath);
    const rotatedPrefix = rotatedLogPrefix(logPath);
    const rotatedPath = path.join(
      directory,
      `${rotatedPrefix}${Date.now()}.${process.pid}${ROTATED_LOG_SUFFIX}`,
    );
    fs.renameSync(logPath, rotatedPath);

    // Keep one complete rotated generation plus the active log. Unique names
    // avoid cross-process replacement races; cleanup is best-effort.
    const rotated = fs
      .readdirSync(directory)
      .filter(
        (name) =>
          name.startsWith(rotatedPrefix) &&
          name.endsWith(ROTATED_LOG_SUFFIX),
      )
      .map((name) => {
        const filePath = path.join(directory, name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of rotated.slice(1)) {
      try {
        fs.unlinkSync(stale.filePath);
      } catch {
        // Another process may still hold or have already removed this archive.
      }
    }
  } catch {
    // Rotation must never create another fatal error.
  }
}
