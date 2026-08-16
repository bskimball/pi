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
