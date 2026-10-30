---
name: make-interfaces-feel-better
description: >-
  Emil Kowalski design engineering principles (emil-design-eng) for UI polish, component craft, animations, and invisible details that make software feel right. Use whenever building or reviewing UI components, frontend code, animations, CSS transitions, springs, keyframes, clip-path, gestures/drag, popovers, tooltips, drawers, toasts, modals, hover/active states, shadows, borders, typography, or icons. Supports quick and full review modes. Triggers on UI, animation, animations, design engineering, emil-design-eng, UI polish, design details, "make it feel better", "feels off", easing, cubic-bezier, spring animation, clip-path, stagger animations, border radius, optical alignment, font smoothing, tabular numbers, image outlines, box shadows, icons, motion restraint.
---

# Details that make interfaces feel better

Great interfaces rarely come from a single thing. Unseen details compound: when every interaction, transition, and surface behaves the way someone assumes it should, they proceed without a second thought. Apply Emil Kowalski's design engineering principles whenever building or reviewing UI and animation code.

Before writing or suggesting a fix, identify the project's existing styling system and express the change in that system: Tailwind in a Tailwind project, plain CSS in a CSS project, or the established CSS-in-JS approach. Never introduce a second styling system just to apply a polish fix.

When reviewing or debugging, slow the interface down: replay motion at 10%–20% speed (or frame-by-frame in Chrome DevTools' Animations panel) and walk every state: hover, focus, active, loading, empty. Check whether states overlap awkwardly, whether easing starts/stops abruptly, whether `transform-origin` matches the trigger, and whether coordinated properties (`opacity`, `transform`, `filter`) stay in sync.

## Quick Reference

| Category | When to Use |
| --- | --- |
| [Animations](animations.md) | Animation decision framework (frequency, purpose, custom easing curves, `<300ms` duration table), springs, interruptible transitions vs. keyframes, `@starting-style`, origin-aware popovers, instant subsequent tooltips, blur crossfades, `clip-path: inset()`, gesture/drag physics, contextual icons, scale on press, stagger, reduced motion |
| [Surfaces](surfaces.md) | Concentric border radius, optical alignment, layered shadows vs. structural borders, `1px` neutral image outlines, minimum hit areas (`44×44px` touch / `40×40px` desktop), touch-device hover media queries, Sonner component craft principles |
| [Typography](typography.md) | Text wrapping (`balance` vs. `pretty`), macOS font smoothing (`antialiased`), tabular numbers (`tabular-nums`) |
| [Icons](icons.md) | Icon stroke weight matched to text weight, states via `currentColor`, outline vs. fill, render-size testing, RTL flipping |
| [Performance](performance.md) | Transition specificity (never `all`), GPU-only properties (`transform`, `opacity`), CSS variable inheritance recalc trap, Framer Motion `transform` string vs. `x`/`y` under load, WAAPI, sparing `will-change` |

## The Animation Decision Framework

Before writing any animation code, answer these four questions in order (full details and code patterns in [animations.md](animations.md)):

1. **Should this animate at all?** Decide by frequency:
   - **100+ times/day** (keyboard shortcuts, command palette toggle): **No animation. Ever.** Never animate keyboard-initiated actions.
   - **Tens of times/day** (hover effects, list navigation): remove or keep to `≤150ms` opacity/color transition.
   - **Occasional** (modals, drawers, toasts, popovers): standard UI animation.
   - **Rare / first-time** (onboarding, celebrations, page hero): can add staged delight or stagger.
2. **What is the purpose?** Spatial consistency, state indication, feedback, explanation, or preventing jarring layout/visibility jumps. If the only reason is "it looks cool" on a frequent surface, don't animate.
3. **What easing should it use?** Built-in CSS easings are too weak; prefer custom curves (`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`, `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`). **Never use `ease-in` for UI** — it delays initial movement and feels sluggish. Enter/exit → `ease-out`; on-screen morph/move → `ease-in-out`; hover/color → `ease`; constant progress/marquee → `linear`.
4. **How fast should it be?** Keep UI animations **under 300ms**: button press `100–160ms`, tooltips/small popovers `125–200ms`, dropdowns/selects `150–250ms`, modals/drawers `200–500ms`. Fast motion improves perceived performance.

## Core Principles

### 1. Concentric Border Radius

Outer radius = inner radius + padding (when padding `≤24px`). Mismatched radii on nested elements is the most common thing that makes interfaces feel pinched.

### 2. Optical Over Geometric Alignment

When geometric centering looks off, align optically. Buttons with text + icon (`icon-side padding = text-side padding - 2px`), play triangles (`+2px` right), and asymmetric icons need optical adjustment.

### 3. Shadows for Elevation, Borders for Structure

For buttons, cards, and elevated containers, prefer layered transparent `box-shadow` values that adapt to any background. Keep solid borders that communicate structure or state: dividers, table cells, form inputs, and focus rings.

### 4. Interruptible Transitions Over Keyframes

Use CSS transitions (or springs) for interactive state changes so rapid toggles smoothly retarget mid-flight. Reserve `@keyframes` for one-shot staged sequences.

### 5. Never Animate from `scale(0)` & Keep Popovers Origin-Aware

Nothing in the real world appears from nothing: start entering elements at `scale(0.95)` (or `≥0.9`) with `opacity: 0`. Scale popovers, dropdowns, and menus from their trigger (`transform-origin: var(--transform-origin)`), never `center` (modals stay centered). On tooltips, delay the first hover, then skip both delay and duration (`transition-duration: 0ms` via `[data-instant]`) on adjacent hovers while open.

### 6. Asymmetric Enter/Exit & Staggered Entrances

Exits should be faster and subtler than enters (e.g., `150ms` small fixed `translateY(-12px)` exit vs. `200–300ms` enter; or `2s linear` hold-to-delete press vs. `200ms ease-out` release). For infrequent staged entrances, split content into semantic chunks with short stagger (`30–100ms`) and never block interaction while staggering.

### 7. Contextual Icon & State Crossfades with Blur

Use `filter: blur(2px–4px)` to mask imperfect state crossfades so two overlapping states read as one transformation. For contextual icon swaps, animate `scale` (`0.25 → 1`), `opacity` (`0 → 1`), and `blur` (`4px → 0px`) with `{ type: "spring", duration: 0.3, bounce: 0 }` in Motion or a two-icon DOM cross-fade with `cubic-bezier(0.2, 0, 0, 1)` in pure CSS.

### 8. `clip-path: inset()` & Percentage Transforms

Use `clip-path: inset(top right bottom left)` for hardware-accelerated reveals, seamless active-tab color overlays, hold-to-delete progress fills, and comparison sliders. Use percentage `translateY(100%)` / `translateY(-100%)` on drawers and toasts so movement adapts to any element height.

### 9. Natural Gestures, Springs, and Momentum

For drag/swipe interactions, dismiss on velocity (`Math.abs(distance) / elapsed > 0.11`) as well as distance threshold, apply boundary damping/friction instead of hard stops, capture pointer events on drag start, and ignore extra touch points mid-drag. Use springs (`{ type: "spring", duration: 0.5, bounce: 0.2 }` or stiffness/damping) when momentum and velocity-preserving interruption matter.

### 10. Font Smoothing, Tabular Numbers & Text Wrapping

Apply `-webkit-font-smoothing: antialiased` once at the root layout on macOS. Use `font-variant-numeric: tabular-nums` on dynamically updating numbers, counters, timers, and numeric columns. Use `text-wrap: balance` on headings (`≤6` lines) and `text-wrap: pretty` on short-to-medium body copy.

### 11. Neutral `1px` Image Outlines

Add an inset `1px` outline (`outline-offset: -1px`) to images for consistent depth: pure black in light mode (`oklch(0 0 0 / 0.1)`) and pure white in dark mode (`oklch(1 0 0 / 0.1)`), never a tinted palette neutral.

### 12. Scale on Press & Skip Mount Animation

Apply a subtle `scale(0.96)`–`scale(0.97)` on `:active` (`100–160ms ease-out`) so pressable controls feel responsive; never go below `0.95`, and support a `static` opt-out prop where motion distracts. Use `initial={false}` on `AnimatePresence` (or `@starting-style` carefully) so default-state controls don't animate on initial page load.

### 13. Touch Hover Gating, Minimum Hit Area & Reduced Motion

Gate hover transforms/effects behind `@media (hover: hover) and (pointer: fine)` so touch taps don't trigger sticky false hovers. Ensure a `44×44px` hit area on touch/mobile (`≥40×40px` in dense desktop UI) via pseudo-elements without overlapping neighbors. Under `prefers-reduced-motion: reduce`, remove position/scale movement while preserving opacity/color cues.

### 14. Compositor-Only Performance & Specific Transitions

Never use `transition: all` — always name exact properties (`transition-property: transform, opacity`). Animate only `transform`, `opacity`, and `filter`. Avoid updating inherited CSS variables on parent containers during drag/frame loops (set `element.style.transform` directly). Under main-thread load in Motion, use `animate={{ transform: "translateX(100px)" }}` (or CSS/WAAPI) instead of shorthand `x`/`y`. Use `will-change` only for `transform`, `opacity`, or `filter` when fixing observed first-frame stutter.

### 15. Icon Weight & State Discipline

Match icon stroke width to adjacent text weight (`1.5px` beside 400 regular, `2px` beside 500–600 semibold). Use a single `currentColor` SVG for hover/active/disabled states; outline is default, fill marks the active state.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| `transition: all` on elements | Specify exact properties: `transition: transform 160ms ease-out` |
| `scale(0)` entry animation | Start from `scale(0.95)` with `opacity: 0` |
| `ease-in` on UI element | Switch to `ease-out` or custom `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` |
| `transform-origin: center` on popover/dropdown | Scale from trigger (`var(--transform-origin)`); keep modals centered |
| Animation on keyboard shortcut / command palette | Remove animation entirely (instant open/close) |
| UI transition duration `>300ms` | Reduce to `125–250ms` (`100–160ms` for button press) |
| Hover animation firing on touch tap | Wrap hover effect in `@media (hover: hover) and (pointer: fine)` |
| Keyframes on rapidly-triggered UI | Use CSS transitions or springs for smooth retargeting |
| Updating `--css-var` on parent during drag | Write `element.style.transform` directly to avoid child style recalc |
| Framer Motion `x`/`y` dropping frames under load | Use `transform: "translateX(...)"` string, CSS transitions, or WAAPI |
| Same border radius on parent and child | Calculate `outerRadius = innerRadius + padding` |
| Icons look off-center | Adjust optically (`icon-side padding = text-side - 2px`, play icon `+2px`) |
| Border used only to fake elevation | Use layered transparent `box-shadow`; keep structural/state borders |
| Numbers cause layout shift | Apply `font-variant-numeric: tabular-nums` |
| Animation plays on initial page mount | Add `initial={false}` to `AnimatePresence` |
| Tiny hit areas on small controls | Extend with pseudo-element to `44×44px` touch / `40×40px` desktop |

## Review Output Format

When reviewing UI or animation code, use `full` mode when no mode is specified.

| Mode | Coverage | Finding cap |
| --- | --- | --- |
| `quick` | Primary user path and highest-traffic states; report only `HIGH` and `MEDIUM` issues | 5 |
| `full` | Entire requested scope across animations, surfaces, typography, icons, and performance | 15 |

### Scope and Coverage

State the mode, exact scope, framework, styling conventions, and any review boundary. Show what was actually inspected:

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Animations | Files, components, states, or checks | Findings count, `Clear`, or `Not reviewed` with a reason |

Include all five Quick Reference categories. Never imply an uninspected surface was reviewed.

### Findings

Group findings by principle. You **MUST** use an actual markdown table with **Severity**, **Location**, **Before**, **After**, and **Why** columns (or `| Before | After | Why |` for quick snippet reviews). Include every change made or proposed. **Never** output separate `Before:` / `After:` lines outside a table.

- **Severity**: `HIGH` makes an interaction inaccessible, sluggish on keyboard/high-frequency paths, unreadable, or repeatedly disruptive; `MEDIUM` creates a noticeable usability, motion, or consistency problem; `LOW` is isolated polish and appears only in `full` mode.
- **Location**: cite `path/to/file:line`. If the artifact has no source files, cite the exact screen and component instead.
- **Before / After**: show the current implementation and an actionable replacement in the project's styling system.
- **Why**: name the violated principle and explain its user impact.

Consolidate a repeated systemic issue into one row and list every affected location. Omit principles with no findings and never pad the report to reach the cap.

### Considered but Rejected

Include 1–3 real candidates in `quick` mode and 2–5 in `full` mode:

| Location | Candidate | Rejected because |
| --- | --- | --- |
| `src/CommandMenu.tsx:42` | Add fade/scale open transition | Command palette is keyboard-triggered 100+ times/day; zero animation is optimal |

Do not invent filler. If the scope contains fewer borderline candidates, include the ones that exist and say so.

### Verification and Verdict

After the findings:

1. **Verification**: list the exact commands or interactions run and their observed results. Walk every relevant state and inspect motion at slow speed / frame-by-frame when animation is involved. If a check was not run, label it **Not verified** and state what remains.
2. **Verdict**: `Block` if any `HIGH` finding remains, `Needs changes` if only `MEDIUM` or `LOW` findings remain, and `Approve` only when no actionable findings remain. List every unverified check beside the verdict.

When there are no findings, omit the findings table, state "No actionable interface-polish findings", report verification and rejected candidates, and end with `Approve`.
