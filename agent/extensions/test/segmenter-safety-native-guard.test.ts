import assert from "node:assert/strict";
import { describe, it } from "node:test";

const realNative = Intl.Segmenter.prototype.segment;
Intl.Segmenter.prototype.segment = function throwingNativeSegment() {
  throw new Error("native segmenter invoked");
};
void realNative;

const { installSegmenterSafety, recentNativeSegmentLengths } = await import(
  "../lib/segmenter-safety.ts"
);
installSegmenterSafety();

const { truncateToWidth, visibleWidth } = await import("@earendil-works/pi-tui");

describe("segmenter safety native guard", () => {
  it("default grapheme path never calls native ICU", () => {
    const text = "🇺🇸👩‍💻hello ── ✓";
    const pieces = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        text,
      ),
    ].map((item) => item.segment);
    assert.equal(pieces.join(""), text);
    assert.ok(pieces.includes("🇺🇸"));
    assert.ok(pieces.includes("👩‍💻"));

    const line = "─".repeat(400) + "👩‍💻🇺🇸";
    assert.ok(visibleWidth(line) > 0);
    const clipped = truncateToWidth(line, 80);
    assert.equal(typeof clipped, "string");
    assert.ok(visibleWidth(clipped) <= 80);

    assert.deepEqual([...recentNativeSegmentLengths()], []);
  });
});
