# Performance

Transition specificity, GPU-composited properties, CSS variable recalculation traps, Framer Motion under load, WAAPI, and `will-change`.

## Transition Only What Changes

Never use `transition: all` or Tailwind's `transition-all`. Always specify the exact properties that change. Tailwind's bare `transition` maps to a curated default list of colors, opacity, shadow, and transforms, not to `all`; still prefer naming exactly what changes.

### Why

- `transition: all` forces the browser to watch every property for changes
- Causes unexpected transitions on properties you didn't intend to animate (colors, padding, shadows)
- Prevents browser optimizations

```css
/* Good — only transition what changes */
.button {
  transition-property: scale, background-color;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
}

/* Bad — transition everything */
.button {
  transition: all 150ms ease-out;
}
```

### Tailwind `transition-transform` Note

`transition-transform` in Tailwind maps to `transition-property: transform, translate, scale, rotate` — it covers all transform-related properties, not just `transform`. Use this when you're only animating transforms. For multiple non-transform properties, use the bracket syntax: `transition-[scale,opacity,filter]`.

---

## Animate Only Compositor Properties (`transform`, `opacity`)

`transform` and `opacity` skip layout and paint, running on the GPU compositor thread. Animating layout properties (`padding`, `margin`, `height`, `width`, `top`, `left`) triggers layout recalculation and repaint on every frame.

---

## Avoid Updating Inherited CSS Variables on Parents in Drag/Animation Loops

CSS custom properties inherit down the DOM tree. Updating a CSS variable on a parent container (such as `--swipe-amount` on a drawer with many child items) forces style recalculation across every descendant on every frame. Update `element.style.transform` directly on the moving element instead:

```js
// Bad — triggers style recalculation on all children every frame
drawerEl.style.setProperty("--swipe-amount", `${distance}px`);

// Good — updates only the target element's transform
drawerEl.style.transform = `translateY(${distance}px)`;
```

---

## Framer Motion Hardware Acceleration Under Load & WAAPI

### Framer Motion `transform` String vs. Shorthand Props

Framer Motion's shorthand props (`x`, `y`, `scale`) run via `requestAnimationFrame` on the main JavaScript thread and can drop frames when the browser is busy hydrating, loading route data, or painting. For animations that must stay smooth under main-thread load, pass a full `transform` string (or use CSS transitions / WAAPI), which runs off the main thread:

```tsx
// Main-thread rAF (convenient, but can drop frames during heavy page work)
<motion.div animate={{ x: 100 }} />

// Hardware-accelerated compositor animation (stays smooth under load)
<motion.div animate={{ transform: "translateX(100px)" }} />
```

### Web Animations API (WAAPI) for Programmatic CSS Performance

When you need imperative JavaScript control with off-main-thread CSS compositor performance and zero library overhead, use `element.animate()`:

```js
element.animate(
  [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }],
  {
    duration: 400,
    fill: "forwards",
    easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  },
);
```

---

## Use `will-change` Sparingly

`will-change` hints the browser to pre-promote an element to its own GPU compositing layer before an animation starts, eliminating first-frame layer-promotion micro-stutter (especially in Safari).

```css
/* Good — specific compositor-friendly properties when fixing observed stutter */
.animated-card {
  will-change: transform, opacity;
}

/* Bad — never use will-change: all or non-composited properties */
.animated-card {
  will-change: all;
}
```

### Useful Properties

| Property | GPU-compositable | Worth using `will-change` |
| --- | --- | --- |
| `transform` | Yes | Yes (when needed) |
| `opacity` | Yes | Yes (when needed) |
| `filter` (blur, brightness) | Yes | Yes (keep blur `<20px`) |
| `clip-path` | Newer Chromium only | Rarely; not reliable cross-browser |
| `top`, `left`, `width`, `height` | No | No |
| `background`, `border`, `color` | No | No |

Only add `will-change` when you observe first-frame stutter; do not apply it preemptively to every element because each promoted layer consumes GPU memory.
