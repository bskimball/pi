# Observatory Landing Screen

The blank-chat landing screen lives in `apex/observatory/` and is mounted by `apex-ui.ts` via `ctx.ui.setHeader(...)` as Pi's startup header — not an above-editor widget — so with `quietStartup` it is the opening screen and has the full `OBSERVATORY_MAX_LINES` (25) budget rather than the 10-line above-editor cap.

```text
observatory/
├── observatory.ts        composition, inventory, glyph shark tiers, selectors
├── observatory-orb.ts    focus/selection state
├── shark-art.ts          truecolor pixel bitmaps (ULTRA / WIDE / MID)
├── hal-art.ts            truecolor HAL bitmaps, retained but not on the landing path
├── pixel-art.ts          half-block pixel renderer + truecolor detection
├── star-field.ts         background star rows
├── preview.mjs           full-screen harness
└── sky-preview.mjs       star-field-only harness
```

## Passive splash vs. the interactive orb

The passive splash is mark + invitation + horizon on **every** UI: no `CUSTOM PROMPTS` / `CUSTOM AGENTS` inventory, no workspace signal, no inventory counts (`4 prompts · 21 skills · 11 agents`), no `/observatory` hint, and no UI caption. The same entries stay reachable through the interactive orb (selection mode) and `/observatory`, both of which still render the full constellation; a focused orb also shows the key legend. `renderObservatory` gates inventory on the presence of a selection, not on the skin, so a new UI inherits the mark-only splash automatically.

| UI | Mark |
| --- | --- |
| Apex | shark over the star field |
| Claude | wide block-art critter |
| HAL | truecolor lens orb + striped `HAL` wordmark |

## HAL skin

`/ui hal` shows a lens orb above a striped `HAL` wordmark instead of the shark and star field, with the same keyboard navigation. Every cell is an upper-half block (`▀`, U+2580), so each terminal row lights only its top half and leaves its bottom half dark — continuous horizontal scanlines at row granularity, with no wide, ambiguous or combining glyph and no generated bitmap. A single dark row separates orb from wordmark, as the desktop hero sets them. The splash is the lockup plus invitation and horizon: no `OPERATIONS CONSOLE` label, no workspace signal, no inventory counts.

Two width tiers, both gated on `HAL_FULL_MIN` (62) so the interactive orb still has room for the constellation beneath the mark:

| Tier | Orb | Wordmark | Block | Requires |
| --- | --- | --- | --- | --- |
| Full | 9 rows × 18 columns | 8 rows × 31 columns, two-cell strokes | 18 rows, width 31 | width ≥ `HAL_FULL_MIN` (62) |
| Compact | 7 rows × 14 columns | 8 rows × 18 columns, one-cell strokes | 16 rows, width 18 | width ≥ `MINIMAL_MIN` (20) |

Below 20 columns it reduces to a single `▀`. This deliberately mirrors the HAL Desktop app: desktop brand crimson `#9e1b32`, the titlebar's solid-to-translucent horizontal banding, and the `HalHeroOrb` lens.
No Work source or desktop runtime is imported.

### The orb is computed, not drawn

`landing.ts` has no orb art array. `discRadii()` assigns every cell a normalized radius (rows and columns normalized independently, so a 9 × 18 grid reads as a circle on a grid whose cells are roughly twice as tall as they are wide), and the colour comes from that radius alone. Geometry and shading therefore cannot drift apart, and a tier resize needs no re-authoring.

The mark is the HAL 9000 lens: a radiant yellow pupil at the centre, a concentric crimson glow falling outward, and a dark bronze/charcoal bezel at the limb. `ORB_RAMP` holds the stops, in normalized radius:

| r | Colour | Band |
| --- | --- | --- |
| 0.00 | `#fff59d` | radiant yellow core |
| 0.13 | `#ffeb3b` | bright yellow |
| 0.26 | `#f59e0b` | warm amber |
| 0.36 | `#f02c44` | glowing red |
| 0.48 | `#e0223a` | bright red |
| 0.66 | `#9e1b32` | brand crimson |
| 0.84 | `#4a0e18` | dark crimson |
| 0.92 | `#352018` | bronze bezel |
| 1.00 | `#28161c` | charcoal bezel |

- **Truecolor** (`TRUECOLOR` from `pixel-art.ts`): each cell is inked with its own interpolated RGB as `\x1b[38;2;R;G;Bm…\x1b[39m`, with equal-coloured neighbours coalesced into runs so a row emits about one escape per colour change rather than one per cell. Terminating with `\x1b[39m` rather than `\x1b[0m` keeps any outer background intact, unlike `pixelRows`.
- **Fallback**: the same geometry collapses to three theme keys by radius — `warning` inside 0.30 (amber in every bundled theme), `brand` out to 0.84, `brandDim` beyond. Precomputed as run-length pairs at module load.
- Cells outside the disc are plain spaces, so each row's visible width is exactly the tier width and centering needs no measurement.

### The wordmark is eight uniform bars

Paul Rand's IBM mark is eight bars of *uniform* intensity — the stripes are cut by the letterform, never by shading. Every wordmark row is therefore inked with the same `brand` key. There is no per-row key tuple; do not reintroduce one, and do not dim a row.

