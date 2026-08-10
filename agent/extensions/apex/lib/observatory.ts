// observatory: the landing screen shown for a genuinely fresh chat.
//
// Pure data + string building. No timers, no Pi TUI Text/Markdown/Container,
// no rendering state. The caller wraps `renderObservatory` in a passive
// WidthText component so a failure degrades to a single fallback row.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  discoverAgents,
  isProjectAgentFile,
  type AgentDef,
} from "./agent-discovery.ts";
import { cleanInline } from "./ui-common.ts";
import {
  SHARK_PIXELS_MID,
  SHARK_PIXELS_MID_WIDTH,
  SHARK_PIXELS_ULTRA,
  SHARK_PIXELS_ULTRA_WIDTH,
  SHARK_PIXELS_WIDE,
  SHARK_PIXELS_WIDE_WIDTH,
} from "./shark-art.ts";
import { TRUECOLOR, pixelRows } from "./pixel-art.ts";
import { starFieldRow } from "./star-field.ts";
import { padStartToWidth, safeTruncateToWidth, safeVisibleWidth } from "./safe-text-layout.ts";

/**
 * The observatory is installed as Pi's startup header, which has no line cap.
 * With quiet startup the header is the entire opening screen, so the
 * composition is a full splash. The budget covers the tallest 16-row truecolor
 * mark plus the signal, the inventory, and the threshold chrome beneath it.
 */
export const OBSERVATORY_MAX_LINES = 25;
export const NEUTRAL_SIGNAL = "AWAITING A SIGNAL";

type Fg = (key: any, text: string) => string;

export interface FeaturedEntry {
  /**
   * Slash name for prompts/skills/extension commands, or bare specialist
   * name for agent catalog entries.
   */
  name: string;
  /** Short label used in the constellation and the selector. */
  label: string;
  description: string;
  /**
   * File-backed prompts/skills, allowlisted extension pathways
   * (/browser, /deploy), and discovered specialist subagents.
   */
  source: "prompt" | "skill" | "extension" | "agent";
  /** Absolute path for file-backed entries; synthetic for extension commands. */
  path: string;
  baseDir?: string;
  /** Project- or user-authored resource, as opposed to a packaged one. */
  custom: boolean;
}

export interface Observatory {
  /** Truthful project signal, or the neutral fallback. */
  signal: string;
  /** True when the signal came from a real workspace/project resource. */
  hasProject: boolean;
  /** Seeds this workspace's own constellation. Stable across launches. */
  seed: string;
  /** Context usage 0..1 when known; burns stars out of the sky as it fills. */
  contextFill?: number;
  pathways: FeaturedEntry[];
  specialists: FeaturedEntry[];
  promptCount: number;
  skillCount: number;
  agentCount: number;
}

/**
 * Names that are generally useful on a blank page, in preference order. Only
 * used as a tie-breaker; project-scoped resources always outrank them.
 */
const PREFERRED = [
  "brainstorm",
  "browser",
  "deploy",
  "plan",
  "review",
  "explore",
  "explain",
  "research",
  "debug",
  "test",
  "refactor",
  "document",
];

/** Specialist preference order on a blank page. */
const PREFERRED_AGENTS = [
  "scout",
  "inspector",
  "advisor",
  "machinist",
  "artisan",
  "oracle",
  "librarian",
  "stevedore",
  "scribe",
  "picasso",
];

/**
 * Extension slash commands surfaced in the Observatory pathway list.
 * Keep this list intentional: most extension commands (e.g. /observatory)
 * are UI chrome, not user pathways.
 */
export const FEATURED_EXTENSION_COMMANDS = new Set(["browser", "deploy"]);

/**
 * Session entry types that are conversation content. Everything else
 * (model_change, thinking_level_change, session_info, label, custom, …) is
 * metadata and must not block the blank opening screen.
 */
export function isConversationEntryType(type: string | undefined): boolean {
  return type === "message" || type === "custom_message";
}

/**
 * True when the session has no conversation messages yet.
 * Fresh chats are seeded with model_change + thinking_level_change before
 * session_start; those alone still count as blank.
 */
export function isConversationBlank(
  entries: readonly { type?: string }[],
): boolean {
  for (const entry of entries) {
    if (isConversationEntryType(entry?.type)) return false;
  }
  return true;
}

function preferenceRank(name: string): number {
  const bare = name.replace(/^skill:/, "").toLowerCase();
  const index = PREFERRED.findIndex((preferred) => bare.includes(preferred));
  return index === -1 ? PREFERRED.length : index;
}

function agentPreferenceRank(name: string): number {
  const index = PREFERRED_AGENTS.indexOf(name.toLowerCase());
  return index === -1 ? PREFERRED_AGENTS.length : index;
}

function scopeRank(scope: string | undefined): number {
  return scope === "project" ? 0 : scope === "user" ? 1 : 2;
}

function isFeaturedSource(
  source: SlashCommandInfo["source"],
  name: string,
): source is "prompt" | "skill" | "extension" {
  if (source === "prompt" || source === "skill") return true;
  return source === "extension" && FEATURED_EXTENSION_COMMANDS.has(name);
}

function isPathwayEntry(entry: FeaturedEntry): boolean {
  return entry.source === "prompt" || entry.source === "extension";
}

