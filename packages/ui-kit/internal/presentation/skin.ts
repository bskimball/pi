// skin: glyph skins for Apex presentation.
//
// "apex" is the default skin and preserves the exact glyphs Apex has always
// used. "claude" swaps the receipt/composer glyphs toward a Claude Code look
// while keeping every tree shape/key so existing call sites are unchanged.
// "hal" keeps Claude's continuation geometry with square instrument glyphs.
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
  last: "\u2570\u2500",
  rail: "\u23bf",
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
