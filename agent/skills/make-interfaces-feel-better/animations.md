# Animations

The Animation Decision Framework, custom easing curves, durations, spring physics, component motion patterns, `clip-path`, gestures, contextual icons, and reduced-motion accessibility.

## The Animation Decision Framework

Before writing any animation code, answer these four questions in order:

### 1. Should this animate at all?

Ask how often users will see the animation:

| Frequency | Decision |
| --- | --- |
| **100+ times/day** (keyboard shortcuts, command palette toggle, quick switcher) | **No animation. Ever.** |
| **Tens of times/day** (hover effects, list/table navigation, tab switches) | Remove or reduce to `≤150ms` opacity/color transition |
| **Occasional** (modals, drawers, toasts, dropdowns, popovers) | Standard UI animation |
| **Rare / first-time** (onboarding, empty-state hero, celebrations) | Can add staged delight or stagger |

**Never animate keyboard-initiated actions.** Actions repeated hundreds of times daily feel slow, delayed, and disconnected when animated. Raycast has no open/close animation — that is the optimal experience for high-frequency tools.

### 2. What is the purpose?

Every animation must answer "why does this animate?":
- **Spatial consistency** — a toast or drawer enters and exits along the same axis, making swipe-to-dismiss intuitive.
- **State indication** — a morphing button or icon confirms a state transition.
- **Feedback** — a button scales down on press (`scale(0.96)`–`scale(0.97)`), confirming the UI heard the user.
- **Preventing jarring changes** — elements appearing or disappearing smoothly instead of popping.
- **Explanation** — onboarding or marketing motion that demonstrates how a feature works.

If the purpose is just "it looks cool" and the user will see it often, do not animate. Motion is never the only feedback channel — every animated state change also needs a static cue (color, icon, or label).

### 3. What easing should it use?

```text
Is the element entering or exiting?
  Yes -> ease-out (starts fast, feels immediately responsive)
  No  ->
    Is it moving or morphing on screen?
      Yes -> ease-in-out (natural acceleration and deceleration)
    Is it a hover or color change?
      Yes -> ease
    Is it constant motion (marquee, hold-to-delete progress, spinner)?
      Yes -> linear
    Default -> ease-out
```

**Critical: use custom easing curves.** Built-in CSS easings (`ease-out`, `ease-in-out`) are too weak and lack intentional punch:

```css
:root {
  /* Strong ease-out for entering/exiting UI interactions */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);

  /* Strong ease-in-out for on-screen movement/morphing */
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);

  /* iOS-like drawer curve (Ionic / Vaul) */
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
}
```

**Never use `ease-in` for UI animations.** `ease-in` starts slow, delaying movement at the exact millisecond the user is watching most closely. A `300ms ease-in` dropdown feels sluggish compared to `300ms ease-out`.

### 4. How fast should it be?

| Element | Duration |
| --- | --- |
| Button press feedback (`:active`) | `100–160ms` |
| Tooltips, small popovers | `125–200ms` |
| Dropdowns, selects, menus | `150–250ms` |
| Modals, drawers, toasts | `200–500ms` |
| Hold-to-delete / deliberate press | `~2000ms linear` (with `200ms ease-out` release) |

**Rule: UI animations should stay under 300ms.** Speed shapes perceived performance: a `180ms` select feels snappier than a `400ms` one, a faster spinner makes identical load times feel shorter, and skipping delay/animation on subsequent tooltips makes an entire toolbar feel instant.

---

## Interruptible Animations: CSS Transitions vs. Keyframes

Users change intent mid-interaction. If animations aren't interruptible, the interface snaps or restarts from zero.

| | CSS Transitions / Springs | CSS Keyframe Animations |
| --- | --- | --- |
| **Behavior** | Interpolate toward latest target | Run on a fixed timeline |
| **Interruptible** | Yes — retargets smoothly mid-flight | No — restarts from zero or snaps |
| **Use for** | Dynamic UI state changes (toggle, open/close, toasts, hover) | Staged sequences that run once (initial hero stagger, continuous loops) |

```css
/* Good — interruptible transition for a drawer or toast */
.drawer {
  transform: translateX(-100%);
  transition: transform 200ms var(--ease-out);
}
.drawer.open {
  transform: translateX(0);
}
```

---

## Spring Animations

Springs simulate physical velocity and settle naturally without fixed durations, maintaining momentum when interrupted mid-gesture.

