import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAUDE_WORKING_GLYPHS,
  CLAUDE_WORKING_INTERVAL_MS,
  CLAUDE_WORKING_MESSAGE,
  RANDOM_INDICATOR_FRAME_COUNT,
  RANDOM_INDICATOR_INTERVAL_MS,
  WORKING_MESSAGES,
  buildWorkingIndicator,
  claudeWorkingToneAt,
} from "../apex-ui.ts";
import { SKIN_ENV_VAR } from "../internal/presentation/skin.ts";

function withSkin<T>(value: string | undefined, run: () => T): T {
  const previous = process.env[SKIN_ENV_VAR];
  if (value === undefined) delete process.env[SKIN_ENV_VAR];
  else process.env[SKIN_ENV_VAR] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[SKIN_ENV_VAR];
    else process.env[SKIN_ENV_VAR] = previous;
  }
}

// Identity theme keeps glyphs unwrapped; a recording theme observes the hue.
function stubCtx(
  fg: (key: string, text: string) => string = (_key, text) => text,
): any {
  return {
    hasUI: true,
    ui: { theme: { fg } },
  };
}

function stubPi(thinkingLevel = "medium"): any {
  return { getThinkingLevel: () => thinkingLevel };
}

describe("working indicator skins", () => {
  it("breathes a six-frame star pulse under the claude skin", () => {
    withSkin("claude", () => {
      const first = buildWorkingIndicator(stubCtx(), stubPi());
      assert.equal(first.frames.length, 6);
      assert.deepEqual([...CLAUDE_WORKING_GLYPHS], ["✶", "✻", "✽", "✺", "✽", "✻"]);
      assert.deepEqual(first.frames, ["✶", "✻", "✽", "✺", "✽", "✻"]);
      assert.equal(first.intervalMs, 180);
      assert.equal(CLAUDE_WORKING_INTERVAL_MS, 180);
      assert.equal(first.message, `${CLAUDE_WORKING_MESSAGE}...`);
      // The label never varies across runs: no random pool pick.
      const second = buildWorkingIndicator(stubCtx(), stubPi());
      assert.equal(second.message, first.message);
      assert.deepEqual(second.frames, first.frames);
    });
  });

  it("tracks tone to pulse weight on claude frames", () => {
    withSkin("claude", () => {
      const pairs: Array<[string, string]> = [];
      const built = buildWorkingIndicator(
        stubCtx((key, text) => {
          pairs.push([key, text]);
          return text;
        }),
        stubPi("high"),
      );
      // The stub also records the dim label call, so only the first six
      // pairs belong to the pulse frames.
      const framePairs = pairs.slice(0, 6);
      assert.deepEqual(
        framePairs.map(([, text]) => text),
        ["✶", "✻", "✽", "✺", "✽", "✻"],
      );
      assert.deepEqual(
        framePairs.map(([key]) => key),
        ["dim", "muted", "thinkingHigh", "thinkingHigh", "muted", "dim"],
      );
      assert.deepEqual(
        CLAUDE_WORKING_GLYPHS.map((_, index) =>
          claudeWorkingToneAt(index, "thinkingHigh"),
        ),
        ["dim", "muted", "thinkingHigh", "thinkingHigh", "muted", "dim"],
      );
      assert.ok(
        built.message.length > 0 && pairs.some(([key]) => key === "dim"),
        "label stays dim",
      );
    });
  });

  it("keeps the braille animation and random pool under apex and fallback skins", () => {
    for (const skin of [undefined, "apex", "banana"]) {
      withSkin(skin, () => {
        const built = buildWorkingIndicator(stubCtx(), stubPi());
        assert.equal(built.frames.length, RANDOM_INDICATOR_FRAME_COUNT);
        assert.equal(RANDOM_INDICATOR_FRAME_COUNT, 256);
        assert.equal(built.intervalMs, RANDOM_INDICATOR_INTERVAL_MS);
        assert.equal(built.intervalMs, 120);
        assert.match(built.message, /\.\.\.$/);
        assert.ok(
          WORKING_MESSAGES.includes(built.message.replace(/\.\.\.$/, "")),
          `apex label drawn from WORKING_MESSAGES, saw ${JSON.stringify(built.message)}`,
        );
      });
    }
  });

  it("keeps star frames free of Extended_Pictographic codepoints", () => {
    for (const frame of CLAUDE_WORKING_GLYPHS) {
      assert.doesNotMatch(frame, /\p{Extended_Pictographic}/u, frame);
    }
    withSkin("claude", () => {
      for (const frame of buildWorkingIndicator(stubCtx(), stubPi()).frames) {
        assert.doesNotMatch(frame, /\p{Extended_Pictographic}/u, frame);
      }
    });
  });
});
