/**
 * Position encoding helpers for LSP (utf-16 default, utf-8, utf-32).
 * External API uses 1-based line/column (code units in the active encoding
 * after conversion). Internally LSP positions are 0-based.
 */

export type PositionEncoding = "utf-16" | "utf-8" | "utf-32";

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

/** Convert 1-based external line/column to 0-based LSP position. */
export function toLspPosition(line1: number, column1: number): Position {
  const line = Math.max(0, Math.floor(line1) - 1);
  const character = Math.max(0, Math.floor(column1) - 1);
  return { line, character };
}

/** Convert 0-based LSP position to 1-based external line/column. */
export function fromLspPosition(pos: Position): { line: number; column: number } {
  return {
    line: (pos?.line ?? 0) + 1,
    column: (pos?.character ?? 0) + 1,
  };
}

function lineAt(text: string, line: number): string {
  if (line < 0) return "";
  let start = 0;
  let current = 0;
  while (current < line) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) return "";
    start = nl + 1;
    current += 1;
  }
  const end = text.indexOf("\n", start);
  const raw = end === -1 ? text.slice(start) : text.slice(start, end);
  return raw.endsWith("\r") ? raw.slice(0, -1) : raw;
}

/** Offset (JS string index / UTF-16 code unit) for a 0-based line/character in encoding. */
export function offsetOf(
  text: string,
  line: number,
  character: number,
  encoding: PositionEncoding = "utf-16",
): number {
  if (line < 0) return 0;
  let start = 0;
  let current = 0;
  while (current < line) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) return text.length;
    start = nl + 1;
    current += 1;
  }
  if (character <= 0) return Math.min(start, text.length);

  const lineText = lineAt(text, line);
  if (encoding === "utf-16") {
    return Math.min(start + character, start + lineText.length, text.length);
  }
  if (encoding === "utf-32") {
    let units = 0;
    let i = 0;
    while (i < lineText.length && units < character) {
      const cp = lineText.codePointAt(i)!;
      i += cp > 0xffff ? 2 : 1;
      units += 1;
    }
    return Math.min(start + i, text.length);
  }
  // utf-8
  let bytes = 0;
  let i = 0;
  while (i < lineText.length && bytes < character) {
    const cp = lineText.codePointAt(i)!;
    const w = utf8Width(cp);
    if (bytes + w > character) break;
    bytes += w;
    i += cp > 0xffff ? 2 : 1;
  }
  return Math.min(start + i, text.length);
}

/** Character offset in the given encoding for a JS string offset within its line. */
export function characterOf(
  text: string,
  line: number,
  jsOffsetInLine: number,
  encoding: PositionEncoding = "utf-16",
): number {
  const lineText = lineAt(text, line);
  const slice = lineText.slice(0, Math.max(0, Math.min(jsOffsetInLine, lineText.length)));
  if (encoding === "utf-16") return slice.length;
  if (encoding === "utf-32") {
    let units = 0;
    for (let i = 0; i < slice.length; ) {
      const cp = slice.codePointAt(i)!;
      i += cp > 0xffff ? 2 : 1;
      units += 1;
    }
    return units;
  }
  let bytes = 0;
  for (let i = 0; i < slice.length; ) {
    const cp = slice.codePointAt(i)!;
    bytes += utf8Width(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return bytes;
}

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Convert a user-facing 1-based column (code units in the document's encoding)
 * when the user is thinking in ordinary editor columns (UTF-16 / JS indices).
 * For agent tools we accept 1-based columns as UTF-16 code units by default
 * (matches VS Code / most editors) and convert to the server encoding.
 */
export function externalToLsp(
  text: string,
  line1: number,
  column1: number,
  encoding: PositionEncoding = "utf-16",
): Position {
  const line = Math.max(0, Math.floor(line1) - 1);
  const col0 = Math.max(0, Math.floor(column1) - 1);
  if (encoding === "utf-16") return { line, character: col0 };
  // Treat external column as UTF-16 (JS) index within the line, convert to encoding.
  const lineText = lineAt(text, line);
  const jsIndex = Math.min(col0, lineText.length);
  return { line, character: characterOf(text, line, jsIndex, encoding) };
}

export function pickEncodingFromInitializeResult(result: unknown): PositionEncoding {
  const encoding = (result as { positionEncoding?: string } | null)?.positionEncoding;
  if (encoding === "utf-8") return "utf-8";
  if (encoding === "utf-32") return "utf-32";
  return "utf-16";
}