### When to Use Springs
- Drag interactions with momentum (drawers, swipeable cards)
- Elements that should feel alive (Dynamic Island-style morphs, contextual icon swaps)
- Gestures that frequently reverse mid-motion
- Decorative pointer-tracking interactions (never functional charts where precision matters)

### Spring Configuration

```js
// Apple-style duration + bounce (recommended — easiest to reason about)
{ type: "spring", duration: 0.5, bounce: 0.2 }

// Non-bouncy UI spring (contextual icons, crisp layout transitions)
{ type: "spring", duration: 0.3, bounce: 0 }

// Traditional physics (fine-grained control, e.g., useSpring on mouse tracking)
{ type: "spring", mass: 1, stiffness: 100, damping: 10 }
```

Keep bounce `0` in most standard UI contexts, or subtle (`0.1–0.3`) for drag-to-dismiss and playful surfaces.

---

## Component Motion Principles

### Never Animate from `scale(0)`

Nothing in the real world disappears to zero and materializes from nothing. Elements starting at `scale(0)` look unnatural. Start from `scale(0.95)` (or `≥0.9`) combined with `opacity: 0`:

```css
/* Bad */
.entering { transform: scale(0); }

/* Good */
.entering {
  transform: scale(0.95);
  opacity: 0;
}
```

### Make Popovers Origin-Aware

Popovers, dropdowns, and menus should scale from their trigger, not from `center`. **Exception: modals**, which are viewport-centered rather than trigger-anchored and keep `transform-origin: center`.

```css
/* Base UI / Radix origin variable */
.popover {
  transform-origin: var(--transform-origin);
  transition: transform 150ms var(--ease-out), opacity 150ms var(--ease-out);
}
```

### Tooltips: Skip Delay and Animation on Subsequent Hovers

Delay the first tooltip to prevent accidental activation on pass-through, but once any tooltip in a group is open, open adjacent tooltips immediately with `0ms` duration:

```css
.tooltip {
  transition: transform 125ms var(--ease-out), opacity 125ms var(--ease-out);
  transform-origin: var(--transform-origin);
}

.tooltip[data-starting-style],
.tooltip[data-ending-style] {
  opacity: 0;
  transform: scale(0.97);
}

/* Skip animation on subsequent adjacent tooltips */
.tooltip[data-instant] {
  transition-duration: 0ms;
}
```

### Animate Entry with `@starting-style`

When browser support allows, use `@starting-style` to animate initial DOM insertion in pure CSS without a React `useEffect(() => setMounted(true), [])`:

```css
.toast {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 300ms var(--ease-out), transform 300ms var(--ease-out);

  @starting-style {
    opacity: 0;
    transform: translateY(100%);
  }
}
```

### Percentage `translateY` for Height-Independent Motion

Percentage values in `translate()` are relative to the element's own box. Use `translateY(100%)` or `translateY(-100%)` for drawers and toasts instead of hardcoded pixel heights.

### Use Blur to Mask Imperfect Crossfades

When a crossfade between two states still looks like two distinct objects overlapping, add `filter: blur(2px)` (up to `4px`; keep well under `20px` for Safari performance) during the transition so the eye perceives one smooth morph:

```css
.button-content {
  transition: filter 200ms ease, opacity 200ms ease;
}
.button-content.transitioning {
  filter: blur(2px);
  opacity: 0.7;
}
```

---

## Contextual Icon Animations

When icons swap state (play → pause, copy → check, bookmark toggle), animate `opacity`, `scale`, and `blur` rather than toggling visibility abruptly.

- **Exact values:** `scale` from `0.25` to `1`, `opacity` from `0` to `1`, `filter` from `"blur(4px)"` to `"blur(0px)"`.
- **With `motion` or `framer-motion`** (match the package already in `package.json`): use `AnimatePresence initial={false} mode="popLayout"` and `transition={{ type: "spring", duration: 0.3, bounce: 0 }}` (bounce **must** be `0`).
- **Without a motion library:** keep both icons in the DOM (one `absolute inset-0`) and cross-fade with `transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]`. Do not install a motion library just for icon swaps.

```tsx
import { AnimatePresence, motion } from "motion/react";

function IconButton({ isActive, icon: Icon }) {
  return (
    <button>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={isActive ? "active" : "inactive"}
          initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        >
          <Icon />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
```

---

## Scale on Press & Skip Animation on Page Load

### Scale on Press

