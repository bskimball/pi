import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAUDE_WORKING_INTERVAL_MS,
  CLAUDE_WORKING_MESSAGE,
  CLAUDE_WORKING_MOTIFS,
  CLAUDE_WORKING_WEIGHTS,
  RANDOM_INDICATOR_FRAME_COUNT,
  RANDOM_INDICATOR_INTERVAL_MS,
  WORKING_MESSAGES,
  buildWorkingIndicator,
  claudeWorkingTonesFor,
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

function familyOf(glyph: string): "BLACK" | "ASTERISK" {
  const code = glyph.codePointAt(0)!;
  if (code >= 0x2736 && code <= 0x2739) return "BLACK";
  return "ASTERISK";
}

const EXPECTED_MOTIFS: Record<string, string[]> = {
  pulse: ["✼", "✻", "✽", "✺", "✽", "✻"],
  twinkle: ["✻", "✽", "✻", "✼", "✺", "✼"],
  bloom: ["✼", "✾", "✻", "✾"],
  flash: ["✺", "✽", "✺", "✻"],
  spin: ["✶", "✷", "✸", "✹", "✸", "✷"],
  spinRev: ["✹", "✸", "✷", "✶", "✷", "✸"],
  beat: ["✶", "✸", "✶", "✹"],
};

describe("working indicator skins", () => {
  it("locks every motif to a single star family", () => {
    assert.equal(CLAUDE_WORKING_MOTIFS.length, 7);
    for (const motif of CLAUDE_WORKING_MOTIFS) {
      const families = new Set(motif.glyphs.map(familyOf));
      assert.equal(
        families.size,
        1,
        `${motif.name} mixes families: ${motif.glyphs.join(" ")}`,
      );
    }
    // BLACK STAR motifs use only U+2736-U+2739, ASTERISK only U+273A-U+273E.
    for (const name of ["spin", "spinRev", "beat"]) {
      const motif = CLAUDE_WORKING_MOTIFS.find((m) => m.name === name)!;
      assert.ok(motif, `${name} defined`);
      for (const glyph of motif.glyphs) {
        const code = glyph.codePointAt(0)!;
        assert.ok(code >= 0x2736 && code <= 0x2739, `${name}: ${glyph}`);
      }
    }
    for (const name of ["pulse", "twinkle", "bloom", "flash"]) {
      const motif = CLAUDE_WORKING_MOTIFS.find((m) => m.name === name)!;
      assert.ok(motif, `${name} defined`);
      for (const glyph of motif.glyphs) {
        const code = glyph.codePointAt(0)!;
        assert.ok(code >= 0x273a && code <= 0x273e, `${name}: ${glyph}`);
      }
    }
  });

  it("defines each motif's exact glyph sequence", () => {
    assert.deepEqual(
      Object.fromEntries(CLAUDE_WORKING_MOTIFS.map((m) => [m.name, m.glyphs])),
      EXPECTED_MOTIFS,
    );
  });

  it("keeps every motif free of Extended_Pictographic codepoints", () => {
    const all = CLAUDE_WORKING_MOTIFS.flatMap((m) => m.glyphs).join("");
    assert.doesNotMatch(all, /✳/, "U+2733 must not appear");
    assert.doesNotMatch(all, /✴/, "U+2734 must not appear");
    for (const motif of CLAUDE_WORKING_MOTIFS) {
      for (const glyph of motif.glyphs) {
        assert.doesNotMatch(glyph, /\p{Extended_Pictographic}/u, glyph);
      }
    }
  });

  it("returns one defined motif per run with a steady label", () => {
    withSkin("claude", () => {
      const first = buildWorkingIndicator(stubCtx(), stubPi());
      const match = CLAUDE_WORKING_MOTIFS.find(
        (m) =>
          m.glyphs.length === first.frames.length &&
          m.glyphs.every((glyph, index) => first.frames[index] === glyph),
      );
      assert.ok(match, `frames match a defined motif: ${first.frames.join(" ")}`);
      assert.equal(first.intervalMs, 180);
      assert.equal(CLAUDE_WORKING_INTERVAL_MS, 180);
      assert.equal(first.message, `${CLAUDE_WORKING_MESSAGE}...`);
      // The label never varies across runs: no random pool pick.
      const second = buildWorkingIndicator(stubCtx(), stubPi());
      assert.equal(second.message, first.message);
    });
  });

  it("covers every motif glyph in the weight table", () => {
    for (const motif of CLAUDE_WORKING_MOTIFS) {
      for (const glyph of motif.glyphs) {
        assert.ok(
          CLAUDE_WORKING_WEIGHTS[glyph] !== undefined,
          `${motif.name}: ${glyph} missing a weight`,
        );
      }
    }
    // Unknown glyphs fail loudly instead of flattening the pulse.
    assert.throws(() => claudeWorkingTonesFor(["?"], "thinkingHigh"));
  });

  it("tracks tone to glyph weight on every motif", () => {
    for (const motif of CLAUDE_WORKING_MOTIFS) {
      const tones = claudeWorkingTonesFor(motif.glyphs, "thinkingHigh");
      const weights = motif.glyphs.map((glyph) => CLAUDE_WORKING_WEIGHTS[glyph]);
      const max = Math.max(...weights);
      const min = Math.min(...weights);
      motif.glyphs.forEach((glyph, index) => {
        if (CLAUDE_WORKING_WEIGHTS[glyph] === max) {
          assert.equal(tones[index], "thinkingHigh", `${motif.name}[${index}] ${glyph}`);
        } else if (CLAUDE_WORKING_WEIGHTS[glyph] === min) {
          assert.equal(tones[index], "dim", `${motif.name}[${index}] ${glyph}`);
        } else {
          assert.equal(tones[index], "muted", `${motif.name}[${index}] ${glyph}`);
        }
      });
    }
    // The exact inversion being fixed: spinRev opens on its heaviest glyph.
    const spinRev = CLAUDE_WORKING_MOTIFS.find((m) => m.name === "spinRev")!;
    assert.equal(spinRev.glyphs[0], "✹");
    assert.equal(claudeWorkingTonesFor(spinRev.glyphs, "thinkingHigh")[0], "thinkingHigh");
    // End to end through the builder: the recorded tones match the helper
    // applied to whichever motif was picked.
    withSkin("claude", () => {
      const pairs: Array<[string, string]> = [];
      const built = buildWorkingIndicator(
        stubCtx((key, text) => {
          pairs.push([key, text]);
          return text;
        }),
        stubPi("high"),
      );
      // The stub also records the dim label call after the frames.
      const framePairs = pairs.slice(0, built.frames.length);
      const motif = CLAUDE_WORKING_MOTIFS.find((m) =>
        m.glyphs.every((glyph, index) => framePairs[index]?.[1] === glyph),
      );
      assert.ok(motif, `frames match a defined motif: ${built.frames.join(" ")}`);
      assert.deepEqual(
        framePairs.map(([key]) => key),
        claudeWorkingTonesFor(motif!.glyphs, "thinkingHigh"),
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
});
