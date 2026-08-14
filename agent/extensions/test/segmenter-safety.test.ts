import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  fallbackSegments,
  graphemeSegments,
  installSegmenterSafety,
  isSegmenterSafetyInstalled,
  recentGraphemeYieldCount,
  recentNativeSegmentLengths,
} from "../lib/segmenter-safety.ts";

const require = createRequire(import.meta.url);
const { findWordBackward, findWordForward } = require(
  "@earendil-works/pi-tui/dist/word-navigation.js",
) as {
  findWordBackward: (text: string, cursor: number) => number;
  findWordForward: (text: string, cursor: number) => number;
};

const nativeSegment = Intl.Segmenter.prototype.segment;
installSegmenterSafety();

function nativeGraphemes(text: string): string[] {
  const segs = nativeSegment.call(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }),
    text,
  );
  return [...segs].map((item) => item.segment);
}

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

  it("default grapheme path never records native ICU lengths", () => {
    const before = [...recentNativeSegmentLengths()];
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const text = `hello ── ✓ world ${"─".repeat(200)}👩‍💻🇺🇸`;
    const pieces = [...segmenter.segment(text)].map((item) => item.segment);
    assert.equal(pieces.join(""), text);
    assert.deepEqual([...recentNativeSegmentLengths()], before);
  });

  it("JS EGC reconstructs ordinary and huge strings", () => {
    const ordinary = "hello ── ✓ world";
    assert.equal(
      [...graphemeSegments(ordinary)].map((item) => item.segment).join(""),
      ordinary,
    );
    const huge = `${"─".repeat(12_000)}✓${"░".repeat(4_000)}`;
    const items = [...graphemeSegments(huge)];
    assert.equal(items.map((item) => item.segment).join(""), huge);
    assert.equal(items[0]?.index, 0);
    assert.equal(items.at(-1)?.segment, "░");
  });

  it("JS EGC equals native oracle clusters on a Unicode corpus", () => {
    const corpus = [
      "ASCII only",
      "漢字カタカナ한글",
      "hello ── ✓ world",
      "a\u0301",
      "line\r\nbreak",
      "👩‍💻",
      "👨‍👩‍👧",
      "🇺🇸",
      "❤️",
      "👍🏻",
      "한글",
      "각",
      "mix 👩‍💻 🇺🇸 a\u0301 각 ✓",
      "x\u200d y",
      "x\u200d👩",
      "x\u200d\u0301",
    ];
    for (const text of corpus) {
      const js = [...graphemeSegments(text)].map((item) => item.segment);
      const native = nativeGraphemes(text);
      assert.deepEqual(js, native, text);
    }
  });

  it("containing() matches fallback out-of-range and lands in the covering cluster", () => {
    assert.equal(fallbackSegments("").containing(0), undefined);
    const segs = fallbackSegments("ab");
    assert.equal(segs.containing(0)?.segment, "a");
    assert.equal(segs.containing(1)?.segment, "b");
    assert.equal(segs.containing(-1), undefined);
    assert.equal(segs.containing(2), undefined);
    assert.equal(segs.containing(99), undefined);
    assert.equal(segs.containing(Number.POSITIVE_INFINITY), undefined);
    assert.equal(segs.containing(Number.NEGATIVE_INFINITY), undefined);

    const text = "a👩‍💻b";
    const g = graphemeSegments(text);
    for (let i = 0; i < text.length; i++) {
      const hit = g.containing(i);
      assert.ok(hit, `index ${i}`);
      assert.ok(
        i >= hit.index && i < hit.index + hit.segment.length,
        `index ${i} covered by ${JSON.stringify(hit)}`,
      );
    }
  });

  it("lets pi-tui measure and clip a pathological Unicode line", () => {
    const line = `${"─".repeat(12_000)}✓${"░".repeat(4_000)}`;
    assert.ok(visibleWidth(line) > 80);
    const clipped = truncateToWidth(line, 80);
    assert.equal(typeof clipped, "string");
    assert.ok(visibleWidth(clipped) <= 80);
  });

  it("preserves word-nav isWordLike and still records native word lengths", () => {
    const words = new Intl.Segmenter(undefined, { granularity: "word" });
    const sample = "foo.bar can't-stop path/to-file";
    const items = [...words.segment(sample)];
    assert.ok(items.some((item) => item.isWordLike === true));
    assert.ok(items.some((item) => item.isWordLike === false));
    assert.equal(findWordForward(sample, 0), 3);
    assert.equal(findWordBackward(sample, 7), 4);

    const wordText = `one two ${"x".repeat(2068)} three`;
    const before = recentNativeSegmentLengths().length;
    const wordItems = [...words.segment(wordText)];
    assert.equal(wordItems.map((item) => item.segment).join(""), wordText);
    assert.equal(wordItems[0]?.segment, "one");
    assert.equal(wordItems.at(-1)?.segment, "three");
    const after = recentNativeSegmentLengths().slice(before);
    assert.ok(after.includes(wordText.length));
  });

  it("ZWJ does not glue a following space (GB11 is pictographic only)", () => {
    const text = "x\u200d y";
    const js = [...graphemeSegments(text)].map((item) => item.segment);
    const native = nativeGraphemes(text);
    assert.deepEqual(js, native);
    assert.deepEqual(js, ["x\u200d", " ", "y"]);
  });

  it("ZWJ after non-pictograph does not glue a following emoji (GB11 left context)", () => {
    const text = "x\u200d👩";
    const js = [...graphemeSegments(text)].map((item) => item.segment);
    const native = nativeGraphemes(text);
    assert.deepEqual(js, native);
    assert.deepEqual(js, ["x\u200d", "👩"]);
  });

  it("ZWJ still joins a following Extend via GB9", () => {
    const text = "x\u200d\u0301";
    const js = [...graphemeSegments(text)].map((item) => item.segment);
    const native = nativeGraphemes(text);
    assert.deepEqual(js, native);
    assert.equal(js.length, 1);
    assert.equal(js[0], text);
  });

  it("keeps ZWJ, flags, combining marks, and CRLF as one cluster vs native", () => {
    const cases = ["👩‍💻", "🇺🇸", "a\u0301", "\r\n", "👨‍👩‍👧", "❤️", "👍🏻"];
    for (const cluster of cases) {
      const js = [...graphemeSegments(cluster)].map((item) => item.segment);
      const native = nativeGraphemes(cluster);
      assert.deepEqual(js, native, cluster);
      assert.equal(js.length, 1, cluster);
      assert.equal(js[0], cluster);
    }
  });

  it("lazy containing() covers surrogate-pair and multi-unit clusters", () => {
    const cases = ["a👩‍💻b", "🇺🇸x", "a\u0301z", "\r\n"];
    for (const text of cases) {
      const g = graphemeSegments(text);
      for (let i = 0; i < text.length; i++) {
        const hit = g.containing(i);
        assert.ok(hit, `${text} index ${i}`);
        assert.ok(
          i >= hit.index && i < hit.index + hit.segment.length,
          `${text} index ${i} covered by ${JSON.stringify(hit)}`,
        );
      }
    }
  });

  it("graphemeSegments is re-iterable without materializing once", () => {
    const text = "mix 👩‍💻 🇺🇸 a\u0301 각 ✓";
    const first = [...graphemeSegments(text)].map((item) => item.segment);
    const segs = graphemeSegments(text);
    const a = [...segs].map((item) => item.segment);
    const b = [...segs].map((item) => item.segment);
    assert.deepEqual(a, first);
    assert.deepEqual(b, first);
    assert.equal(a.join(""), text);
  });

  it("truncateToWidth early-exits without yielding the whole line", () => {
    const text = "✓" + "x".repeat(80_000);
    const clipped = truncateToWidth(text, 40);
    assert.ok(recentGraphemeYieldCount() < 200);
    assert.ok(visibleWidth(clipped) <= 40);
  });

  it("full reconstruct of an 80k mixed string still works when fully iterated", () => {
    const text = "👩‍💻" + "x".repeat(40_000) + "a\u0301" + "─".repeat(20_000) + "🇺🇸";
    const items = [...graphemeSegments(text)];
    assert.equal(items.map((item) => item.segment).join(""), text);
    assert.ok(recentGraphemeYieldCount() > 60_000);
  });
});
