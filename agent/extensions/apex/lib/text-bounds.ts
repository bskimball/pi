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

export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { role?: string; content?: unknown };
  if (m.role && m.role !== "assistant") return "";
  if (typeof m.content === "string") return m.content.trim();
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter(
      (item): item is { type: string; text?: string } =>
        !!item &&
        typeof item === "object" &&
        (item as { type?: string }).type === "text",
    )
    .map((item) => String(item.text ?? ""))
    .join("\n")
    .trim();
}