function toEntry(command: SlashCommandInfo): FeaturedEntry | undefined {
  const source = command.source;
  if (!isFeaturedSource(source, command.name)) return undefined;
  const filePath = command.sourceInfo?.path;
  // Extension commands still carry the extension file path as source metadata.
  // File-backed prompt/skill entries require a real resource path.
  if (source !== "extension" && (typeof filePath !== "string" || !filePath)) {
    return undefined;
  }
  const scope = command.sourceInfo?.scope;
  // Display fields are sanitized; path/baseDir stay raw for launch/read.
  return {
    name: command.name,
    label: cleanInline(command.name.replace(/^skill:/, ""), 80),
    description: cleanInline(command.description ?? "", 200),
    source,
    path: typeof filePath === "string" && filePath ? filePath : `<extension:${command.name}>`,
    baseDir: command.sourceInfo?.baseDir,
    // "Custom" is asserted only from scope, which getCommands() does report.
    // Featured extension pathways are always user-authored config, so keep them
    // visually marked even if scope metadata is synthetic/missing.
    custom:
      scope === "project" ||
      scope === "user" ||
      source === "extension",
  };
}

function rank(a: FeaturedEntry, b: FeaturedEntry, scopeOf: Map<string, number>): number {
  const scopeDelta = (scopeOf.get(a.name) ?? 2) - (scopeOf.get(b.name) ?? 2);
  if (scopeDelta !== 0) return scopeDelta;
  const prefer =
    a.source === "agent" || b.source === "agent"
      ? agentPreferenceRank(a.name) - agentPreferenceRank(b.name)
      : preferenceRank(a.name) - preferenceRank(b.name);
  if (prefer !== 0) return prefer;
  return a.label.localeCompare(b.label);
}

function toAgentEntry(def: AgentDef): FeaturedEntry {
  return {
    name: def.name,
    label: cleanInline(def.name, 80),
    description: cleanInline(def.description ?? "", 200),
    source: "agent",
    path: def.file,
    baseDir: path.dirname(def.file),
    custom: true,
  };
}

function collectAgents(cwd: string): {
  pool: FeaturedEntry[];
  scopeOf: Map<string, number>;
} {
  const scopeOf = new Map<string, number>();
  const pool: FeaturedEntry[] = [];
  for (const def of discoverAgents(cwd).values()) {
    const entry = toAgentEntry(def);
    scopeOf.set(entry.name, isProjectAgentFile(def.file, cwd) ? 0 : 1);
    pool.push(entry);
  }
  return { pool, scopeOf };
}

function collectPool(commands: readonly SlashCommandInfo[]): {
  pool: FeaturedEntry[];
  scopeOf: Map<string, number>;
} {
  const scopeOf = new Map<string, number>();
  const pool: FeaturedEntry[] = [];
  for (const command of commands) {
    const entry = toEntry(command);
    if (!entry) continue;
    scopeOf.set(entry.name, scopeRank(command.sourceInfo?.scope));
    pool.push(entry);
  }
  return { pool, scopeOf };
}

function sortPool(
  entries: FeaturedEntry[],
  scopeOf: Map<string, number>,
): FeaturedEntry[] {
  return [...entries].sort((a, b) => rank(a, b, scopeOf));
}

/**
 * Build the observatory model from Pi's command inventory plus the specialist
 * agent catalog. Never rescans prompt/skill directories itself.
 */
export function buildObservatory(
  commands: readonly SlashCommandInfo[],
  cwd: string,
  contextFill?: number,
): Observatory {
  const { pool, scopeOf } = collectPool(commands);
  const agents = collectAgents(cwd);
  // Pathways = file prompts + allowlisted extension slash commands.
  const prompts = pool.filter(isPathwayEntry);
  const skills = pool.filter((entry) => entry.source === "skill");
  const specialists = agents.pool;

  // Only project-scoped prompt/skill/agent inventory is a truthful project signal.
  // A non-root cwd alone is not reliable (home, temp, unrelated folders).
  // Extension pathways are user-config chrome and never count as project signal.
  const hasProject =
    pool.some(
      (entry) => entry.source !== "extension" && scopeOf.get(entry.name) === 0,
    ) || specialists.some((entry) => agents.scopeOf.get(entry.name) === 0);
  const workspace = cleanInline(path.basename(cwd || ""), 40);
  const signal = hasProject
    ? workspace
      ? `${workspace.toUpperCase()} · PROJECT ORBIT`
      : "PROJECT ORBIT"
    : NEUTRAL_SIGNAL;

  return {
    signal,
    hasProject,
    // The path, not the basename: two checkouts of the same repo are different
    // places and should not share a sky.
    seed: cwd || "",
    contextFill,
    // Caps leave room for the constellation layout: prompts stay short on the
    // left, agents fill both sub-columns (up to all nine specialists). Skills
    // stay countable and browsable, but are not featured on the landing.
    pathways: sortPool(prompts, scopeOf).slice(0, 6),
    specialists: sortPool(specialists, agents.scopeOf).slice(0, 9),
    promptCount: prompts.length,
    skillCount: skills.length,
    agentCount: specialists.length,
  };
}

/** Full inventory of prompts, skills, or specialists, ranked like featured. */
export function listInventory(
  commands: readonly SlashCommandInfo[],
  source: "prompt" | "skill" | "agent",
  cwd: string = process.cwd(),
): FeaturedEntry[] {
  if (source === "agent") {
    const agents = collectAgents(cwd);
    return sortPool(agents.pool, agents.scopeOf);
  }
  const { pool, scopeOf } = collectPool(commands);
  const matches =
    source === "prompt"
      ? pool.filter(isPathwayEntry)
      : pool.filter((entry) => entry.source === "skill");
  return sortPool(matches, scopeOf);
}

