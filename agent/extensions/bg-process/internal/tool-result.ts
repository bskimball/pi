// tool-result: shared tool return helpers and working-directory validation.
//
// Keeps model-facing text payloads consistent across extensions without each
// file re-declaring the same three-line helpers.

import * as fs from "node:fs";
import * as path from "node:path";

export function textResult(
  text: string,
  isError = false,
  details: unknown = {},
) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}

export function resolveCwd(raw: string | undefined, fallback: string): string {
  const candidate = raw?.trim() ? raw.trim() : fallback;
  return path.resolve(candidate);
}

/** Returns an error message when cwd is unusable; undefined when ok. */
export function validateCwd(cwd: string): string | undefined {
  try {
    if (!fs.existsSync(cwd)) {
      return `working_dir "${cwd}" does not exist. On Windows use a native path (e.g. C:/Users/...), not a bash-style path.`;
    }
    if (!fs.statSync(cwd).isDirectory()) {
      return `working_dir "${cwd}" is not a directory.`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `working_dir "${cwd}" is not usable: ${message}`;
  }
  return undefined;
}
