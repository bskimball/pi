// Strict RPC JSONL framing: split only on LF, strip trailing CR.
// Do not use Node readline (it splits on U+2028/U+2029).

import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export type JsonlLineHandler = (line: string) => void;

/** Drop a single JSONL record past this size instead of parsing it in-process. */
export const MAX_JSONL_LINE = 256_000;
/** Enough edge text to recover type / toolCallId from the head and isError from the tail. */
const STUB_PREFIX = 4_096;

/**
 * Attach a protocol-compliant JSONL reader to a stream.
 * Records are delimited by `\n` only; optional trailing `\r` is stripped.
 * Oversized records are not parsed: a small type/id stub is emitted instead so
 * lifecycle and tool-end events still land while streamed dumps stay off-heap.
 */
export function attachJsonlReader(
  stream: Readable,
  onLine: JsonlLineHandler,
  maxLine = MAX_JSONL_LINE,
): { dispose: () => void } {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let disposed = false;
  let skipping = false;
  let prefix = "";
  let suffix = "";

  const rememberSuffix = (chunk: string) => {
    if (!chunk) return;
    const tail = chunk.length > STUB_PREFIX ? chunk.slice(-STUB_PREFIX) : chunk;
    suffix = (suffix + tail).slice(-STUB_PREFIX);
  };

  const emitLine = (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) return;
    if (line.length > maxLine) {
      onLine(
        stubOversizedRecord(line.slice(0, STUB_PREFIX), line.slice(-STUB_PREFIX)),
      );
      return;
    }
    onLine(line);
  };

  const finishSkipped = () => {
    skipping = false;
    if (prefix) onLine(stubOversizedRecord(prefix, suffix));
    prefix = "";
    suffix = "";
  };

  const consumeBuffer = () => {
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        if (buffer.length > maxLine) {
          prefix = buffer.slice(0, STUB_PREFIX);
          rememberSuffix(buffer);
          skipping = true;
          buffer = "";
        }
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (skipping) {
        finishSkipped();
        continue;
      }
      emitLine(line);
    }
  };

  const beginSkip = (head: string, tail: string) => {
    if (!prefix) prefix = (buffer + head).slice(0, STUB_PREFIX);
    rememberSuffix(buffer);
    rememberSuffix(tail);
    skipping = true;
    buffer = "";
  };

  const onData = (chunk: Buffer | string) => {
    if (disposed) return;
    const piece = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (skipping) {
      const newlineIndex = piece.indexOf("\n");
      if (newlineIndex === -1) {
        rememberSuffix(piece);
        return;
      }
      rememberSuffix(piece.slice(0, newlineIndex));
      finishSkipped();
      buffer = piece.slice(newlineIndex + 1);
      consumeBuffer();
      return;
    }
    const newlineIndex = piece.indexOf("\n");
    if (newlineIndex === -1) {
      if (buffer.length + piece.length > maxLine) {
        beginSkip(piece.slice(0, STUB_PREFIX), piece);
        return;
      }
      buffer += piece;
      return;
    }
    const first = piece.slice(0, newlineIndex);
    if (buffer.length + first.length > maxLine) {
      beginSkip(first.slice(0, STUB_PREFIX), first);
      finishSkipped();
      buffer = piece.slice(newlineIndex + 1);
      consumeBuffer();
      return;
    }
    buffer += piece;
    consumeBuffer();
  };

  const onEnd = () => {
    if (disposed) return;
    buffer += decoder.end();
    if (skipping) {
      finishSkipped();
      buffer = "";
      return;
    }
    if (buffer.length > 0) emitLine(buffer);
    buffer = "";
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
      prefix = "";
      suffix = "";
    },
  };
}

/** Encode one JSONL command record (always ends with LF). */
export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Recover a tiny event so tool-end / lifecycle still close after a dropped dump. */
export function stubOversizedRecord(prefix: string, suffix = ""): string {
  const sample = `${prefix}\n${suffix}`;
  const type =
    sample.match(/"type"\s*:\s*"([^"]{1,80})"/)?.[1] ?? "oversized_record";
  const toolCallId = sample.match(/"toolCallId"\s*:\s*"([^"]{1,120})"/)?.[1];
  const isError = /"isError"\s*:\s*true/.test(sample);
  return JSON.stringify({
    type,
    ...(toolCallId ? { toolCallId } : {}),
    ...(isError ? { isError: true } : {}),
    truncated: true,
  });
}

/** Parse one JSONL line; returns undefined on empty/invalid JSON. */
export function parseJsonlLine(line: string): unknown | undefined {
  if (line.length > MAX_JSONL_LINE) return undefined;
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
