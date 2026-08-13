import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  MAX_NATIVE_SEGMENT_CHARS,
  fallbackSegments,
  installSegmenterSafety,
  isSegmenterSafetyInstalled,
  recentNativeSegmentLengths,
} from "../lib/segmenter-safety.ts";

const require = createRequire(import.meta.url);
const { findWordBackward, findWordForward } = require(
  "@earendil-works/pi-tui/dist/word-navigation.js",
) as {
  findWordBackward: (text: string, cursor: number) => number;
  findWordForward: (text: string, cursor: number) => number;
};

installSegmenterSafety();

describe("segmenter safety", () => {
  it("installs once and stays installed", () => {
    installSegmenterSafety();
    installSegmenterSafety();
    assert.equal(isSegmenterSafetyInstalled(), true);
  });

  it("coerces non-string input instead of throwing", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const pieces = [...segmenter.segment(12345 as unknown as string)].map(
      (item) => item.segment,
    );
    assert.equal(pieces.join(""), "12345");
  });

  it("matches native graphemes on ordinary text", () => {
    const text = "hello ── ✓ world";
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const got = [...segmenter.segment(text)].map((item) => item.segment);
    assert.equal(got.join(""), text);
  });

  it("chunks huge grapheme strings and never hands ICU more than the cap plus lookahead", () => {
    const text = `${"α".repeat(MAX_NATIVE_SEGMENT_CHARS + 512)}✓`;
    const before = recentNativeSegmentLengths().length;
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const items = [...segmenter.segment(text)];
    assert.equal(items.map((item) => item.segment).join(""), text);
    assert.equal(items[0]?.index, 0);
    assert.equal(items.at(-1)?.segment, "✓");
    assert.equal(items.at(-1)?.index, text.length - 1);
    assert.equal(segmenter.segment(text).containing(100)?.segment, "α");
    const after = recentNativeSegmentLengths().slice(before);
    assert.ok(after.length > 0);
    assert.ok(after.every((length) => length <= MAX_NATIVE_SEGMENT_CHARS + 32));
    assert.ok(after.some((length) => length <= MAX_NATIVE_SEGMENT_CHARS + 32));
  });

  it("containing() matches native out-of-range behavior", () => {
    assert.equal(fallbackSegments("").containing(0), undefined);
    const segs = fallbackSegments("ab");
    assert.equal(segs.containing(0)?.segment, "a");
    assert.equal(segs.containing(1)?.segment, "b");
    assert.equal(segs.containing(-1), undefined);
    assert.equal(segs.containing(2), undefined);
    assert.equal(segs.containing(99), undefined);
    assert.equal(segs.containing(Number.POSITIVE_INFINITY), undefined);
    assert.equal(segs.containing(Number.NEGATIVE_INFINITY), undefined);
  });

  it("lets pi-tui measure and clip a pathological Unicode line", () => {
    const line = `${"─".repeat(12_000)}✓${"░".repeat(4_000)}`;
    assert.ok(visibleWidth(line) > 80);
    const clipped = truncateToWidth(line, 80);
    assert.equal(typeof clipped, "string");
    assert.ok(visibleWidth(clipped) <= 80);
  });

  it("preserves word-nav isWordLike and does not wrap word ICU through the cap", () => {
    const words = new Intl.Segmenter(undefined, { granularity: "word" });
    const sample = "foo.bar can't-stop path/to-file";
    const items = [...words.segment(sample)];
    assert.ok(items.some((item) => item.isWordLike === true));
    assert.ok(items.some((item) => item.isWordLike === false));
    assert.equal(findWordForward(sample, 0), 3);
    assert.equal(findWordBackward(sample, 7), 4);

    const wordText = `one two ${"x".repeat(MAX_NATIVE_SEGMENT_CHARS + 20)} three`;
    const before = recentNativeSegmentLengths().length;
    const wordItems = [...words.segment(wordText)];
    assert.equal(wordItems.map((item) => item.segment).join(""), wordText);
    assert.equal(wordItems[0]?.segment, "one");
    assert.equal(wordItems.at(-1)?.segment, "three");
    const after = recentNativeSegmentLengths().slice(before);
    assert.ok(after.includes(wordText.length));
  });

  it("does not split ZWJ, flags, combining marks, or CRLF at the cap", () => {
    const zwj = "👩‍💻";
    const flag = "🇺🇸";
    const combining = "a\u0301";
    const crlf = "\r\n";
    const prefix = "a".repeat(MAX_NATIVE_SEGMENT_CHARS - 1);
    const cases = [
      { label: "zwj", cluster: zwj },
      { label: "flag", cluster: flag },
      { label: "combining", cluster: combining },
      { label: "crlf", cluster: crlf },
    ];
    const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const item of cases) {
      const isolatedWidth = visibleWidth(item.cluster);
      const text = `${prefix}${item.cluster}bbbb`;
      const parts = [...graphemes.segment(text)];
      assert.equal(parts.map((part) => part.segment).join(""), text, item.label);
      assert.ok(
        parts.some((part) => part.segment === item.cluster),
        `${item.label} stayed one cluster`,
      );
      assert.equal(
        visibleWidth(item.cluster),
        isolatedWidth,
        `${item.label} width`,
      );
    }
  });
});