Letterforms follow City Medium slab-serif construction: slab serifs top and bottom, `H` with its crossbar on bars 4–5, `A` with a flat slab apex, legs stepping outward and a crossbar on bar 5, and `L` whose foot begins turning on bar 7 and completes as a full-width slab on bar 8, aligned at column 0 with the top serif. Strokes must stay at least two cells wide at the full tier, or the scanlines eat the letterform instead of banding it.

### Other rules

- `hal-art.ts` and `tools/hal-art/emit-ts.py` are retained as generated assets but are no longer on the landing path. The file is still generated — do not hand-edit it — and the landing no longer imports it.
- Why identity crimson is safe here: it lives only on dedicated `brand`/`brandDim` theme keys in `hal-dark.json`, never on `error`/`red`. Status semantics stay unambiguous because the two vocabularies share no keys. The pupil's `warning` key is the one status key the mark borrows, for amber. Under any other theme the mark degrades to accent/muted rather than throwing (`halFg`).
- The blank separator row costs one constellation row in selection mode at the full tier. Selection mode saturates `OBSERVATORY_MAX_LINES` exactly; adding another mark row would drop a second inventory row.

Preview with the real HAL theme and the same bounds checks. Check both width
tiers, and check the fallback by unsetting the truecolor signals:

```bash
PI_UI_SKIN=hal node --experimental-transform-types agent/extensions/apex/observatory/preview.mjs 8 19 20 40 62 80 120 160
env -u WT_SESSION -u COLORTERM -u VSCODE_INJECTION -u TERM_PROGRAM PI_UI_SKIN=hal \
  node --experimental-transform-types agent/extensions/apex/observatory/preview.mjs 80
```

## Claude skin

`/ui claude` shows the Claude critter: an original block-art robot head in the same layout language Claude Code uses on its blank screen — square head with side ears, two dark slit eyes, and a split-foot body in terracotta. Eyes and gaps are plain spaces so the terminal background shows through, avoiding a theme-key gamble for a contrasting pupil color.

Proportions are deliberately wide and short. Terminal cells are roughly twice as tall as they are wide, so an equal-count grid renders as a stretched, skinny column; the full tier is 29 cells across × 7 rows and the compact tier 19 × 5, which read as a squat, friendly critter instead. Geometry is static on focus, like the HAL mark: selection never moves or recolors the art.

## Shark Wordmark

A hand-authored side-profile great white swimming left over a quiet star field (`logoBlock` in `observatory.ts`). Tiers, widest first:

| Tier | Source | Requires |
| --- | --- | --- |
| `SHARK_PIXELS_ULTRA` (112 cols) | `shark-art.ts` | truecolor |
| `SHARK_PIXELS_WIDE` (72) | `shark-art.ts` | truecolor |
| `SHARK_PIXELS_MID` (48) | `shark-art.ts` | truecolor |
| `SHARK_LOGO` (56) | `observatory.ts` | width ≥ `FULL_MIN` (62) |
| `SHARK_COMPACT` (18) | `observatory.ts` | width ≥ `MINIMAL_MIN` (20) |
| `SHARK_MINIMAL` (`▴`) | `observatory.ts` | any |

Pixel tiers are skipped entirely without 24-bit color, so the glyph tiers are what most terminals show.

- Tier widths and row heights are load-bearing. Changing art must update the matching `*_WIDTH` and `*_KEYS` arrays together or `indent()`/`center()` breaks. Logo height also feeds `constellationBlock`'s row budget.
- Countershading comes from color, not glyph noise: per-row theme keys in `SHARK_LOGO_KEYS`/`SHARK_COMPACT_KEYS`, plus one `null`-keyed lateral-line row rendered by `lateralLine()`.
- Geometry is static on focus. When the orb is active only the lateral line's color changes; art arrays never vary by selection or focus.
- Use narrow block glyphs (`█ ▓ ▒ ░ ▀ ▄`) only.
- Any silhouette change must stay recognizably a shark in profile at the full tier and keep the compact-tier cues: dorsal fin, snout, belly, forked tail.
- `shark-art.ts` is generated; do not hand-edit it (see `CONTEXT.md`).

## Preview Harness

Do not iterate on this surface through screenshots.

```
node --experimental-transform-types agent/extensions/apex/observatory/preview.mjs
node --experimental-transform-types agent/extensions/apex/observatory/preview.mjs 80
node --experimental-transform-types agent/extensions/apex/observatory/sky-preview.mjs
```

Renders four inventory scenarios (populated user, balanced project, extension pathways, empty) at 40/60/80/100/120/160 columns — or the widths passed as arguments — approximates apex-dark on a dark background, flags `TOO TALL` / `OVERFLOW`, and exits nonzero on any bound failure. Check all three responsive glyph tiers (≥62, 20–61, <20 columns) when touching the art, and keep the harness in sync when `buildObservatory`/`renderObservatory` signatures change. The harness renders the passive splash, so the inventory scenarios exercise counts and bounds rather than a visible constellation; use the interactive orb or `/observatory` to see the constellation itself.

## Constraints

- Pure passive string rendering: no timers, no `requestRender()`, no Pi TUI `Text`, `Markdown`, or `Container`.
- Keep within `OBSERVATORY_MAX_LINES` (25) and stay dense rather than padded with blank lines.
- Color only through `theme.fg(key, text)`.
- The workspace signal is not drawn on the splash. `NEUTRAL_SIGNAL` (`AWAITING A SIGNAL`) remains the truthful fallback for Observatory data used by `/observatory` and the interactive orb.
