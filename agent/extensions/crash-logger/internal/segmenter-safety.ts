// Process-wide shield around `Intl.Segmenter`.
//
// Pi TUI measures every compositor line with a shared Segmenter
// (`visibleWidth` / `truncateToWidth` / alt-screen clip). On Windows the
// native ICU grapheme path can abort the Node process — no JS exception,
// no agent/logs/pi-crash.log — and leave the parent shell in raw/mouse mode.
//
// Default grapheme segmentation is a JS extended-grapheme scan and never
// calls native ICU. Word/sentence stay native so editor Ctrl/Alt word
// movement keeps `isWordLike`. Set PI_SEGMENTER_NATIVE=1 to force native
// grapheme calls for diagnostics only. Every yielded `segment` is a real
// string (the historical `segment.codePointAt is not a function` failure).
//
// Grapheme and fallback results are lazy Intl.Segments: they re-scan per
// iterator() / containing() and never materialize an items[] of every
// cluster. Eager arrays OOMed the compositor on 100k+ nearly-ASCII jsonl.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeLastPhase } from "./last-phase.ts";

const INSTALL_KEY = Symbol.for("pi.segmenterSafety.installed");
const state = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean };

type SegmentItem = Intl.SegmentData;
type SegmentFn = (input: string) => Intl.Segments;

const nativeCallLengths: number[] = [];
let reportedNativeFailure = false;
let nativeGraphemeOptIn = false;
let lastGraphemeYieldCount = 0;
let lastLargeInputLogAt = 0;
let largeInputCount = 0;

const MARK_RE = /\p{M}/u;
const EXT_PICT_RE = /\p{Extended_Pictographic}/u;

const CP_CR = 0x0d;
const CP_LF = 0x0a;
const CP_ZWJ = 0x200d;
const CP_VS15 = 0xfe0e;
const CP_VS16 = 0xfe0f;
const SKIN_TONE_MIN = 0x1f3fb;
const SKIN_TONE_MAX = 0x1f3ff;
const RI_MIN = 0x1f1e6;
const RI_MAX = 0x1f1ff;
const LARGE_INPUT_MIN = 32768;
const LARGE_INPUT_LOG_MS = 2000;
const LARGE_INPUT_LOG_MAX = 8;

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

/** Clusters yielded by the most recent iterateGraphemes / iterator / containing scan. */
export function recentGraphemeYieldCount(): number {
  return lastGraphemeYieldCount;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function renderLogPath(): string {
  return path.join(agentDir(), "logs", "pi-render.log");
}

function appendRenderLog(entry: string): void {
  const logPath = renderLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, entry, "utf8");
}

function reportOnce(error: unknown): void {
  if (reportedNativeFailure) return;
  reportedNativeFailure = true;
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  const entry = `\n=== segmenter-safety fallback at ${new Date().toISOString()} ===\n${message}\n`;
  try {
    appendRenderLog(entry);
  } catch {
    // A safety net must never throw.
  }
}

let lastPhaseGran: string | undefined;
let lastPhaseBucket = -1;
const PHASE_INPUT_MIN = 4096;

function noteLargeInput(text: string, granularity: string): void {
  if (text.length >= PHASE_INPUT_MIN) {
    const bucket = Math.floor(text.length / PHASE_INPUT_MIN);
    if (granularity !== lastPhaseGran || bucket !== lastPhaseBucket) {
      lastPhaseGran = granularity;
      lastPhaseBucket = bucket;
      writeLastPhase(`segment gran=${granularity} len=${text.length}`);
    }
  }
  if (text.length < LARGE_INPUT_MIN) return;
  largeInputCount += 1;
  if (largeInputCount > LARGE_INPUT_LOG_MAX) return;
  const now = Date.now();
  if (now - lastLargeInputLogAt < LARGE_INPUT_LOG_MS) return;
  lastLargeInputLogAt = now;
  try {
    const mem = process.memoryUsage();
    const line =
      `segmenter-safety large-input at ${new Date().toISOString()} ` +
      `n=${largeInputCount} len=${text.length} gran=${granularity} ` +
      `heap=${mem.heapUsed} rss=${mem.rss}\n`;
    appendRenderLog(line);
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

function isCombiningMark(cp: number): boolean {
  return MARK_RE.test(String.fromCodePoint(cp));
}

function isExtendedPictographic(cp: number): boolean {
  return EXT_PICT_RE.test(String.fromCodePoint(cp));
}

function isExtend(cp: number): boolean {
  if (cp === CP_ZWJ || cp === CP_VS15 || cp === CP_VS16) return true;
  if (cp >= SKIN_TONE_MIN && cp <= SKIN_TONE_MAX) return true;
  return isCombiningMark(cp);
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= RI_MIN && cp <= RI_MAX;
}

function isHangulL(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c);
}

function isHangulV(cp: number): boolean {
  return (cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6);
}

function isHangulT(cp: number): boolean {
  return (cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb);
}

function hangulSyllableType(cp: number): "LV" | "LVT" | null {
  if (cp < 0xac00 || cp > 0xd7a3) return null;
  const sIndex = cp - 0xac00;
  return sIndex % 28 === 0 ? "LV" : "LVT";
}

function isHangulLBase(cp: number): boolean {
  return isHangulL(cp);
}

function isHangulLVOrV(cp: number): boolean {
  return isHangulV(cp) || hangulSyllableType(cp) === "LV";
}

function isHangulLVTOrT(cp: number): boolean {
  return isHangulT(cp) || hangulSyllableType(cp) === "LVT";
}

function isControlBreak(cp: number): boolean {
  return cp === CP_CR || cp === CP_LF;
}

function codePointWidth(cp: number): number {
  return cp > 0xffff ? 2 : 1;
}

function shouldExtend(
  prev: number,
  next: number,
  riOdd: boolean,
  inPictographSeq: boolean,
): boolean {
  if (isControlBreak(prev) || isControlBreak(next)) return false;
  // GB9: any Extend (ZWJ, VS, skin tone, combining marks) joins.
  if (isExtend(next)) return true;
  // GB11: EP Extend* ZWJ × Extended_Pictographic only.
  if (prev === CP_ZWJ && inPictographSeq && isExtendedPictographic(next)) {
    return true;
  }
  if (isRegionalIndicator(prev) && isRegionalIndicator(next) && riOdd) {
    return true;
  }
  // GB6: L × (L | V | LV | LVT)
  if (isHangulLBase(prev) && (isHangulL(next) || isHangulV(next) || hangulSyllableType(next))) {
    return true;
  }
  // GB7: (LV | V) × (V | T)
  if (isHangulLVOrV(prev) && (isHangulV(next) || isHangulT(next))) {
    return true;
  }
  // GB8: (LVT | T) × T
  if (isHangulLVTOrT(prev) && isHangulT(next)) {
    return true;
  }
  return false;
}

function* iterateCodePoints(text: string): Generator<SegmentItem> {
  lastGraphemeYieldCount = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const segment = String.fromCodePoint(codePoint);
    lastGraphemeYieldCount += 1;
    yield { segment, index, input: text };
    index += segment.length;
  }
}

