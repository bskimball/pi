// skin: glyph skins for Apex presentation.
//
// "apex" is the default skin and preserves the exact glyphs Apex has always
// used. "claude" swaps the receipt/composer glyphs toward a Claude Code look
// and squares the terminal tree edge (└─ instead of ╰─), keeping every other
// tree shape/key so existing call sites are unchanged.
// "hal" keeps Claude's continuation rail but squares off the terminal tree
// edge (└─ instead of ╰─) to match its square instrument glyphs.
// Claude header/receipt deliberately avoids Extended_Pictographic codepoints
// (e.g. U+23FA): the emoji font overrides theme color and misreports width.
//
// Selection reads PI_UI_SKIN dynamically at call time (never captured at
// module load), matching how PI_APEX_UI is re-read, so a live /ui switch
// takes effect without restart. Unset or unrecognized values fall back to
// the apex skin.

export const SKIN_ENV_VAR = "PI_UI_SKIN";

export type SkinName = "apex" | "claude" | "hal";

export interface SkinGlyphs {
  /** Active receipt root (tool-receipt headers, TREE.header). */
  header: string;
  /** Tree branch (TREE.branch). */
  branch: string;
  /** Tree last-child edge (TREE.last). */
  last: string;
  /** Result continuation rail (TREE.rail). */
  rail: string;
  /** Idle receipt root (TREE.receipt). */
  receipt: string;
  /** Detached continuation spacing (TREE.hang). */
  hang: string;
  /** Composer prompt glyph (ApexEditor input line). */
  prompt: string;
  /** Idle status glyph: todo pending/cancelled, dock starting, notice unknown. */
  statusIdle: string;
  /** Active status glyph: running/done/failed todo, live agents, notices. */
  statusActive: string;
}

const APEX_SKIN: SkinGlyphs = {
  header: "\u25cf",
  branch: "\u251c\u2500",
  last: "\u2570\u2500",
  rail: "\u2502",
  receipt: "\u25cb",
  hang: "   ",
  prompt: "\u276f",
  statusIdle: "\u25cb",
  statusActive: "\u25cf",
};

const CLAUDE_SKIN: SkinGlyphs = {
  header: "\u25cf",
  branch: "\u251c\u2500",
  // 90-degree terminal edge, matching HAL: the arc corner ╰ (U+2570)
  // squares to └ (U+2514). Same width, same BMP block.
  last: "\u2514\u2500",
  // Vertical connector, drawn once per continuation line. It must stay a
  // vertical rail (│ U+2502) rather than a corner: a terminal corner such as
  // ⎿ (U+23BF) repeats "the tree ends here" on every line, so multi-line
  // output renders a bracket down the whole gutter, blank lines included.
  rail: "\u2502",
  receipt: "\u25cf",
  hang: "   ",
  prompt: ">",
  statusIdle: "\u25a1",
  statusActive: "\u25a0",
};

const HAL_SKIN: SkinGlyphs = {
  ...CLAUDE_SKIN,
  header: "\u25a0",
  receipt: "\u25a1",
  // 90-degree terminal edge: HAL is a square-instrument skin, so the arc
  // corner ╰ (U+2570) squares to └ (U+2514). Same width, same BMP block.
  last: "\u2514\u2500",
};

/** Active skin name, defaulting to apex when unset or unrecognized. */
export function activeSkinName(): SkinName {
  const skin = process.env[SKIN_ENV_VAR];
  return skin === "claude" || skin === "hal" ? skin : "apex";
}

/** Glyph set for the active skin. Read fresh on every call. */
export function skinGlyphs(): SkinGlyphs {
  const skin = activeSkinName();
  if (skin === "hal") return HAL_SKIN;
  return skin === "claude" ? CLAUDE_SKIN : APEX_SKIN;
}

/** Composer prompt glyph for the active skin. */
export function composerPromptGlyph(): string {
  return skinGlyphs().prompt;
}