Add `scale(0.96)` or `scale(0.97)` on `:active` (`100–160ms ease-out`) so buttons feel tactile (`scale()` proportionally scales text and child icons too). Never use a value below `0.95`. Provide a `static` prop on shared `<Button>` components to opt out where press scaling would distract.

```tsx
const tapScale = "active:not-disabled:scale-[0.96]";

function Button({ static: isStatic, className, children, ...props }) {
  return (
    <button
      className={cn(
        "transition-transform duration-150 ease-out",
        !isStatic && tapScale,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
```

### Skip Animation on Initial Mount

Use `initial={false}` on `AnimatePresence` for toggles, tabs, segmented controls, and icon swaps so elements already in their default state do not animate in on page load. Omit `initial={false}` only when an intentional first-load entrance animation depends on `initial="hidden"`.

---

## Enter Stagger & Asymmetric Exit Animations

### Split and Stagger Enter Animations

For infrequent staged entrances (first load of a hero, empty state, or onboarding card), split content into semantic chunks (title, description, actions) and stagger by `30–100ms` (`opacity: 0 → 1`, `translateY(8px–12px) → 0`, optional `blur(4px) → 0`). Never block user interaction while stagger animations play, and never stagger high-frequency lists or hovers.

### Subtle & Asymmetric Exits

The user's attention has already moved to what's next — exits should be faster and gentler than enters:
- **Subtle exit (default):** small fixed `translateY(-12px)` + `opacity: 0` over `150ms ease-out` instead of collapsing full height.
- **Full spatial exit:** `translateX(-100%)` or `translateY(100%)` over `200ms var(--ease-out)` when preserving drawer/toast spatial origin.
- **Deliberate hold vs. release:** slow where the user is deciding (`2s linear` on `:active` hold-to-delete), snappy where the system responds (`200ms ease-out` on release).

---

## `clip-path: inset()` for Hardware-Accelerated Animation

`clip-path: inset(top right bottom left)` clips an element inward from each edge and animates smoothly without extra layout cost:

1. **Hold-to-delete button:** place a colored overlay with `clip-path: inset(0 100% 0 0)`. On `.button:active .overlay`, transition to `inset(0 0 0 0)` with `transition: clip-path 2s linear`; on release, snap back with `transition: clip-path 200ms ease-out`.
2. **Tabs with seamless color transitions:** duplicate the tab list, style the top copy as the active state (background + contrasting text color), and animate `clip-path: inset(...)` over the active tab's bounds so text and indicator recolor in perfect lockstep.
3. **Scroll image reveals:** start at `clip-path: inset(0 0 100% 0)` and transition to `inset(0 0 0 0)` once in view (`IntersectionObserver` or `useInView` with `{ once: true, margin: "-100px" }`).
4. **Comparison sliders:** stack two images and adjust the top layer's `clip-path: inset(0 ${rightPercent}% 0 0)` on drag.

---

## Gesture and Drag Interactions

When building swipeable drawers, sheets, toasts, or cards:

1. **Momentum / velocity dismissal:** do not require dragging past a large distance threshold if the user flicks quickly. Compute velocity (`Math.abs(dragDistance) / elapsedTimeMs`) and dismiss when `velocity > 0.11` even on short drags:
   ```js
   const elapsed = Date.now() - dragStartTime.current;
   const velocity = Math.abs(swipeAmount) / elapsed;
   if (Math.abs(swipeAmount) >= SWIPE_THRESHOLD || velocity > 0.11) {
     dismiss();
   }
   ```
2. **Boundary damping / friction:** when dragging past the natural boundary (e.g., pulling an open drawer further up), apply progressive damping rather than a hard stop — nothing in the physical world stops instantaneously without give.
3. **Pointer capture:** call `setPointerCapture(e.pointerId)` once dragging starts so tracking continues smoothly if the pointer leaves the element bounds.
4. **Multi-touch protection:** ignore secondary touch points once `isDragging` is true so switching fingers mid-drag does not jump the element to a new coordinate.

---

## Accessibility: `prefers-reduced-motion`

Reduced motion means **fewer and gentler** animations, not zero feedback. Remove position, slide, and scale movement while preserving quick opacity or color transitions (`~150–200ms`) that aid comprehension:

```css
@media (prefers-reduced-motion: reduce) {
  .drawer,
  .toast,
  .popover {
    transition: opacity 150ms ease;
    transform: none !important;
  }
}
```