function* iterateGraphemes(text: string): Generator<SegmentItem> {
  lastGraphemeYieldCount = 0;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const start = i;
    const first = text.codePointAt(i);
    if (first === undefined) break;
    i += codePointWidth(first);

    if (first === CP_CR) {
      const lf = text.codePointAt(i);
      if (lf === CP_LF) {
        i += 1;
      }
      lastGraphemeYieldCount += 1;
      yield { segment: text.slice(start, i), index: start, input: text };
      continue;
    }
    if (first === CP_LF) {
      lastGraphemeYieldCount += 1;
      yield { segment: text.slice(start, i), index: start, input: text };
      continue;
    }

    let last = first;
    let riOdd = isRegionalIndicator(first);
    let inPictographSeq = isExtendedPictographic(first);
    while (i < n) {
      const nextUnit = text.charCodeAt(i);
      // No Extend / ZWJ / RI / Hangul jamo / VS below U+0300.
      if (nextUnit < 0x0300) break;
      const next = text.codePointAt(i);
      if (next === undefined) break;
      if (!shouldExtend(last, next, riOdd, inPictographSeq)) break;
      i += codePointWidth(next);
      if (isExtendedPictographic(next)) {
        inPictographSeq = true;
      } else if (!isExtend(next)) {
        inPictographSeq = false;
      }
      if (isRegionalIndicator(next) && isRegionalIndicator(last) && riOdd) {
        riOdd = false;
      } else if (isRegionalIndicator(next)) {
        riOdd = true;
      } else if (!isExtend(next)) {
        riOdd = isRegionalIndicator(next);
      }
      last = next;
    }
    lastGraphemeYieldCount += 1;
    yield { segment: text.slice(start, i), index: start, input: text };
  }
}

function lazyFromGenerator(
  text: string,
  iterate: (input: string) => Generator<SegmentItem>,
): Intl.Segments {
  return {
    *[Symbol.iterator]() {
      yield* iterate(text);
    },
    containing(codeUnitIndex: number) {
      const index = toIntegerOrInfinity(codeUnitIndex);
      if (!Number.isFinite(index) || index < 0 || index >= text.length) {
        lastGraphemeYieldCount = 0;
        return undefined;
      }
      for (const item of iterate(text)) {
        if (index >= item.index && index < item.index + item.segment.length) {
          return item;
        }
      }
      return undefined;
    },
  } as Intl.Segments;
}

/** Code-point segments. Safe for terminal width; never calls ICU. */
export function fallbackSegments(text: string): Intl.Segments {
  return lazyFromGenerator(text, iterateCodePoints);
}

/**
 * JS extended-grapheme clusters. Never calls `Intl.Segmenter`.
 * Matches native UAX #29 well enough that pi-tui width is not doubled
 * for emoji ZWJ / flags / combining / Hangul.
 */
export function graphemeSegments(text: string): Intl.Segments {
  return lazyFromGenerator(text, iterateGraphemes);
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

/**
 * Install once per process. Safe to call from several extensions and after
 * `/reload`. Existing Segmenter instances pick this up because they call
 * `prototype.segment` at measurement time, not construction time.
 */
export function installSegmenterSafety(): void {
  if (state[INSTALL_KEY]) return;

  nativeGraphemeOptIn = process.env.PI_SEGMENTER_NATIVE === "1";

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

    noteLargeInput(text, granularity);

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

    if (nativeGraphemeOptIn) {
      try {
        return wrapNativeSegments(callNative(this, text, original), text);
      } catch (error) {
        reportOnce(error);
        return fallbackSegments(text);
      }
    }

    try {
      return graphemeSegments(text);
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
