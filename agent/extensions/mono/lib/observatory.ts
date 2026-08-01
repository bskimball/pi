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
import { padStartToWidth, safeTruncateToWidth, safeVisibleWidth } from "./safe-text-layout.ts";

/**
 * The observatory is installed as Pi's startup header, which has no line cap.
 * With quiet startup the header is the entire opening screen, so the
 * composition is a full splash: an even vertical rhythm inside 22 rows.
 */
export const OBSERVATORY_MAX_LINES = 22;
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
  pathways: FeaturedEntry[];
  instruments: FeaturedEntry[];
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
    pathways: sortPool(prompts, scopeOf).slice(0, 3),
    instruments: sortPool(skills, scopeOf).slice(0, 3),
    specialists: sortPool(specialists, agents.scopeOf).slice(0, 3),
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
 * Optical cap for the whole composition. A portal that stretches to 200
 * columns stops reading as a portal, so the block stays dense and centered.
 */
const PORTAL_MAX_SPAN = 64;
/** Full logo + twin constellation columns need this much room. */
const FULL_MIN = 44;
/** Below this only the singularity glyph, the signal and the threshold remain. */
const MINIMAL_MIN = 20;

/**
 * The centrepiece: a hand-authored block-art π, 7 rows × 28 columns. Two-row
 * crossbar overhanging two splayed legs, with the glyph weight (█ ▓ ▒ ░)
 * carrying the fall-off from the luminous bar to the dim leg extremities.
 * Every glyph is narrow BMP box/block art, so the block is exactly 28 cells
 * wide on every terminal. Row 0 is a halo, row 6 is its shadow.
 */
const PI_LOGO: readonly string[] = [
  "  ░░░░░░░░░░░░░░░░░░░░░░░░  ",
  "████████████████████████████",
  "████████████████████████████",
  "    ▓▓▓▓            ▓▓▓▓    ",
  "    ▓▓▓▓            ▓▓▓▓    ",
  "   ▒▒▒▒              ▒▒▒▒   ",
  "  ░░░░                ░░░░  ",
];
const PI_LOGO_WIDTH = 28;
/** Per-row colour; `null` means the horizontal violet→cyan→violet crossbar. */
const PI_LOGO_KEYS: readonly (string | null)[] = [
  "borderMuted",
  null,
  null,
  "customMessageLabel",
  "customMessageLabel",
  "dim",
  "borderMuted",
];

/** Narrow-terminal π: same silhouette at 3 rows × 14 columns. */
const PI_COMPACT: readonly string[] = [
  "██████████████",
  "  ▓▓      ▓▓  ",
  " ▒▒        ▒▒ ",
];
const PI_COMPACT_WIDTH = 14;
const PI_COMPACT_KEYS: readonly (string | null)[] = [
  null,
  "customMessageLabel",
  "dim",
];

/**
 * Leading marker and filled glyph for the focused constellation entry. The
 * pointer is U+25B8 rather than the composer's `❯`: it is unambiguously
 * single-cell, so the two-column pointer gutter measures the same whether the
 * row is selected or not and the constellation never shifts as focus moves.
 */
const SELECTION_POINTER = "▸";
const SELECTED_GLYPH = "◆";

/** Quiet star fields that open and could seal the composition. Even widths. */
const STARFIELD_WIDE = "·         ⋆                    ⋆         ·";
const STARFIELD_NARROW = "·      ⋆    ⋆      ·";

/**
 * Center a styled row on the portal's single optical axis, which is the column
 * the π occupies: `floor((width - 1) / 2)`.
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
 * The crossbar's horizontal gradient: violet at the overhanging tips, cyan
 * through the core, so the bar reads as luminous rather than as a flat slab.
 */
function gradientBar(art: string, fg: Fg): string {
  const edge = Math.max(1, Math.round(art.length * 0.22));
  return (
    fg("customMessageLabel", art.slice(0, edge)) +
    fg("accent", art.slice(edge, art.length - edge)) +
    fg("customMessageLabel", art.slice(art.length - edge))
  );
}

/** The π logo, sized to the terminal. Returns rows plus their shared width. */
function logoBlock(fg: Fg, width: number, active: boolean): Block {
  if (width < MINIMAL_MIN) {
    return { rows: [fg("accent", "π")], blockWidth: 1 };
  }
  const full = width >= FULL_MIN;
  const art = full ? PI_LOGO : PI_COMPACT;
  const keys = full ? PI_LOGO_KEYS : PI_COMPACT_KEYS;
  const rows = art.map((row, index) => {
    const key = keys[index];
    if (key !== null && key !== undefined) return fg(key, row);
    // Focused: the crossbar burns to a single live accent instead of the
    // resting violet→cyan gradient. Colour only; the geometry never moves.
    return active ? fg("accent", row) : gradientBar(row, fg);
  });
  return { rows, blockWidth: full ? PI_LOGO_WIDTH : PI_COMPACT_WIDTH };
}

