import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boundExpandedCardText,
  EXPANDED_CARD_MAX_CHARS,
  EXPANDED_CARD_MAX_LINE_CHARS,
  EXPANDED_CARD_MAX_LINES,
} from "../text-bounds.ts";

describe("boundExpandedCardText", () => {
  it("leaves short output unchanged", () => {
    const input = "hello\nworld";
    assert.deepEqual(boundExpandedCardText(input), {
      text: input,
      truncated: false,
    });
  });

  it("caps total characters, line count, and long single-line runs from the start", () => {
    const hugeLine = "x".repeat(EXPANDED_CARD_MAX_LINE_CHARS + 50);
    const manyLines = Array.from(
      { length: EXPANDED_CARD_MAX_LINES + 20 },
      (_, i) => `line-${i}`,
    ).join("\n");
    const hugeChars = "a".repeat(EXPANDED_CARD_MAX_CHARS + 100);

    const lineBound = boundExpandedCardText(hugeLine);
    assert.equal(lineBound.truncated, true);
    assert.equal(lineBound.text.length, EXPANDED_CARD_MAX_LINE_CHARS);
    assert.ok(!lineBound.text.includes("x".repeat(EXPANDED_CARD_MAX_LINE_CHARS + 1)));

    const linesBound = boundExpandedCardText(manyLines);
    assert.equal(linesBound.truncated, true);
    assert.equal(linesBound.text.split("\n").length, EXPANDED_CARD_MAX_LINES);
    assert.ok(linesBound.text.startsWith("line-0"));
    assert.ok(!linesBound.text.includes(`line-${EXPANDED_CARD_MAX_LINES}`));

    const charsBound = boundExpandedCardText(hugeChars);
    assert.equal(charsBound.truncated, true);
    assert.ok(charsBound.text.length <= EXPANDED_CARD_MAX_CHARS);
    assert.ok(charsBound.text.startsWith("aaa"));
  });

  it("keeps more expanded capacity than a collapsed 12-line preview", () => {
    const body = Array.from({ length: 30 }, (_, i) => `report ${i}`).join("\n");
    const collapsed = boundExpandedCardText(body, { maxLines: 12 });
    const expanded = boundExpandedCardText(body, { maxLines: 40 });
    assert.equal(collapsed.text.split("\n").length, 12);
    assert.equal(expanded.text.split("\n").length, 30);
    assert.ok(expanded.text.length > collapsed.text.length);
  });

  it("keeps the tail of async latest-text previews", () => {
    const body = Array.from({ length: 20 }, (_, i) => `step-${i}`).join("\n");
    const preview = boundExpandedCardText(body, {
      maxChars: 2_400,
      maxLines: 8,
      keep: "tail",
    });
    assert.equal(preview.truncated, true);
    assert.equal(preview.text.split("\n").length, 8);
    assert.ok(preview.text.startsWith("step-12"));
    assert.ok(preview.text.endsWith("step-19"));
    assert.ok(!preview.text.includes("step-0"));
  });

  it("does not split surrogate pairs at total or per-line caps", () => {
    const emoji = "\uD83D\uDE00";
    const headTotal = boundExpandedCardText(`${emoji}abc`, { maxChars: 1 });
    assert.equal(headTotal.truncated, true);
    assert.equal(headTotal.text, "");
    assert.equal(headTotal.text.length, 0);

    const tailTotal = boundExpandedCardText(`abc${emoji}`, {
      maxChars: 1,
      keep: "tail",
    });
    assert.equal(tailTotal.truncated, true);
    assert.equal(tailTotal.text, "");

    const headLine = boundExpandedCardText(`${emoji}xyz`, { maxLineChars: 1 });
    assert.equal(headLine.truncated, true);
    assert.equal(headLine.text, "");

    const tailLine = boundExpandedCardText(`xyz${emoji}`, {
      maxLineChars: 1,
      keep: "tail",
    });
    assert.equal(tailLine.truncated, true);
    assert.equal(tailLine.text, "");

    const keepPairHead = boundExpandedCardText(`${emoji}x`, { maxChars: 2 });
    assert.equal(keepPairHead.text, emoji);

    const keepPairTail = boundExpandedCardText(`x${emoji}`, {
      maxChars: 2,
      keep: "tail",
    });
    assert.equal(keepPairTail.text, emoji);
  });
});