/**
 * Optical cap for the whole composition. A mark that stretches to 200
 * columns stops reading as a mark, so the block stays dense and centered.
 */
const PORTAL_MAX_SPAN = 64;
/** The 56-column full shark + twin constellation columns need this much room. */
const FULL_MIN = 62;
/** Below this only the minimal dorsal-fin mark, the signal and the threshold remain. */
const MINIMAL_MIN = 20;

/** Width gates for the purpose-built truecolor tiers. */
const PIXEL_ULTRA_MIN = SHARK_PIXELS_ULTRA_WIDTH + 2;
const PIXEL_WIDE_MIN = SHARK_PIXELS_WIDE_WIDTH + 2;
const PIXEL_MID_MIN = SHARK_PIXELS_MID_WIDTH + 2;

/**
 * The centrepiece: a hand-authored side-profile great white, 7 rows × 56
 * columns, swimming left. Half blocks (▀ ▄) double the vertical resolution, so
 * the silhouette is drawn on a 14 × 56 sub-grid: pointed snout at column 1,
 * eye notch, dropped open jaw, three gill slits, a long torpedo trunk that is
 * deepest under the dorsal, a tall triangular dorsal about a third back from
 * the snout, a pectoral fin raked down and back, a long rear taper into a
 * visibly narrow peduncle, and a large asymmetric crescent tail whose long
 * swept upper lobe overhangs the short lower one across a deep notch.
 *
 * Counter-shading is carried by colour rather than by glyph noise: the back is
 * violet, the lateral line burns violet→cyan→violet, the belly is pale. Every
 * glyph is narrow BMP block art (█ ▓ ▒ ▀ ▄), so the block is exactly 56 cells
 * wide on every terminal. Row 0 rides the star field, row 6 carries the fins.
 */
const SHARK_LOGO: readonly string[] = [
  "                  ▄██▄                              ▄███",
  "                ▄██████▄                         ▄████▀ ",
  "     ▄▄▄▄█████████████████████████▄▄▄▄        ▄█████▀   ",
  " ▄▓██▒█████▓█▓█▓████████████████████████▄▄▄▄▄▄██████    ",
  "  ▀▀ ▓▓▓▓██████████████████████▀▀▀▀▀▀▀▀         ▄████   ",
  "      ▀▀▀▀███████▀▀▀▀                             ▀███▀ ",
  "             ▀▀██▄▄                                     ",
];
const SHARK_LOGO_WIDTH = 56;
/**
 * Per-row colour: dark back → luminous flank → pale belly → wake. `null` marks
 * the lateral line, the one row that takes the horizontal gradient.
 */
const SHARK_LOGO_KEYS: readonly (string | null)[] = [
  "customMessageLabel",
  "customMessageLabel",
  "customMessageLabel",
  null,
  "text",
  "text",
  "muted",
];

/**
 * Narrow-terminal shark: the same silhouette cut down to the cues that still
 * read at 18 columns — triangular dorsal, tapered snout, thick trunk, raked
 * pectoral and crescent tail — at 4 rows × 18 columns.
 */
const SHARK_COMPACT: readonly string[] = [
  "     ▄██▄       ▄█",
  " ▄▄███████▄▄▄▄▄██▀",
  "▀████████████▀▀██▄",
  "  ▀▀▀▀███       ▀█",
];
const SHARK_COMPACT_WIDTH = 18;
const SHARK_COMPACT_KEYS: readonly (string | null)[] = [
  "customMessageLabel",
  null,
  "text",
  "muted",
];

/**
 * Sub-minimal mark for terminals too narrow for any block art: a lone dorsal
 * fin breaking the surface. Single-cell BMP, like {@link SELECTION_POINTER}.
 */
const SHARK_MINIMAL = "▴";

/**
 * Leading marker and filled glyph for the focused constellation entry. The
 * pointer is U+25B8 rather than the composer's `❯`: it is unambiguously
 * single-cell, so the two-column pointer gutter measures the same whether the
 * row is selected or not and the constellation never shifts as focus moves.
 */
const SELECTION_POINTER = "▸";
const SELECTED_GLYPH = "◆";

/**
 * The sky is as wide as the mark it frames, so the constellation reads as one
 * composition with the shark rather than a full-width band behind it.
 */
const STARFIELD_WIDE_SPAN = 42;
const STARFIELD_NARROW_SPAN = 20;

/**
 * Center a styled row on the composition's single optical axis, which is the column
 * the shark's dorsal fin occupies: `floor((width - 1) / 2)`.
 */
function center(text: string, width: number): string {
  const visible = safeVisibleWidth(text);
  if (visible >= width) return safeTruncateToWidth(text, width);
  return `${" ".repeat(Math.floor((width - visible) / 2))}${text}`;
}

/** Left-pad a styled block row so the block as a whole sits on that same axis. */
function indent(text: string, blockWidth: number, width: number): string {
  const pad = Math.max(0, Math.floor((width - blockWidth) / 2));
  return `${" ".repeat(pad)}${text}`;
}

/** Pad a styled cell to an exact visible width (ANSI-safe column alignment). */
function padCell(text: string, width: number): string {
  const visible = safeVisibleWidth(text);
  if (visible >= width) return safeTruncateToWidth(text, width);
  return `${text}${" ".repeat(width - visible)}`;
}

