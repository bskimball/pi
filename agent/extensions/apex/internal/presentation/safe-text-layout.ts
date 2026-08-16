// Dependency-free terminal text layout for extension-owned renderers.
//
// pi-tui's Unicode segmenter has intermittently crashed long Windows sessions.
// Keep all custom surfaces on this conservative path so cosmetic rendering can
// retain styling without entering that segmenter at all.

export interface TextLayoutRuntime {
  visibleWidth: (text: string) => number;
  truncateToWidth: (
    text: string,
    maxWidth: number,
    ellipsis?: string,
  ) => string;
}

const TERMINAL_SEQUENCE_RE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[P^_][\s\S]*?\x1b\\)/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const STYLED_CONTROL_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

function safeString(value: unknown): string {
  try {
    return typeof value === "string" ? value : String(value ?? "");
  } catch {
    return "[unrenderable]";
  }
}

function normalizedWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function stripTerminalSequences(value: unknown): string {
  return safeString(value)
    .replace(TERMINAL_SEQUENCE_RE, "")
    .replace(/\r\n?|\n/g, " ")
    .replace(/\t/g, "   ")
    .replace(CONTROL_RE, "");
}

function terminalSequenceAt(text: string, index: number): string | undefined {
  if (text.charCodeAt(index) !== 0x1b) return undefined;
  const match = text
    .slice(index)
    .match(
      /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[P^_][\s\S]*?\x1b\\)/,
    );
  return match?.[0];
}

function sanitizeStyledText(value: unknown): string {
  return safeString(value)
    .replace(/\r\n?|\n/g, " ")
    .replace(/\t/g, "   ")
    .replace(STYLED_CONTROL_RE, "");
}

function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0483 && codePoint <= 0x0489) ||
    (codePoint >= 0x0591 && codePoint <= 0x05bd) ||
    codePoint === 0x05bf ||
    (codePoint >= 0x05c1 && codePoint <= 0x05c2) ||
    (codePoint >= 0x05c4 && codePoint <= 0x05c5) ||
    codePoint === 0x05c7 ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06ed) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function fallbackCodePointWidth(codePoint: number): number {
  if (
    isCombiningCodePoint(codePoint) ||
    codePoint === 0x200d ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return 0;
  }

  const isWide =
    codePoint >= 0x1f000 ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6)));
  return isWide ? 2 : 1;
}

export function fallbackVisibleWidth(value: unknown): number {
  const text = stripTerminalSequences(value);
  let width = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    width += fallbackCodePointWidth(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return width;
}

export function fallbackTruncateToWidth(
  value: unknown,
  maxWidth: number,
): string {
  const widthLimit = normalizedWidth(maxWidth);
  if (widthLimit === 0) return "";

  const text = stripTerminalSequences(value);
  let result = "";
  let width = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const characterWidth = fallbackCodePointWidth(codePoint);
    if (width + characterWidth > widthLimit) break;
    result += String.fromCodePoint(codePoint);
    width += characterWidth;
    index += codePoint > 0xffff ? 2 : 1;
  }

  // Avoid leaving an incomplete emoji join sequence at the clipping boundary.
  return result.replace(/[\u200d\ufe0e\ufe0f]+$/u, "");
}

export function safeVisibleWidth(
  value: unknown,
  runtime?: TextLayoutRuntime,
): number {
  const text = safeString(value);
  if (runtime) {
    try {
      const width = runtime.visibleWidth(text);
      if (Number.isFinite(width) && width >= 0) return Math.floor(width);
    } catch {
      // Fall through to the dependency-free width approximation.
    }
  }
  return fallbackVisibleWidth(text);
}

