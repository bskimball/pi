import { isAbsolute, resolve } from "node:path";

/** Collect conservative file-path candidates emitted by edit and write tools. */
export function collectEditPaths(input: unknown, cwd: string): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const candidates: string[] = [];
  for (const key of ["path", "file", "filePath", "target"]) {
    if (typeof obj[key] === "string") candidates.push(obj[key]);
  }
  if (Array.isArray(obj.paths)) {
    for (const path of obj.paths) {
      if (typeof path === "string") candidates.push(path);
    }
  }
  if (typeof obj.text === "string") {
    for (const line of obj.text.split(/\r?\n/)) {
      const match = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (match) candidates.push(match[1]);
    }
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const path = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
    const identity = process.platform === "win32" ? path.toLowerCase() : path;
    if (!seen.has(identity)) {
      seen.add(identity);
      paths.push(path);
    }
  }
  return paths;
}

export function shouldDiagnosePostEdit(event: {
  isError?: boolean;
  toolName?: string;
}): boolean {
  if (event.isError || process.env.PI_SUBAGENT === "1") return false;
  const toolName = (event.toolName ?? "").toLowerCase();
  return toolName === "edit" || toolName === "write";
}
