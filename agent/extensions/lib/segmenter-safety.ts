// Process-wide shield around `Intl.Segmenter`.
//
// Pi TUI measures every compositor line with a shared native Segmenter
// (`visibleWidth` / `truncateToWidth` / alt-screen clip). On Windows that
// native path can abort the Node process — no JS exception, no pi-crash.log —
// and leave the parent shell in raw/mouse mode. Apex receipts already avoid
// calling those helpers, but the host compositor still does.
//
// This patch is the only hook that covers already-imported pi-tui bindings.
// Word/sentence segmentation stays native so editor Ctrl/Alt word movement
// keeps `isWordLike`. Grapheme measurement is chunked so ICU never sees a
// 50k-character resume line in one call, and every yielded `segment` is a
// real string (the historical `segment.codePointAt is not a function` failure).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Native ICU is only trusted up to this many UTF-16 code units per call. */
export const MAX_NATIVE_SEGMENT_CHARS = 2048;
/** Extra units peeked past the cap so a cluster at the seam is not split. */
const CHUNK_LOOKAHEAD = 32;

const INSTALL_KEY = Symbol.for("pi.segmenterSafety.installed");
const state = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean };

type SegmentItem = Intl.SegmentData;
type SegmentFn = (input: string) => Intl.Segments;

const nativeCallLengths: number[] = [];
let reportedNativeFailure = false;

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return String(value);
  } catch {
    return "";
  }
}

function noteNativeCall(length: number): void {
  nativeCallLengths.push(length);
  if (nativeCallLengths.length > 64) nativeCallLengths.shift();
}

/** Recent native `segment()` input lengths. Test/diagnostic only. */
export function recentNativeSegmentLengths(): readonly number[] {
  return nativeCallLengths;
}

function reportOnce(error: unknown): void {
  if (reportedNativeFailure) return;
  reportedNativeFailure = true;
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  const entry = `\n=== segmenter-safety fallback at ${new Date().toISOString()} ===\n${message}\n`;
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  try {
    fs.appendFileSync(path.join(agentDir, "pi-render.log"), entry, "utf8");
  } catch {
    // A safety net must never throw.
  }
}

function preserveItem(item: unknown, offset = 0): SegmentItem {
  if (!item || typeof item !== "object") {
    return { segment: safeString(item), index: offset, input: "" };
  }
  const record = item as SegmentItem;
  const segment =
    typeof record.segment === "string"
      ? record.segment
      : safeString(record.segment);
  const index =
    typeof record.index === "number" && Number.isFinite(record.index)
      ? Math.max(0, Math.floor(record.index)) + offset
      : offset;
  return { ...record, segment, index };
}

function toIntegerOrInfinity(value: unknown): number {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return 0;
  if (numeric === 0) return 0;
  if (!Number.isFinite(numeric)) return numeric;
  return Math.trunc(numeric);
}

function makeSegments(items: SegmentItem[], inputLength: number): Intl.Segments {
  return {
    *[Symbol.iterator]() {
      yield* items;
    },
    containing(codeUnitIndex: number) {
      const index = toIntegerOrInfinity(codeUnitIndex);
      if (!Number.isFinite(index) || index < 0 || index >= inputLength) {
        return undefined;
      }
      if (items.length === 0) return undefined;
      let chosen = items[0];
      for (const item of items) {
        if (item.index > index) break;
        chosen = item;
      }
      return chosen;
    },
  } as Intl.Segments;
}

/** Code-point segments. Safe for terminal width; never calls ICU. */
export function fallbackSegments(text: string): Intl.Segments {
  const items: SegmentItem[] = [];
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const segment = String.fromCodePoint(codePoint);
    items.push({ segment, index, input: text });
    index += segment.length;
  }
  return makeSegments(items, text.length);
}

function collectAllOrFail(
  segments: Intl.Segments,
  offset: number,
): { ok: true; items: SegmentItem[] } | { ok: false } {
  const items: SegmentItem[] = [];
  try {
    for (const item of segments) {
      items.push(preserveItem(item, offset));
    }
    return { ok: true, items };
  } catch {
    return { ok: false };
  }
}

function callNative(
  segmenter: Intl.Segmenter,
  text: string,
  original: SegmentFn,
): Intl.Segments {
  noteNativeCall(text.length);
  return original.call(segmenter, text);
}

function wrapNativeSegments(
  segments: Intl.Segments,
  text: string,
): Intl.Segments {
  return {
    *[Symbol.iterator]() {
      const collected = collectAllOrFail(segments, 0);
      if (!collected.ok) {
        reportOnce(new Error("native segment iteration failed"));
        yield* fallbackSegments(text);
        return;
      }
      yield* collected.items;
    },
    containing(codeUnitIndex: number) {
      try {
        const item = segments.containing(codeUnitIndex);
        return item ? preserveItem(item) : undefined;
      } catch {
        return fallbackSegments(text).containing(codeUnitIndex);
      }
    },
  } as Intl.Segments;
}

