import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAUDE_INDICATOR_FRAME_COUNT,
  CLAUDE_WORKING_INTERVAL_MS,
  CLAUDE_WORKING_MESSAGES,
  CLAUDE_WORKING_MOTIFS,
  CLAUDE_WORKING_WEIGHTS,
  HAL_DEFAULT_CANDIDATE,
  HAL_INDICATOR_CANDIDATES,
  HAL_WORKING_MESSAGES,
  RANDOM_INDICATOR_FRAME_COUNT,
  RANDOM_INDICATOR_INTERVAL_MS,
  WORKING_MESSAGES,
  buildWorkingIndicator,
  claudeWorkingTonesFor,
} from "../apex-ui.ts";
import { SKIN_ENV_VAR } from "../internal/presentation/skin.ts";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";

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

const EXPECTED_MOTIFS: Record<string, string[]> = {
  pulse: ["✼", "✻", "✽", "✺", "✽", "✻"],
  twinkle: ["✻", "✽", "✻", "✼", "✺", "✼"],
  bloom: ["✼", "✾", "✻", "✾"],
  flash: ["✺", "✽", "✺", "✻"],
};

describe("working indicator skins", () => {
  it("draws the HAL label from its own mission-control pool and varies it", () => {
    withSkin("hal", () => {
      assert.ok(HAL_WORKING_MESSAGES.length >= 18, "pool has room to vary");
      for (const phrase of HAL_WORKING_MESSAGES) {
        assert.match(phrase, /^[A-Za-z ]+$/, `plain ASCII wording, saw ${JSON.stringify(phrase)}`);
        assert.ok(phrase.length <= 22, `short enough to not wrap, saw ${JSON.stringify(phrase)}`);
      }
      assert.equal(new Set(HAL_WORKING_MESSAGES).size, HAL_WORKING_MESSAGES.length, "no duplicates");
      const first = buildWorkingIndicator(stubCtx(), stubPi());
      assert.match(first.message, /\.\.\.$/);
      assert.ok(
        HAL_WORKING_MESSAGES.includes(first.message.replace(/\.\.\.$/, "")),
        `hal label drawn from HAL_WORKING_MESSAGES, saw ${JSON.stringify(first.message)}`,
      );
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        seen.add(buildWorkingIndicator(stubCtx(), stubPi()).message);
      }
      assert.ok(seen.size > 1, "hal label varies across runs");
    });
  });

  it("keeps every HAL candidate frame at one visible width (anti-jitter)", () => {
    // Regression test for the old mixed-family square: U+25A1/U+25A7/U+25A0
    // changed ink volume and box metrics per frame, so the mark shifted
    // instead of animating. Every frame of every candidate must measure the
    // same once ANSI styling is discounted.
    assert.ok(HAL_INDICATOR_CANDIDATES.length >= 4, "offers real options");
    for (const candidate of HAL_INDICATOR_CANDIDATES) {
      const frames = candidate.build(stubCtx(), "thinkingHigh");
      assert.ok(frames.length > 0, `${candidate.name}: non-empty`);
      const widths = new Set(frames.map((frame) => safeVisibleWidth(frame)));
      assert.equal(widths.size, 1, `${candidate.name}: frames share one width`);
      for (const frame of frames) {
        assert.doesNotMatch(frame, /\p{Extended_Pictographic}/u, `${candidate.name}: ${frame}`);
      }
    }
  });

  it("carries the thinking level in every HAL candidate", () => {
    for (const candidate of HAL_INDICATOR_CANDIDATES) {
      for (const level of ["low", "high"]) {
        const seen: string[] = [];
        const ctx = stubCtx((key, text) => {
          seen.push(key);
          return text;
        });
        const lead = level === "low" ? "thinkingLow" : "thinkingHigh";
        candidate.build(ctx, lead);
        assert.ok(seen.includes(lead), `${candidate.name}: ${level} run carries ${lead}`);
      }
    }
    // End to end: different thinking levels produce different lead tones in
    // the wired default's frames.
    withSkin("hal", () => {
      const tonesFor = (level: string): Set<string> => {
        const seen = new Set<string>();
        buildWorkingIndicator(
          stubCtx((key, text) => {
            seen.add(key);
            return text;
          }),
          stubPi(level),
        );
        return seen;
      };
      assert.ok(tonesFor("low").has("thinkingLow"), "low run carries thinkingLow");
      assert.ok(tonesFor("high").has("thinkingHigh"), "high run carries thinkingHigh");
      assert.ok(!tonesFor("low").has("thinkingHigh"), "low run never carries thinkingHigh");
    });
  });

  it("keeps a working HAL default wired to one named candidate", () => {
    const candidate = HAL_INDICATOR_CANDIDATES.find((entry) => entry.name === HAL_DEFAULT_CANDIDATE);
    assert.ok(candidate, `default ${JSON.stringify(HAL_DEFAULT_CANDIDATE)} names a registry entry`);
    withSkin("hal", () => {
      const built = buildWorkingIndicator(stubCtx(), stubPi());
      assert.equal(built.frames.length, candidate!.build(stubCtx(), "thinkingMedium").length);
      assert.equal(built.intervalMs, candidate!.intervalMs);
      assert.ok(new Set(built.frames).size > 1, "default animates");
    });
  });

  it("keeps every motif inside the asterisk family", () => {
    assert.equal(CLAUDE_WORKING_MOTIFS.length, 4);
    for (const motif of CLAUDE_WORKING_MOTIFS) {
      for (const glyph of motif.glyphs) {
        const code = glyph.codePointAt(0)!;
        assert.ok(
          code >= 0x273a && code <= 0x273e,
          `${motif.name}: ${glyph} outside U+273A-U+273E`,
        );
      }
    }
    // Regression guard for the rejected BLACK STAR family: none of its
    // codepoints may appear in any motif or in the weights table.
    const all = CLAUDE_WORKING_MOTIFS.flatMap((m) => m.glyphs).join("");
    for (const glyph of ["\u2736", "\u2737", "\u2738", "\u2739"]) {
      assert.ok(!all.includes(glyph), `BLACK STAR ${glyph} still present`);
      assert.equal(CLAUDE_WORKING_WEIGHTS[glyph], undefined, `weight for ${glyph}`);
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

  it("chains motifs within a single run with a per-run Claude verb label", () => {
    withSkin("claude", () => {
      const first = buildWorkingIndicator(stubCtx(), stubPi());
      assert.equal(first.frames.length, CLAUDE_INDICATOR_FRAME_COUNT);
      assert.equal(CLAUDE_INDICATOR_FRAME_COUNT, 128);
      assert.equal(first.intervalMs, 180);
      assert.equal(CLAUDE_WORKING_INTERVAL_MS, 180);
      // The label is one verb phrase per build, drawn from the Claude-code
      // verb pool; the message is set once per run and never rotated mid-run.
      assert.ok(
        CLAUDE_WORKING_MESSAGES.includes(first.message.replace(/\.\.\.$/, "")),
        `claude label drawn from CLAUDE_WORKING_MESSAGES, saw ${JSON.stringify(first.message)}`,
      );
      // The pool varies across runs instead of fixing on one phrase.
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        seen.add(buildWorkingIndicator(stubCtx(), stubPi()).message);
      }
      assert.ok(seen.size > 1, "claude label varies across runs");
      // Alternation within the run: more distinct glyphs than any one
      // motif holds (4), plus the bloom signature ✾ shows up.
      const distinct = new Set(first.frames);
      const mostDistinct = Math.max(
        ...CLAUDE_WORKING_MOTIFS.map((m) => new Set(m.glyphs).size),
      );
      assert.ok(
        distinct.size > mostDistinct,
        `frames alternate motifs: ${[...distinct].join(" ")}`,
      );
      assert.ok(first.frames.includes("✾"), "bloom motif appears in the chain");
      // No rejected-family glyph leaks into the chained frames either.
      for (const frame of first.frames) {
        const code = frame.codePointAt(0)!;
        assert.ok(code < 0x2736 || code > 0x2739, `BLACK STAR in chain: ${frame}`);
        assert.doesNotMatch(frame, /\p{Extended_Pictographic}/u, frame);
      }
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

  it("tracks tone to glyph weight on a 6-frame and a 4-frame motif", () => {
    const pulse = CLAUDE_WORKING_MOTIFS.find((m) => m.name === "pulse")!;
    const bloom = CLAUDE_WORKING_MOTIFS.find((m) => m.name === "bloom")!;
    assert.equal(pulse.glyphs.length, 6);
    assert.equal(bloom.glyphs.length, 4);
    assert.deepEqual(claudeWorkingTonesFor(pulse.glyphs, "thinkingHigh"), [
      "dim",
      "muted",
      "muted",
      "thinkingHigh",
      "muted",
      "muted",
    ]);
    assert.deepEqual(claudeWorkingTonesFor(bloom.glyphs, "thinkingHigh"), [
      "dim",
      "thinkingHigh",
      "thinkingHigh",
      "thinkingHigh",
    ]);
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
    // End to end through the builder: every recorded tone matches the
    // weight-derived tone for its own glyph, whatever motif was picked.
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
      for (const [key, text] of framePairs) {
        assert.ok(
          CLAUDE_WORKING_WEIGHTS[text] !== undefined,
          `frame glyph has a weight: ${text}`,
        );
        // Tones normalize per motif, so a glyph may carry a different tone
        // in different chain segments; it must always be one the helper
        // produces for a motif containing that glyph.
        const allowed = new Set<string>();
        for (const motif of CLAUDE_WORKING_MOTIFS) {
          if (!motif.glyphs.includes(text)) continue;
          const tones = claudeWorkingTonesFor(motif.glyphs, "thinkingHigh");
          motif.glyphs.forEach((glyph, index) => {
            if (glyph === text) allowed.add(tones[index]);
          });
        }
        assert.ok(allowed.size > 0, `${text} belongs to a motif`);
        assert.ok(allowed.has(key), `${text} carries tone ${key}`);
      }
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

  it("keeps the claude verb pool narrow, plain-text, and gerund-shaped", () => {
    assert.ok(CLAUDE_WORKING_MESSAGES.length >= 8, "pool has room to vary");
    assert.ok(CLAUDE_WORKING_MESSAGES.includes("Thinking"), "keeps the prior default");
    for (const verb of CLAUDE_WORKING_MESSAGES) {
      assert.match(verb, /^[A-Za-z]+ing$/, `plain ASCII gerund, saw ${JSON.stringify(verb)}`);
      assert.doesNotMatch(verb, /[\u0080-\uFFFF]/, `no non-ASCII, saw ${JSON.stringify(verb)}`);
    }
    assert.equal(new Set(CLAUDE_WORKING_MESSAGES).size, CLAUDE_WORKING_MESSAGES.length, "no duplicates");
  });
});
