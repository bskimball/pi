// Strict RPC JSONL framing: split only on LF, strip trailing CR.
// Do not use Node readline (it splits on U+2028/U+2029).

import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export type JsonlLineHandler = (line: string) => void;

/**
 * Attach a protocol-compliant JSONL reader to a stream.
 * Records are delimited by `\n` only; optional trailing `\r` is stripped.
 */
export function attachJsonlReader(
  stream: Readable,
  onLine: JsonlLineHandler,
): { dispose: () => void } {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let disposed = false;

  const onData = (chunk: Buffer | string) => {
    if (disposed) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  };

  const onEnd = () => {
    if (disposed) return;
    buffer += decoder.end();
    if (buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      buffer = "";
      if (line.length > 0) onLine(line);
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      try {
        decoder.end();
      } catch {
        // ignore
      }
      buffer = "";
    },
  };
}

/** Encode one JSONL command record (always ends with LF). */
export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Parse one JSONL line; returns undefined on empty/invalid JSON. */
export function parseJsonlLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
