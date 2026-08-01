import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  characterOf,
  externalToLsp,
  fromLspPosition,
  offsetOf,
  toLspPosition,
} from "../positions.ts";

describe("positions", () => {
  it("converts 1-based external to 0-based LSP", () => {
    assert.deepEqual(toLspPosition(1, 1), { line: 0, character: 0 });
    assert.deepEqual(toLspPosition(3, 5), { line: 2, character: 4 });
    assert.deepEqual(fromLspPosition({ line: 2, character: 4 }), { line: 3, column: 5 });
  });

  it("handles emoji (surrogate pairs) for utf-16 vs utf-32", () => {
    // 😀 is one code point, two UTF-16 code units, four UTF-8 bytes
    const text = "a😀b\nnext";
    // Line 0: a (1 utf16) + 😀 (2) + b (1) = length 4
    assert.equal(offsetOf(text, 0, 0, "utf-16"), 0);
    assert.equal(offsetOf(text, 0, 1, "utf-16"), 1);
    assert.equal(offsetOf(text, 0, 3, "utf-16"), 3); // after emoji
    assert.equal(offsetOf(text, 0, 4, "utf-16"), 4); // after b

    assert.equal(offsetOf(text, 0, 0, "utf-32"), 0);
    assert.equal(offsetOf(text, 0, 1, "utf-32"), 1); // after a
    assert.equal(offsetOf(text, 0, 2, "utf-32"), 3); // after emoji (2 code units)
    assert.equal(offsetOf(text, 0, 3, "utf-32"), 4); // after b

    assert.equal(characterOf(text, 0, 3, "utf-16"), 3);
    assert.equal(characterOf(text, 0, 3, "utf-32"), 2);
    assert.equal(characterOf(text, 0, 3, "utf-8"), 1 + 4); // a + emoji bytes
  });

  it("externalToLsp converts editor utf-16 columns into server encoding", () => {
    const text = "a😀b";
    // User points at column 4 (1-based) = after emoji in utf-16 terms → JS index 3
    const utf16 = externalToLsp(text, 1, 4, "utf-16");
    assert.deepEqual(utf16, { line: 0, character: 3 });

    const utf32 = externalToLsp(text, 1, 4, "utf-32");
    assert.deepEqual(utf32, { line: 0, character: 2 });

    const utf8 = externalToLsp(text, 1, 4, "utf-8");
    assert.deepEqual(utf8, { line: 0, character: 5 }); // a(1)+emoji(4)
  });

  it("offsetOf finds next line start", () => {
    const text = "one\ntwo\nthree";
    assert.equal(offsetOf(text, 1, 0, "utf-16"), 4);
    assert.equal(offsetOf(text, 2, 2, "utf-16"), 10); // "th" of three → index 8+2
  });
});
