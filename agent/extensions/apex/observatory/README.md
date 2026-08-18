# Observatory Landing Screen

The blank-chat landing screen lives in `apex/observatory/` and is mounted by `apex-ui.ts` via `ctx.ui.setHeader(...)` as Pi's startup header — not an above-editor widget — so with `quietStartup` it is the opening screen and has the full `OBSERVATORY_MAX_LINES` (25) budget rather than the 10-line above-editor cap.

```text
observatory/
├── observatory.ts        composition, inventory, glyph shark tiers, selectors
├── observatory-orb.ts    focus/selection state
├── shark-art.ts          truecolor pixel bitmaps (ULTRA / WIDE / MID)
├── pixel-art.ts          half-block pixel renderer + truecolor detection
├── star-field.ts         background star rows
├── preview.mjs           full-screen harness
└── sky-preview.mjs       star-field-only harness
```

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

Renders four inventory scenarios (populated user, balanced project, extension pathways, empty) at 40/60/80/100/120/160 columns — or the widths passed as arguments — approximates apex-dark on a dark background, flags `TOO TALL` / `OVERFLOW`, and exits nonzero on any bound failure. Check all three responsive glyph tiers (≥62, 20–61, <20 columns) when touching the art, and keep the harness in sync when `buildObservatory`/`renderObservatory` signatures change.

## Constraints

- Pure passive string rendering: no timers, no `requestRender()`, no Pi TUI `Text`, `Markdown`, or `Container`.
- Keep within `OBSERVATORY_MAX_LINES` (25) and stay dense rather than padded with blank lines.
- Color only through `theme.fg(key, text)`.
- The workspace signal must stay truthful — fall back to `AWAITING A SIGNAL` when no project-scoped resources exist.