/** A single quiet star row; glyphs are tinted individually for depth. */
function starField(fg: Fg, width: number): string {
  const pattern = width >= FULL_MIN ? STARFIELD_WIDE : STARFIELD_NARROW;
  let out = "";
  let run = "";
  for (const character of pattern) {
    if (character === " ") {
      run += character;
      continue;
    }
    out += run;
    run = "";
    out += fg(character === "·" ? "borderMuted" : "dim", character);
  }
  return out;
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

/**
 * Twin constellation columns: PATHWAYS | INSTRUMENTS, composed as one
 * fixed-width unit whose gutter straddles the π column.
 */
function twinColumns(
  view: Observatory,
  fg: Fg,
  span: number,
  maxRows: number,
  selection: ObservatorySelection | undefined,
): Block {
  const pointer = selection?.active === true;
  const gutter = 6;
  const limit = Math.max(12, Math.floor((span - gutter) / 2));
  // Size both cells to the widest thing either column actually holds, so the
  // block is no wider than its content and its gutter lands on the π axis.
  const content = [
    ...view.pathways.slice(0, maxRows - 1),
    ...view.instruments.slice(0, maxRows - 1),
    ...view.specialists.slice(0, maxRows - 1),
  ].reduce(
    (widest, entry) =>
      Math.max(widest, safeVisibleWidth(entry.label) + 2 + (pointer ? 2 : 0)),
    0,
  );
  const columnWidth = Math.max(11, Math.min(limit, content));
  const gap = " ".repeat(gutter);
  // Prefer the classic pathway/instrument twin columns when both exist.
  // Specialists join the twin layout only when one of those is empty, so the
  // dense two-column rhythm stays intact on full-width terminals.
  const leftEntries =
    view.pathways.length > 0
      ? view.pathways
      : view.specialists;
  const rightEntries =
    view.instruments.length > 0
      ? view.instruments
      : view.pathways.length > 0
        ? view.specialists
        : [];
  const offsetOf = (entries: readonly FeaturedEntry[]): number => {
    if (entries === view.pathways) return 0;
    if (entries === view.instruments) return view.pathways.length;
    return view.pathways.length + view.instruments.length;
  };
  const leftOffset = offsetOf(leftEntries);
  const rightOffset = offsetOf(rightEntries);
  const leftTitle =
    leftEntries === view.specialists
      ? "SPECIALISTS"
      : leftEntries === view.instruments
        ? "INSTRUMENTS"
        : "PATHWAYS";
  const rightTitle =
    rightEntries === view.specialists
      ? "SPECIALISTS"
      : rightEntries === view.instruments
        ? "INSTRUMENTS"
        : "PATHWAYS";
  const leftGlyph =
    leftEntries === view.specialists
      ? "◎"
      : leftEntries === view.instruments
        ? "◈"
        : "◇";
  const rightGlyph =
    rightEntries === view.specialists
      ? "◎"
      : rightEntries === view.instruments
        ? "◈"
        : "◇";
  const rows: string[] = [
    padCell(fg("customMessageLabel", leftTitle), columnWidth) +
      gap +
      fg("customMessageLabel", rightTitle),
  ];
  const depth = Math.min(
    maxRows - 1,
    Math.max(leftEntries.length, rightEntries.length),
  );
  for (let index = 0; index < depth; index++) {
    const left = constellationCell(leftEntries[index], leftGlyph, fg, columnWidth, {
      pointer,
      selected: pointer && selection?.index === leftOffset + index,
    });
    const right = constellationCell(
      rightEntries[index],
      rightGlyph,
      fg,
      columnWidth,
      {
        pointer,
        selected: pointer && selection?.index === rightOffset + index,
      },
    );
    const row = right
      ? padCell(left, columnWidth) + gap + right
      : left;
    rows.push(row);
  }
  // Center on the block's real ink, not its nominal cells: the right column is
  // ragged, and centering on the nominal width pulls the unit off the π axis.
  const ink = rows.reduce((widest, row) => Math.max(widest, safeVisibleWidth(row)), 0);
  return { rows, blockWidth: evenSpan(ink + 1) };
}

/**
 * Single stacked constellation for narrow terminals, or when only one of the
 * two groups exists. Still centered as one fixed-width unit.
 */
function stackedColumns(
  view: Observatory,
  fg: Fg,
  span: number,
  maxRows: number,
  selection: ObservatorySelection | undefined,
): Block {
  const pointer = selection?.active === true;
  const columnWidth = Math.max(12, Math.min(34, span));
  // `offset` keeps the stacked layout on the same featured index order as
  // featuredAt(): pathways, instruments, specialists.
  const groups: {
    title: string;
    entries: readonly FeaturedEntry[];
    glyph: string;
    offset: number;
  }[] = [
    { title: "PATHWAYS", entries: view.pathways, glyph: "◇", offset: 0 },
    {
      title: "INSTRUMENTS",
      entries: view.instruments,
      glyph: "◈",
      offset: view.pathways.length,
    },
    {
      title: "SPECIALISTS",
      entries: view.specialists,
      glyph: "◎",
      offset: view.pathways.length + view.instruments.length,
    },
  ].filter((group) => group.entries.length > 0);
  // Each present group gets a heading; the remaining rows go to entries.
  const perGroup = Math.max(
    1,
    Math.floor((maxRows - groups.length) / Math.max(1, groups.length)),
  );
  const rows: string[] = [];
  for (const group of groups) {
    if (rows.length >= maxRows) break;
    rows.push(fg("customMessageLabel", group.title));
    const depth = Math.min(perGroup, group.entries.length);
    for (let index = 0; index < depth; index++) {
      if (rows.length >= maxRows) break;
      rows.push(
        `  ${constellationCell(group.entries[index], group.glyph, fg, columnWidth - 2, {
          pointer,
          selected: pointer && selection?.index === group.offset + index,
        })}`,
      );
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
  selection: ObservatorySelection | undefined,
): Block | undefined {
  if (width < MINIMAL_MIN) return undefined;
  if (
    view.pathways.length === 0 &&
    view.instruments.length === 0 &&
    view.specialists.length === 0
  ) {
    return undefined;
  }
  const full = width >= FULL_MIN;
  // Row budget = 22 minus the eleven fixed rows minus the logo's own height.
  const maxRows = full ? 4 : 8;
  // Twin columns need two populated sides. Prefer pathway|instrument; fall back
  // to pathway|specialist or specialist|instrument when one side is empty.
  const hasTwinPair =
    (view.pathways.length > 0 && view.instruments.length > 0) ||
    (view.pathways.length > 0 && view.specialists.length > 0) ||
    (view.instruments.length > 0 && view.specialists.length > 0);
  if (full && hasTwinPair) {
    return twinColumns(view, fg, span, maxRows, selection);
  }
  return stackedColumns(view, fg, span, full ? maxRows : 8, selection);
}

/**
 * Keyboard focus state for the interactive orb. `index` addresses the featured
 * entries in the same 0..5 order as {@link featuredAt}.
 */
export interface ObservatorySelection {
  index: number;
  active: boolean;
}

/**
 * Render the splash: star field → π logo → signal → constellations → meta →
 * threshold → horizon, on one optical axis with an even single-row rhythm.
 * Installed as Pi's startup header, so 22 rows is the budget, not 9.
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

  if (inner >= MINIMAL_MIN) {
    lines.push(center(starField(fg, inner), inner));
    lines.push("");
  }

  const logo = logoBlock(fg, inner, active);
  for (const row of logo.rows) lines.push(indent(row, logo.blockWidth, inner));

  lines.push("");
  lines.push(center(signalLine(view, fg, inner), inner));

  const constellations = constellationBlock(view, fg, inner, span, selection);
  if (constellations) {
    lines.push("");
    for (const row of constellations.rows) {
      lines.push(indent(row, constellations.blockWidth, inner));
    }
  }

  if (inner >= MINIMAL_MIN) {
    lines.push("");
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
 * Featured rows shown for keyboard/select launch. When pathways and instruments
 * both occupy the twin constellation, specialists stay available via
 * "All specialists…" rather than as invisible featured targets.
 */
export function featuredEntries(view: Observatory): FeaturedEntry[] {
  if (view.pathways.length > 0 && view.instruments.length > 0) {
    return [...view.pathways, ...view.instruments];
  }
  return [...view.pathways, ...view.instruments, ...view.specialists];
}

export function selectorOptions(view: Observatory): string[] {
  const featured = featuredEntries(view);
  const rows: string[] = featured.map((entry) => {
    const kind =
      entry.source === "skill"
        ? "instrument"
        : entry.source === "agent"
          ? "specialist"
          : "pathway   ";
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
    // Native commands need their executable pre-steps; mono-ui launches them
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