/**
 * The horizon: one unbroken run of `─` whose color is applied in slices, so the
 * rule reads as a continuous gradient (borderMuted → dim → violet core) with no
 * seams and no glyph interruptions.
 */
function horizonRule(fg: Fg, span: number): string {
  const total = Math.max(8, span);
  const outer = Math.max(1, Math.floor(total * 0.28));
  const mid = Math.max(1, Math.floor(total * 0.14));
  const core = Math.max(2, total - 2 * outer - 2 * mid);
  const dash = (count: number) => "─".repeat(count);
  return (
    fg("borderMuted", dash(outer)) +
    fg("dim", dash(mid)) +
    fg("customMessageLabel", dash(core)) +
    fg("dim", dash(mid)) +
    fg("borderMuted", dash(outer))
  );
}

/** Widths are forced even so every centered block shares one optical axis. */
function evenSpan(span: number): number {
  return span % 2 === 0 ? span : span - 1;
}

/**
 * The lateral line's horizontal gradient: violet at the snout and the tail,
 * cyan through the core, so the flank reads as luminous rather than as a flat
 * slab. The cyan core also sits where a shark's countershading actually
 * catches the light.
 */
function lateralLine(art: string, fg: Fg): string {
  const edge = Math.max(1, Math.round(art.length * 0.22));
  return (
    fg("customMessageLabel", art.slice(0, edge)) +
    fg("accent", art.slice(edge, art.length - edge)) +
    fg("customMessageLabel", art.slice(art.length - edge))
  );
}

/**
 * The shark mark, sized to the terminal.
 *
 * Five tiers, widest first: three purpose-built truecolor bitmaps, then the
 * hand-authored glyph shark, then a lone dorsal fin. The bitmap tiers are
 * skipped entirely without 24-bit colour so the mark never degrades into
 * banded mush.
 */
function logoBlock(fg: Fg, width: number, active: boolean): Block {
  if (width < MINIMAL_MIN) {
    return { rows: [fg("accent", SHARK_MINIMAL)], blockWidth: 1 };
  }
  if (TRUECOLOR && width >= PIXEL_ULTRA_MIN) {
    return {
      rows: pixelRows(SHARK_PIXELS_ULTRA),
      blockWidth: SHARK_PIXELS_ULTRA_WIDTH,
    };
  }
  if (TRUECOLOR && width >= PIXEL_WIDE_MIN) {
    return {
      rows: pixelRows(SHARK_PIXELS_WIDE),
      blockWidth: SHARK_PIXELS_WIDE_WIDTH,
    };
  }
  if (TRUECOLOR && width >= PIXEL_MID_MIN) {
    return {
      rows: pixelRows(SHARK_PIXELS_MID),
      blockWidth: SHARK_PIXELS_MID_WIDTH,
    };
  }
  const full = width >= FULL_MIN;
  const art = full ? SHARK_LOGO : SHARK_COMPACT;
  const keys = full ? SHARK_LOGO_KEYS : SHARK_COMPACT_KEYS;
  const rows = art.map((row, index) => {
    const key = keys[index];
    if (key !== null && key !== undefined) return fg(key, row);
    // Focused: the lateral line burns to a single live accent instead of the
    // resting violet→cyan gradient. Colour only; the geometry never moves.
    return active ? fg("accent", row) : lateralLine(row, fg);
  });
  return { rows, blockWidth: full ? SHARK_LOGO_WIDTH : SHARK_COMPACT_WIDTH };
}



/**
 * The signal, letter-spaced into a small-caps feel when there is room for it.
 */