function takeGraphemeWindow(
  segmenter: Intl.Segmenter,
  text: string,
  offset: number,
  original: SegmentFn,
): { items: SegmentItem[]; nextOffset: number } {
  const remaining = text.length - offset;
  const peekLen = Math.min(remaining, MAX_NATIVE_SEGMENT_CHARS + CHUNK_LOOKAHEAD);
  const window = text.slice(offset, offset + peekLen);
  const collected = collectAllOrFail(
    callNative(segmenter, window, original),
    offset,
  );
  if (!collected.ok) {
    reportOnce(new Error("native segment iteration failed"));
    return {
      items: [...fallbackSegments(window)].map((item) =>
        preserveItem(item, offset),
      ),
      nextOffset: offset + window.length,
    };
  }

  if (offset + peekLen >= text.length) {
    return { items: collected.items, nextOffset: text.length };
  }

  const limit = offset + MAX_NATIVE_SEGMENT_CHARS;
  const kept: SegmentItem[] = [];
  for (const item of collected.items) {
    const end = item.index + item.segment.length;
    if (end <= limit) {
      kept.push(item);
      continue;
    }
    if (kept.length === 0) {
      // One cluster is larger than the cap. Take it whole.
      kept.push(item);
    }
    break;
  }

  if (kept.length === 0) {
    return {
      items: [...fallbackSegments(window)].map((item) =>
        preserveItem(item, offset),
      ),
      nextOffset: offset + window.length,
    };
  }

  const last = kept[kept.length - 1];
  return { items: kept, nextOffset: last.index + last.segment.length };
}

function* iterateGraphemes(
  segmenter: Intl.Segmenter,
  text: string,
  original: SegmentFn,
): Generator<SegmentItem> {
  for (let offset = 0; offset < text.length; ) {
    const window = takeGraphemeWindow(segmenter, text, offset, original);
    if (window.nextOffset <= offset) {
      yield {
        segment: text.slice(offset, offset + 1),
        index: offset,
        input: text,
      };
      offset += 1;
      continue;
    }
    yield* window.items;
    offset = window.nextOffset;
  }
}

function segmentGraphemes(
  segmenter: Intl.Segmenter,
  text: string,
  original: SegmentFn,
): Intl.Segments {
  if (text.length <= MAX_NATIVE_SEGMENT_CHARS) {
    try {
      return wrapNativeSegments(callNative(segmenter, text, original), text);
    } catch (error) {
      reportOnce(error);
      return fallbackSegments(text);
    }
  }

  return {
    *[Symbol.iterator]() {
      try {
        yield* iterateGraphemes(segmenter, text, original);
      } catch (error) {
        reportOnce(error);
        yield* fallbackSegments(text);
      }
    },
    containing(codeUnitIndex: number) {
      const index = toIntegerOrInfinity(codeUnitIndex);
      if (!Number.isFinite(index) || index < 0 || index >= text.length) {
        return undefined;
      }
      try {
        let chosen: SegmentItem | undefined;
        for (const item of iterateGraphemes(segmenter, text, original)) {
          if (item.index > index) break;
          chosen = item;
        }
        return chosen;
      } catch (error) {
        reportOnce(error);
        return fallbackSegments(text).containing(codeUnitIndex);
      }
    },
  } as Intl.Segments;
}

/**
 * Install once per process. Safe to call from several extensions and after
 * `/reload`. Existing Segmenter instances pick this up because they call
 * `prototype.segment` at measurement time, not construction time.
 */
export function installSegmenterSafety(): void {
  if (state[INSTALL_KEY]) return;

  const prototype = Intl.Segmenter.prototype;
  const original = prototype.segment;
  if (typeof original !== "function") {
    state[INSTALL_KEY] = true;
    return;
  }

  prototype.segment = function segmentSafe(
    this: Intl.Segmenter,
    input: unknown,
  ): Intl.Segments {
    const text = safeString(input);
    let granularity = "grapheme";
    try {
      granularity = this.resolvedOptions().granularity;
    } catch {
      granularity = "grapheme";
    }

    // Word/sentence stay native so `isWordLike` and editor word-nav survive.
    // Still wrap the result so a non-string `segment` cannot reach codePointAt.
    if (granularity !== "grapheme") {
      try {
        return wrapNativeSegments(callNative(this, text, original), text);
      } catch (error) {
        reportOnce(error);
        return fallbackSegments(text);
      }
    }

    try {
      return segmentGraphemes(this, text, original);
    } catch (error) {
      reportOnce(error);
      return fallbackSegments(text);
    }
  };

  state[INSTALL_KEY] = true;
}

export function isSegmenterSafetyInstalled(): boolean {
  return state[INSTALL_KEY] === true;
}
