// Bounded text helpers for status/results (no TUI dependencies).

export function cleanOneLine(value: unknown, max: number): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function boundText(
  value: unknown,
  maxChars: number,
  maxLines: number,
): { text: string; truncated: boolean } {
  let text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    truncated = true;
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > maxLines) {
    text = lines.slice(lines.length - maxLines).join("\n");
    truncated = true;
  }
  return { text, truncated };
}

/** Caps for expanded task/sub-agent card body text before TUI layout. */
export const EXPANDED_CARD_MAX_CHARS = 8_000;
export const EXPANDED_CARD_MAX_LINES = 40;
export const EXPANDED_CARD_MAX_LINE_CHARS = 240;

/** Hard ceiling for a fully assembled expanded card, regardless of per-section limits. */
export const EXPANDED_CARD_RENDER_MAX_LINES = 40;

/** Slice assembled card lines to the expanded-frame height cap. */
export function capRenderedCardLines(
  lines: readonly string[],
  maxLines = EXPANDED_CARD_RENDER_MAX_LINES,
): string[] {
  if (lines.length <= maxLines) return [...lines];
  return lines.slice(0, Math.max(0, maxLines));
}

const ANSI_RE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[P^_][\s\S]*?\x1b\\)/g;

/** Character budget on expand breadcrumbs: UTF-16 length after stripping ANSI escapes. */
export function renderedCardCharCount(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) n += String(line ?? "").replace(ANSI_RE, "").length;
  return n;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-16 slice that never leaves a lone surrogate at either edge. */
function sliceCodeUnitsSafe(text: string, start: number, end: number): string {
  let s = Math.max(0, start);
  let e = Math.min(text.length, end);
  if (s < e && isLowSurrogate(text.charCodeAt(s))) s += 1;
  if (e > s && isHighSurrogate(text.charCodeAt(e - 1))) e -= 1;
  return text.slice(s, e);
}

/**
 * Bound expanded card strings before they enter TUI Text/Markdown/layout.
 * Default keep is the start of the report (sync). Pass keep: "tail" for
 * async latest-text previews so the conclusion stays visible.
 * Caps total characters, line count, and pathological single-line runs.
 */
export function boundExpandedCardText(
  value: unknown,
  options: {
    maxChars?: number;
    maxLines?: number;
    maxLineChars?: number;
    keep?: "head" | "tail";
  } = {},
): { text: string; truncated: boolean } {
  const maxChars = options.maxChars ?? EXPANDED_CARD_MAX_CHARS;
  const maxLines = options.maxLines ?? EXPANDED_CARD_MAX_LINES;
  const maxLineChars = options.maxLineChars ?? EXPANDED_CARD_MAX_LINE_CHARS;
  const keepTail = options.keep === "tail";
  let truncated = false;
  let text = String(value ?? "").replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    "",
  );
  if (text.length > maxChars) {
    text = keepTail
      ? sliceCodeUnitsSafe(text, text.length - maxChars, text.length)
      : sliceCodeUnitsSafe(text, 0, maxChars);
    truncated = true;
  }
  const rawLines = text.split(/\r?\n/);
  const selected = keepTail
    ? rawLines.slice(Math.max(0, rawLines.length - maxLines))
    : rawLines.slice(0, maxLines);
  if (rawLines.length > maxLines) truncated = true;
  const lines = selected.map((line) => {
    if (line.length <= maxLineChars) return line;
    truncated = true;
    return keepTail
      ? sliceCodeUnitsSafe(line, line.length - maxLineChars, line.length)
      : sliceCodeUnitsSafe(line, 0, maxLineChars);
  });
  return { text: lines.join("\n"), truncated };
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${String(rem).padStart(2, "0")}s`;
}

/** Visible assistant text only (content blocks with type === "text"). */
export function extractAssistantText(message: unknown, maxChars = 12_000): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { role?: string; content?: unknown };
  if (m.role && m.role !== "assistant") return "";
  if (typeof m.content === "string") {
    const text =
      m.content.length > maxChars
        ? m.content.slice(m.content.length - maxChars)
        : m.content;
    return text.trim();
  }
  if (!Array.isArray(m.content)) return "";
  let text = "";
  for (const item of m.content) {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: string }).type !== "text"
    ) {
      continue;
    }
    const raw = (item as { text?: unknown }).text;
    const piece =
      typeof raw === "string"
        ? raw.length > maxChars
          ? raw.slice(raw.length - maxChars)
          : raw
        : String(raw ?? "");
    if (!piece) continue;
    if (piece.length >= maxChars) {
      text = piece.slice(piece.length - maxChars);
      continue;
    }
    if (!text) {
      text = piece;
      continue;
    }
    if (text.length + 1 + piece.length <= maxChars) {
      text = `${text}\n${piece}`;
      continue;
    }
    const keep = maxChars - piece.length - 1;
    text = `${keep > 0 ? text.slice(text.length - keep) : ""}\n${piece}`;
  }
  return text.trim();
}

/**
 * Assistant thinking/reasoning blocks only. Used for diagnostics when a model
 * (notably Gemini via local-proxy) exits stop with thinking and zero visible
 * text — the common cause of "completed without an assistant result".
 */
export function extractAssistantThinking(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { role?: string; content?: unknown };
  if (m.role && m.role !== "assistant") return "";
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter(
      (item): item is { type: string; thinking?: string } =>
        !!item &&
        typeof item === "object" &&
        (item as { type?: string }).type === "thinking",
    )
    .map((item) => String(item.thinking ?? ""))
    .join("\n\n")
    .trim();
}