function letterSpace(text: string): string {
  return [...text].join(" ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One constellation cell: `glyph name`, truncated to the column. A missing
 * entry renders as nothing at all — short columns simply end.
 *
 * In selection mode every cell gains a two-column pointer gutter — blank on
 * unselected rows — so moving the selection never shifts the layout.
 */
function constellationCell(
  entry: FeaturedEntry | undefined,
  glyph: string,
  fg: Fg,
  columnWidth: number,
  mode?: { pointer: boolean; selected: boolean },
): string {
  if (!entry) return "";
  const pointer = mode?.pointer === true;
  const label = safeTruncateToWidth(
    entry.label,
    Math.max(1, columnWidth - 2 - (pointer ? 2 : 0)),
  );
  if (!pointer) {
    return (
      fg(entry.custom ? "accent" : "borderMuted", glyph) +
      " " +
      fg(entry.custom ? "text" : "muted", label)
    );
  }
  if (mode?.selected) {
    return (
      fg("accent", `${SELECTION_POINTER} ${SELECTED_GLYPH} `) + fg("accent", label)
    );
  }
  return (
    "  " +
    fg(entry.custom ? "accent" : "borderMuted", glyph) +
    " " +
    fg(entry.custom ? "text" : "muted", label)
  );
}

/**
 * `1 prompt · 16 skills · /observatory`, the quiet meta footer. The
 * discoverability hint is the last thing dropped, never clipped.
 */
function metaLine(
  view: Observatory,
  fg: Fg,
  width: number,
  active: boolean,
): string {
  const dot = fg("borderMuted", width >= 60 ? "  ·  " : " · ");
  if (active) {
    const keys = ["↑↓ move", "⏎ launch", "esc dismiss"].map((key) =>
      fg("dim", key),
    );
    const legend = keys.join(dot);
    if (safeVisibleWidth(legend) <= width) return legend;
    const tight = keys.join(fg("borderMuted", " · "));
    if (safeVisibleWidth(tight) <= width) return tight;
    return fg("dim", safeTruncateToWidth("↑↓ ⏎ esc", width));
  }
  const counts: string[] = [];
  if (view.promptCount > 0) {
    counts.push(fg("dim", plural(view.promptCount, "prompt")));
  }
  if (view.skillCount > 0) {
    counts.push(fg("dim", plural(view.skillCount, "skill")));
  }
  if (view.agentCount > 0) {
    counts.push(fg("dim", plural(view.agentCount, "agent")));
  }
  const hint = fg("muted", "/observatory");
  const full = [...counts, hint].join(dot);
  if (safeVisibleWidth(full) <= width) return full;
  const bare = counts.join(dot);
  return safeVisibleWidth(bare) <= width ? bare : hint;
}

/**
 * The workspace signal, shortened rather than clipped mid-word when the
 * terminal cannot hold the full `NAME · PROJECT ORBIT` form.
 */
function signalLine(view: Observatory, fg: Fg, width: number): string {
  const key = view.hasProject ? "text" : "muted";
  const spaced = letterSpace(view.signal);
  if (safeVisibleWidth(spaced) <= width) return fg(key, spaced);
  if (safeVisibleWidth(view.signal) <= width) return fg(key, view.signal);
  const head = view.signal.split(" · ")[0] ?? view.signal;
  const spacedHead = letterSpace(head);
  if (safeVisibleWidth(spacedHead) <= width) return fg(key, spacedHead);
  return fg(key, safeTruncateToWidth(head, width));
}

/** The threshold line; shortens instead of clipping on very narrow terminals. */
function invitation(fg: Fg, width: number): string {
  const full = fg("accent", "❯ ") + fg("muted", "transmit an intention…");
  if (safeVisibleWidth(full) <= width) return full;
  return fg("accent", "❯ ") + fg("muted", "an intention…");
}

interface Block {
  rows: string[];
  /** Visible width the block is centered as, so every row shares one axis. */
  blockWidth: number;
}

/** Pathway / agent glyphs — same family the prior constellation used. */
const GLYPH_PROMPT = "◇";
const GLYPH_AGENT = "◎";

/** Column-major split so CUSTOM AGENTS reads down the left, then the right. */
function splitAgentColumns(
  agents: readonly FeaturedEntry[],
): [readonly FeaturedEntry[], readonly FeaturedEntry[]] {
  if (agents.length <= 1) return [agents, []];
  const leftCount = Math.ceil(agents.length / 2);
  return [agents.slice(0, leftCount), agents.slice(leftCount)];
}

/**
 * Wide constellation: CUSTOM PROMPTS | CUSTOM AGENTS, where agents may use two
 * sub-columns so all nine specialists fit.
 *
 * Featured index order matches visual order: prompts → agents (left column
 * top-to-bottom, then right).
 */
function inventoryColumns(
  view: Observatory,
  fg: Fg,
  span: number,
  maxRows: number,
  selection: ObservatorySelection | undefined,
): Block {
  const pointer = selection?.active === true;
  const selectedIndex = pointer ? selection?.index : undefined;
  const prompts = view.pathways;
  const agents = view.specialists;
  const promptOffset = 0;
  const agentOffset = prompts.length;

  const rows: string[] = [];
  const hasPrompts = prompts.length > 0;
  const hasAgents = agents.length > 0;

  // All constellation rows belong to prompts + agents now that skills are gone,
  // so the agent pair columns can run to their full depth.
  const useAgentPair = hasAgents && agents.length > 3 && span >= 48;
  const [agentLeft, agentRight] = useAgentPair
    ? splitAgentColumns(agents)
    : [agents, [] as FeaturedEntry[]];
  const topBudget = maxRows;

  if (topBudget > 0 && (hasPrompts || hasAgents)) {
    const agentGutter = 3;
    const groupGutter = 6;
    // Three content columns when prompts + paired agents; otherwise two or one.
    const contentColumns = hasPrompts && useAgentPair ? 3 : hasPrompts && hasAgents ? 2 : 1;
    const gutters =
      contentColumns === 3 ? groupGutter + agentGutter : contentColumns === 2 ? groupGutter : 0;
    const cellLimit = Math.max(
      10,
      Math.floor((span - gutters) / Math.max(1, contentColumns)),
    );
    const labelExtra = 2 + (pointer ? 2 : 0);
    const widestLabel = [...prompts, ...agents].reduce(
      (widest, entry) => Math.max(widest, safeVisibleWidth(entry.label) + labelExtra),
      0,
    );
    // Headings are longer than most labels; never clip "CUSTOM PROMPTS".
    const titleFloor = Math.max(
      safeVisibleWidth("CUSTOM PROMPTS"),
      safeVisibleWidth("CUSTOM AGENTS"),
    );
    const colW = Math.max(
      titleFloor,
      Math.min(cellLimit, Math.max(widestLabel, titleFloor)),
    );

    // Heading row.
    if (hasPrompts && hasAgents) {
      const leftHead = padCell(fg("customMessageLabel", "CUSTOM PROMPTS"), colW);
      const rightHead = fg("customMessageLabel", "CUSTOM AGENTS");
      rows.push(leftHead + " ".repeat(groupGutter) + rightHead);
    } else if (hasPrompts) {
      rows.push(fg("customMessageLabel", "CUSTOM PROMPTS"));
    } else {
      rows.push(fg("customMessageLabel", "CUSTOM AGENTS"));
    }

    const bodyRows = Math.max(0, topBudget - 1);
    const depth = Math.min(
      bodyRows,
      Math.max(prompts.length, agentLeft.length, agentRight.length),
    );
    const groupGap = " ".repeat(groupGutter);
    const agentGap = " ".repeat(agentGutter);

    for (let index = 0; index < depth; index++) {
      let promptCell = "";
      if (hasPrompts) {
        promptCell = padCell(
          constellationCell(prompts[index], GLYPH_PROMPT, fg, colW, {
            pointer,
            selected:
              pointer &&
              prompts[index] !== undefined &&
              selectedIndex === promptOffset + index,
          }),
          colW,
        );
      }

      let agentCell = "";
      if (hasAgents) {
        if (useAgentPair) {
          const left = constellationCell(agentLeft[index], GLYPH_AGENT, fg, colW, {
            pointer,
            selected:
              pointer &&
              agentLeft[index] !== undefined &&
              selectedIndex === agentOffset + index,
          });
          const right = constellationCell(agentRight[index], GLYPH_AGENT, fg, colW, {
            pointer,
            selected:
              pointer &&
              agentRight[index] !== undefined &&
              selectedIndex === agentOffset + agentLeft.length + index,
          });
          agentCell = right ? padCell(left, colW) + agentGap + right : left;
        } else {
          agentCell = constellationCell(agents[index], GLYPH_AGENT, fg, colW, {
            pointer,
            selected:
              pointer &&
              agents[index] !== undefined &&
              selectedIndex === agentOffset + index,
          });
        }
      }

      let row = "";
      if (hasPrompts && hasAgents) row = promptCell + groupGap + agentCell;
      else if (hasPrompts) row = promptCell;
      else row = agentCell;
      // Skip pure-empty trailing rows when one side ran out first.
      if (safeVisibleWidth(row) > 0) rows.push(row);
    }
  }

  const ink = rows.reduce((widest, row) => Math.max(widest, safeVisibleWidth(row)), 0);
  return { rows: rows.slice(0, maxRows), blockWidth: evenSpan(Math.max(ink, 12) + 1) };
}

/**
 * Narrow constellation: stack CUSTOM PROMPTS then CUSTOM AGENTS.
 * Same featured index order as {@link inventoryColumns} / {@link featuredEntries}.
 */
function inventoryStacked(
  view: Observatory,
  fg: Fg,
  span: number,
  maxRows: number,
  selection: ObservatorySelection | undefined,
): Block {
  const pointer = selection?.active === true;
  const selectedIndex = pointer ? selection?.index : undefined;
  const columnWidth = Math.max(12, Math.min(40, span));
  const prompts = view.pathways;
  const agents = view.specialists;

  // Even stacked, nine specialists only fit when they pair into two columns.
  const pairAgents = agents.length > 3 && columnWidth >= 28;
  const [agentLeft, agentRight] = pairAgents
    ? splitAgentColumns(agents)
    : [agents, [] as readonly FeaturedEntry[]];

  const groups: {
    title: string;
    entries: readonly FeaturedEntry[];
    right?: readonly FeaturedEntry[];
    glyph: string;
    offset: number;
  }[] = [];
  if (prompts.length > 0) {
    groups.push({
      title: "CUSTOM PROMPTS",
      entries: prompts,
      glyph: GLYPH_PROMPT,
      offset: 0,
    });
  }
  if (agents.length > 0) {
    groups.push({
      title: "CUSTOM AGENTS",
      entries: agentLeft,
      right: pairAgents ? agentRight : undefined,
      glyph: GLYPH_AGENT,
      offset: prompts.length,
    });
  }

  const rows: string[] = [];
  // Weight: agents deserve the most rows, prompts a few.
  const weights = groups.map((group) => (group.glyph === GLYPH_AGENT ? 3 : 2));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  // Each group with entries needs a heading row when we have room.
  const headingCost = groups.length;
  const entryBudget = Math.max(0, maxRows - headingCost);

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    if (rows.length >= maxRows) break;
    const group = groups[groupIndex]!;
    rows.push(fg("customMessageLabel", group.title));
    if (rows.length >= maxRows) break;

    const share = Math.max(
      1,
      Math.floor((entryBudget * (weights[groupIndex] ?? 1)) / weightSum),
    );
    // Last group consumes whatever remains so we do not waste budget.
    const isLast = groupIndex === groups.length - 1;
    const room = maxRows - rows.length;
    const depth = Math.min(
      group.entries.length,
      isLast ? room : Math.min(share, room),
    );

    const cellWidth = group.right
      ? Math.max(10, Math.floor((columnWidth - 2 - 2) / 2))
      : columnWidth - 2;

    for (let index = 0; index < depth; index++) {
      if (rows.length >= maxRows) break;
      const left = constellationCell(group.entries[index], group.glyph, fg, cellWidth, {
        pointer,
        selected: pointer && selectedIndex === group.offset + index,
      });
      if (!group.right) {
        rows.push(`  ${left}`);
        continue;
      }
      const right = constellationCell(group.right[index], group.glyph, fg, cellWidth, {
        pointer,
        selected:
          pointer &&
          group.right[index] !== undefined &&
          selectedIndex === group.offset + group.entries.length + index,
      });
      rows.push(right ? `  ${padCell(left, cellWidth)}  ${right}` : `  ${left}`);
    }
  }

  const blockWidth = rows.reduce(
    (widest, row) => Math.max(widest, safeVisibleWidth(row)),
    0,
  );
  return { rows, blockWidth: evenSpan(Math.min(columnWidth, blockWidth) + 1) };
}

/** The constellation unit, or nothing at all when the inventory is empty. */
function constellationBlock(
  view: Observatory,
  fg: Fg,
  width: number,
  span: number,
  maxRows: number,
  selection: ObservatorySelection | undefined,
): Block | undefined {
  if (width < MINIMAL_MIN) return undefined;
  if (view.pathways.length === 0 && view.specialists.length === 0) {
    return undefined;
  }
  if (maxRows <= 0) return undefined;
  const full = width >= FULL_MIN;
  // Wide terminals: side-by-side CUSTOM PROMPTS | CUSTOM AGENTS.
  // Narrow / single-group: stacked sections with the same index order.
  if (full && (view.pathways.length > 0 || view.specialists.length > 0)) {
    return inventoryColumns(view, fg, span, maxRows, selection);
  }
  return inventoryStacked(view, fg, span, maxRows, selection);
}

/**
 * Keyboard focus state for the interactive orb. `index` addresses the featured
 * entries in the same order as {@link featuredAt} (prompts → agents).
 */
export interface ObservatorySelection {
  index: number;
  active: boolean;
}

/**
 * Render the splash: star field → shark mark → signal → constellations → meta →
 * threshold → horizon, on one optical axis with an even single-row rhythm.
 * Installed as Pi's startup header, so 25 rows is the budget, not 9.
 */
export function renderObservatory(
  view: Observatory,
  fg: Fg,
  width: number,
  selection?: ObservatorySelection,
): string[] {
  if (width <= 0) return [];
  const active = selection?.active === true;
  const inner = Math.max(1, width);
  const span = evenSpan(Math.max(8, Math.min(inner - 2, PORTAL_MAX_SPAN)));
  const lines: string[] = [];

  // Dense fixed chrome (no blank under the star or under the mark) so the
  // inventory can hold all nine agents inside the line budget.
  if (inner >= MINIMAL_MIN) {
    const skySpan = Math.min(
      inner,
      inner >= FULL_MIN ? STARFIELD_WIDE_SPAN : STARFIELD_NARROW_SPAN,
    );
    lines.push(
      center(
        starFieldRow(fg, skySpan, view.seed, view.contextFill),
        inner,
      ),
    );
  }

  const logo = logoBlock(fg, inner, active);
  for (const row of logo.rows) lines.push(indent(row, logo.blockWidth, inner));

  lines.push(center(signalLine(view, fg, inner), inner));

  // Trailing chrome after the constellation: optional meta, invitation, horizon.
  // Keep blanks around invitation/horizon so the threshold still breathes.
  const trailing =
    inner >= MINIMAL_MIN
      ? 1 /* meta */ + 1 /* blank */ + 1 /* invitation */ + 1 /* blank */ + 1 /* horizon */
      : 1 /* invitation */;
  const maxConstellationRows = Math.max(0, OBSERVATORY_MAX_LINES - lines.length - trailing);
  const constellations = constellationBlock(
    view,
    fg,
    inner,
    span,
    maxConstellationRows,
    selection,
  );
  if (constellations) {
    for (const row of constellations.rows) {
      lines.push(indent(row, constellations.blockWidth, inner));
    }
  }

  if (inner >= MINIMAL_MIN) {
    lines.push(center(metaLine(view, fg, inner, active), inner));
  }

  lines.push("");
  lines.push(center(invitation(fg, inner), inner));

  if (inner >= MINIMAL_MIN) {
    lines.push("");
    lines.push(center(horizonRule(fg, span), inner));
  }

  return lines
    .slice(0, OBSERVATORY_MAX_LINES)
    .map((line) => safeTruncateToWidth(line, inner));
}

/** Selector rows for `/observatory`, plus browse-all and cancel. */
export const OBSERVATORY_CANCEL = "Cancel";
export const OBSERVATORY_ALL_PROMPTS = "All prompts…";
export const OBSERVATORY_ALL_SKILLS = "All skills…";
export const OBSERVATORY_ALL_AGENTS = "All specialists…";

function featuredRow(entry: FeaturedEntry, kind: string): string {
  const mark = entry.custom ? "◈" : "◇";
  const label = cleanInline(entry.label, 80);
  const description = entry.description
    ? ` — ${cleanInline(entry.description, 60)}`
    : "";
  return `${mark} ${kind}  ${label}${description}`;
}

/**
 * Featured rows shown for keyboard/select launch. Order matches the landing
 * layout exactly: CUSTOM PROMPTS, then CUSTOM AGENTS (left column then right).
 */
export function featuredEntries(view: Observatory): FeaturedEntry[] {
  return [...view.pathways, ...view.specialists];
}

export function selectorOptions(view: Observatory): string[] {
  const featured = featuredEntries(view);
  const rows: string[] = featured.map((entry) => {
    const kind = entry.source === "agent" ? "specialist" : "pathway   ";
    return featuredRow(entry, kind);
  });
  if (view.promptCount > 0) {
    rows.push(`${OBSERVATORY_ALL_PROMPTS}  ·  ${view.promptCount}`);
  }
  if (view.skillCount > 0) {
    rows.push(`${OBSERVATORY_ALL_SKILLS}  ·  ${view.skillCount}`);
  }
  if (view.agentCount > 0) {
    rows.push(`${OBSERVATORY_ALL_AGENTS}  ·  ${view.agentCount}`);
  }
  rows.push(OBSERVATORY_CANCEL);
  return rows;
}

export function isAllPromptsChoice(choice: string): boolean {
  return (
    choice === OBSERVATORY_ALL_PROMPTS ||
    choice.startsWith(`${OBSERVATORY_ALL_PROMPTS} `)
  );
}

export function isAllSkillsChoice(choice: string): boolean {
  return (
    choice === OBSERVATORY_ALL_SKILLS ||
    choice.startsWith(`${OBSERVATORY_ALL_SKILLS} `)
  );
}

export function isAllAgentsChoice(choice: string): boolean {
  return (
    choice === OBSERVATORY_ALL_AGENTS ||
    choice.startsWith(`${OBSERVATORY_ALL_AGENTS} `)
  );
}

export function featuredAt(view: Observatory, index: number): FeaturedEntry | undefined {
  return featuredEntries(view)[index];
}

/** Resolve a top-level /observatory selection into an action. */
export function resolveSelectorChoice(
  view: Observatory,
  choice: string | undefined,
  options: readonly string[],
):
  | { action: "cancel" }
  | { action: "all-prompts" }
  | { action: "all-skills" }
  | { action: "all-agents" }
  | { action: "featured"; entry: FeaturedEntry } {
  if (!choice || choice === OBSERVATORY_CANCEL) return { action: "cancel" };
  if (isAllPromptsChoice(choice)) return { action: "all-prompts" };
  if (isAllSkillsChoice(choice)) return { action: "all-skills" };
  if (isAllAgentsChoice(choice)) return { action: "all-agents" };
  const index = options.indexOf(choice);
  const featuredCount = featuredEntries(view).length;
  if (index < 0 || index >= featuredCount) return { action: "cancel" };
  const entry = featuredAt(view, index);
  if (!entry) return { action: "cancel" };
  return { action: "featured", entry };
}

/** Second-level select for the full prompt or skill inventory. */
export function inventorySelectorOptions(entries: readonly FeaturedEntry[]): string[] {
  return [
    ...entries.map((entry) => {
      const mark = entry.custom ? "◈" : "◇";
      const label = cleanInline(entry.label, 80);
      const description = entry.description
        ? ` — ${cleanInline(entry.description, 70)}`
        : "";
      return `${mark} ${label}${description}`;
    }),
    OBSERVATORY_CANCEL,
  ];
}

export function inventoryAt(
  entries: readonly FeaturedEntry[],
  choice: string | undefined,
  options: readonly string[],
): FeaturedEntry | undefined {
  if (!choice || choice === OBSERVATORY_CANCEL) return undefined;
  const index = options.indexOf(choice);
  if (index < 0 || index >= entries.length) return undefined;
  return entries[index];
}

/**
 * Expand a featured entry to the text Pi would have produced itself.
 * `sendUserMessage("/skill:x")` does not expand, so the body is inlined here
 * using the same payload shape as core skill expansion.
 */
/** Escape values interpolated into skill XML markup (body stays raw). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function expandFeatured(entry: FeaturedEntry): Promise<string> {
  if (entry.source === "extension") {
    // Native commands need their executable pre-steps; apex-ui launches them
    // through the shared handler instead of inlining a template body.
    throw new Error(
      `/${entry.name} is a native command and cannot be expanded as a prompt template`,
    );
  }
  if (entry.source === "agent") {
    // Specialists are launched by prefilling a task brief, not as a user prompt body.
    throw new Error(
      `${entry.name} is a specialist agent and cannot be expanded as a prompt template`,
    );
  }
  const content = await fs.readFile(entry.path, "utf-8");
  const body = stripFrontmatter(content).trim();
  if (entry.source === "prompt") return body;
  // Launch payload uses raw inventory fields; only the XML attributes are escaped.
  const skillName = entry.name.replace(/^skill:/, "");
  const baseDir = entry.baseDir ?? path.dirname(entry.path);
  const name = escapeXml(skillName);
  const location = escapeXml(entry.path);
  const relativeTo = escapeXml(baseDir);
  return `<skill name="${name}" location="${location}">\nReferences are relative to ${relativeTo}.\n\n${body}\n</skill>`;
}

/**
 * Prefill text for launching a specialist from Observatory. The user still
 * edits/submits the brief so we never auto-start an unbounded subagent turn.
 */
export function specialistLaunchDraft(entry: FeaturedEntry): string {
  const description = entry.description
    ? `\n// ${entry.description}`
    : "";
  return [
    `Use the task tool with agent: ${entry.name}.${description}`,
    "",
    "Goal:",
    "",
    "Scope:",
    "",
    "Validation:",
    "",
  ].join("\n");
}

/** Right-aligned index column, used only by the selector title. */
export function selectorTitle(view: Observatory): string {
  const total = featuredEntries(view).length;
  const parts = [
    `${view.promptCount} prompts`,
    `${view.skillCount} skills`,
    `${view.agentCount} agents`,
  ];
  return `Observatory · ${padStartToWidth(String(total), 1)} featured (${parts.join(", ")})`;
}

export function inventorySelectorTitle(
  source: "prompt" | "skill" | "agent",
  count: number,
): string {
  const noun =
    source === "prompt" ? "prompt" : source === "skill" ? "skill" : "specialist";
  const plural = count === 1 ? noun : `${noun}s`;
  return `Observatory · all ${plural} (${count})`;
}