export function safeTruncateToWidth(
  value: unknown,
  maxWidth: number,
  runtime?: TextLayoutRuntime,
): string {
  const text = safeString(value);
  const widthLimit = normalizedWidth(maxWidth);
  if (widthLimit === 0) return "";
  if (runtime) {
    try {
      const result = runtime.truncateToWidth(text, widthLimit, "");
      if (typeof result === "string") {
        const resultWidth = runtime.visibleWidth(result);
        if (
          Number.isFinite(resultWidth) &&
          resultWidth >= 0 &&
          resultWidth <= widthLimit
        ) {
          return result;
        }
      }
    } catch {
      // Fall through to the dependency-free styled truncator.
    }
  }

  const styled = sanitizeStyledText(text);
  let result = "";
  let width = 0;
  let index = 0;
  let sawAnsi = false;
  while (index < styled.length) {
    const sequence = terminalSequenceAt(styled, index);
    if (sequence) {
      result += sequence;
      sawAnsi = true;
      index += sequence.length;
      continue;
    }
    // Drop unsupported/bare ESC sequences rather than counting or emitting an
    // unknown terminal control byte.
    if (styled.charCodeAt(index) === 0x1b) {
      index++;
      continue;
    }
    const codePoint = styled.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const characterWidth = fallbackCodePointWidth(codePoint);
    if (width + characterWidth > widthLimit) break;
    result += character;
    width += characterWidth;
    index += character.length;
  }
  result = result.replace(/[\u200d\ufe0e\ufe0f]+$/u, "");
  return sawAnsi ? `${result}\x1b[0m` : result;
}

/**
 * Word-wrap PLAIN text (no ANSI) to a width, with optional hanging indent.
 *
 * Callers must wrap unstyled text and apply color to each returned line. This
 * deliberately avoids reflowing escape sequences, which is where ANSI-aware
 * wrapping usually goes wrong. Output is hard-bounded by maxLines so a
 * pathological input can never explode the render.
 */
export function wrapPlainText(
  value: unknown,
  maxWidth: number,
  options: { hangingIndent?: number; maxLines?: number } = {},
): string[] {
  const widthLimit = normalizedWidth(maxWidth);
  if (widthLimit === 0) return [];
  const maxLines = Math.max(1, options.maxLines ?? 400);
  // Cap the hanging indent at half the line so a large indent on a narrow
  // terminal cannot starve the continuation lines down to a character each.
  const indent = Math.max(
    0,
    Math.min(options.hangingIndent ?? 0, Math.floor(widthLimit / 2)),
  );
  const pad = " ".repeat(indent);

  const text = stripTerminalSequences(value).replace(/\s+$/, "");
  if (!text) return [""];

  const words = text.split(/ +/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let limit = widthLimit;

  const pushCurrent = () => {
    lines.push(current);
    current = "";
    currentWidth = 0;
    limit = widthLimit - indent;
  };

  for (const word of words) {
    if (lines.length >= maxLines) break;
    const wordWidth = fallbackVisibleWidth(word);
    const prefix = currentWidth === 0 ? (lines.length === 0 ? "" : pad) : " ";
    const prefixWidth = currentWidth === 0 ? 0 : 1;

    // A word longer than the line gets hard-split rather than overflowing.
    if (wordWidth > limit) {
      if (currentWidth > 0) pushCurrent();
      let rest = word;
      while (rest && lines.length < maxLines) {
        const head = fallbackTruncateToWidth(rest, limit);
        if (!head) break;
        lines.push((lines.length === 0 ? "" : pad) + head);
        rest = rest.slice(head.length);
        limit = widthLimit - indent;
      }
      continue;
    }

    if (currentWidth + prefixWidth + wordWidth > limit) {
      pushCurrent();
      current = pad + word;
      currentWidth = indent + wordWidth;
      continue;
    }
    current += prefix + word;
    currentWidth += prefixWidth + wordWidth;
  }

  if (current && lines.length < maxLines) lines.push(current);
  return lines.length ? lines.slice(0, maxLines) : [""];
}

/** Pad plain text on the left to an exact visible width (right-aligned columns). */
export function padStartToWidth(value: unknown, width: number): string {
  const target = normalizedWidth(width);
  const current = fallbackVisibleWidth(value);
  if (current >= target) return fallbackTruncateToWidth(value, target);
  return `${" ".repeat(target - current)}${safeString(value)}`;
}

export function renderLinesSafely(
  build: (width: number) => unknown,
  width: number,
  fallback = "[display unavailable]",
): string[] {
  const widthLimit = normalizedWidth(width);
  if (widthLimit === 0) return [""];
  try {
    const built = build(widthLimit);
    const lines = Array.isArray(built) ? built : [built];
    return lines.map((line) => safeTruncateToWidth(line, widthLimit));
  } catch {
    return [fallbackTruncateToWidth(fallback, widthLimit)];
  }
}
