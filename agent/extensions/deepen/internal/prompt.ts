// Prompt construction, output parsing, and BMP-safe text bounding for /deepen.

export const READ_ONLY_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "ffgrep",
  "fffind",
] as const;

export const EXCLUDED_HELPER_TOOLS = [
  "bash",
  "powershell",
  "edit",
  "write",
  "task",
  "task_start",
  "task_status",
  "task_list",
  "task_send",
  "task_wait",
  "task_abort",
  "task_close",
  "task_reply",
  "task_chain",
  "task_rebind",
  "intercom",
  "worktree",
  "shipping",
  "memory_write",
  "bg_start",
  "bg_status",
  "bg_list",
  "bg_kill",
  "generate_image",
  "browser_attach",
  "jev",
] as const;

const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Sanitize dynamic status/notice text to narrow printable ASCII + middle dot,
 * honoring Windows Terminal rendering rules (no wide/combining/surrogate glyphs).
 */
export function sanitizeStatusText(value: unknown, maxChars = 72): string {
  const raw = String(value ?? "")
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/[\r\n\t]+/g, " ");
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    // Skip surrogate pairs and non-printable control chars.
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (code < 0x20 || (code >= 0x7f && code !== 0x00b7)) continue;
    if (code > 0x00ff) continue;
    out += raw[i];
  }
  const compact = out.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function sanitizeNoticeLines(
  value: string,
  maxLines = 6,
  maxLineChars = 120,
): string {
  const clean = value
    .replace(/\u0000/g, "")
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!clean) return "";
  const rawLines = clean.split("\n").map((line) => sanitizeStatusText(line, maxLineChars)).filter(Boolean);
  if (!rawLines.length) return "";
  const sliced = rawLines.slice(0, maxLines);
  if (rawLines.length > maxLines) sliced.push("...");
  return sliced.join("\n");
}

export function boundLines(
  value: string,
  maxLines: number,
  maxChars: number,
): string {
  const clean = value.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
  if (!clean) return "";
  const lines = clean.split("\n");
  let sliced = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  if (sliced.length > maxChars) {
    sliced = sliced.slice(0, maxChars).trimEnd();
    truncated = true;
  }
  return truncated ? `${sliced}\n...` : sliced;
}

export function summarizeToolTarget(
  toolName: string,
  args: unknown,
): string {
  const tool = sanitizeStatusText(toolName, 20) || "read";
  if (!args || typeof args !== "object") return tool;
  const rec = args as Record<string, unknown>;
  const rawTarget =
    rec.path ?? rec.pattern ?? rec.glob ?? rec.query ?? undefined;
  if (typeof rawTarget !== "string" || !rawTarget.trim()) return tool;
  const normalized = rawTarget.trim().replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const short =
    parts.length > 2 ? parts.slice(-2).join("/") : normalized;
  return sanitizeStatusText(`${tool} ${short}`, 56);
}

export const DEEPEN_SYSTEM_INSTRUCTIONS = `You are a read-only prompt-deepening pass. Your job is to ground the user's request in the actual workspace and rewrite the prompt to ask for a deeper version of the same task — never a bigger one.

## How to work
1. Without asking questions, inspect the real code, config, schemas, tests, or logs this task touches using read-only search and file reads (fffind, ffgrep, read, grep, find, ls).
2. Keep discovery fast and targeted (1-3 turns, at most 6 tool calls — stop reading once you have the target files and existing check). Read enough to cite real paths, symbols, data shapes, and verification commands that exist in this workspace. Do not scan ~/.pi/agent/sessions, node_modules, build outputs, or caches unless the prompt explicitly targets them.
3. Keep scope identical: do not add adjacent features, extra phases, or speculative abstractions. Upgrade vertical rigor — raw source material, practitioner method, sharp constraints, and an external check.
4. Never execute the task, edit files, or ask the user questions. Fold any genuine assumption check or decision boundary into the rewritten prompt.

## Required output format
First write four concise single-line bullets grounded in what you read:
(1) Practitioner gap: what a top practitioner in this domain would do or verify here that the draft omits (including any assumption to test against raw code or data).
(2) Rawest source: the exact source-of-truth files, types, logs, or inputs in this workspace to start from instead of summaries.
(3) Methods & tools: the specific existing helpers, APIs, invariants, or techniques in this repo to use.
(4) Outside judge: what runnable command, behavioral repro, live check, or falsifiable predicate — outside model self-grading — proves the result is right.

Then emit the rewritten prompt inside <improved-prompt>...</improved-prompt> tags:
- Keep the user's voice and exact goal.
- Name the concrete files/symbols, constraints, and external verification check you found.
- Put ONLY the ready-to-send prompt text inside <improved-prompt>...</improved-prompt>.`;

export function buildDeepenUserPrompt(draftPrompt: string): string {
  const trimmed = draftPrompt.trim();
  const targetSection = trimmed
    ? `## Draft prompt to deepen\n${trimmed}`
    : `## Draft prompt to deepen\nNone given — deepen the current in-progress task or plan from this conversation's recent turns, keeping its scope while grounding it in the workspace's real files, invariants, and external proof.`;

  return `${targetSection}\n\n## Return\nOutput bullets (1)-(4), followed by the final <improved-prompt>...</improved-prompt> block.`;
}

export interface ParsedDeepenReply {
  notes: string;
  improvedPrompt: string;
}

export function parseDeepenReply(reply: string): ParsedDeepenReply | undefined {
  const clean = reply.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
  if (!clean) return undefined;

  const pattern = /<improved-prompt>([\s\S]*?)<\/improved-prompt>/gi;
  let lastMatch: RegExpExecArray | undefined;
  for (let match = pattern.exec(clean); match !== null; match = pattern.exec(clean)) {
    lastMatch = match;
  }
  if (!lastMatch) return undefined;

  const improvedPrompt = lastMatch[1]!.trim();
  if (!improvedPrompt) return undefined;

  const before = clean.slice(0, lastMatch.index).trim();
  return {
    notes: sanitizeNoticeLines(boundLines(before, 8, 900), 6, 140),
    improvedPrompt,
  };
}
