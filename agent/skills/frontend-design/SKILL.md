---
name: frontend-design
description: Production-grade frontend and visual design in code. Use when building, extending, or redesigning web UI, workflows, dashboards, landing pages, design systems, components, layouts, interaction polish, diagrams, slides, or data visualization. Triggers on frontend design, visual design, redesign, UI restyle, landing page, dashboard, design system, aesthetic direction, visitor mode, "make it look good", avoid AI slop, memorable interface. Load this skill for substantial visual or design work even when a specialist is not available.
---

# Frontend Design

Design for the product's goal and the user's activity. Respect the existing product, framework, design system, performance constraints, and accessibility requirements. A surface succeeds when its structure, interaction, and visual language serve what the user is trying to do and what the product needs to accomplish.

## 1. Frame the task

Before choosing layout or styling, establish four things from the codebase, `PRODUCT.md` / `DESIGN.md` when present, and the brief:

- **Product and user goal** — who is using this surface, what they are trying to accomplish, and what outcome the app or site needs from it.
- **Design-system context** — whether this work applies an existing system, extends one, or establishes a new one.
- **Surface mode** — the primary job of the surface (**Operate**, **Read / understand**, **Persuade / decide**, or **Experience / explore**), plus any secondary mode inside it.
- **Material constraints** — audience, tone, density, devices, accessibility, performance, and any reference or anti-reference.

Work-order block when delegating or capturing context:

```text
goal / user task; audience / tone; system — Apply, Extend, or Establish;
mode — Operate, Read / understand, Persuade / decide, or Experience / explore;
reference or anti-reference (when relevant); scope / constraints.
```

If an open taste or product decision would materially change the design and cannot be inferred from the repo or brief, stop and ask for that exact decision rather than inventing requirements.

## 2. Design-system context

Determine what is allowed to change before inventing patterns:

### Apply an existing system

- Reuse established tokens, typography, spacing, components, and interaction conventions.
- Solve the problem through composition and hierarchy before introducing new visual treatments.
- Do not invent a signature flourish just to make the slice look custom.

### Extend an existing system

- Identify the specific user or content need that current components do not cover.
- Derive new components, states, or tokens from the system's existing visual and interaction language so the addition looks native to the product.
- Keep the extension local unless multiple surfaces in scope genuinely share the contract.

### Establish a distinct new system

- Derive the system from the product's domain, audience, operating conditions, and content — not from generic templates.
- Define coherent foundations for type scale, spacing rhythm, color roles, surface hierarchy, controls, and motion.
- Build only the tokens and primitives the requested scope needs. Distinctiveness should come from those foundations working together, not from decorative extras attached to every element.

## 3. Surface modes

Identify the primary mode for the requested surface. A product often combines modes across screens or regions; keep one product language while letting each surface prioritize its job.

### Operate — workflows, dashboards, tools, settings, editors

Primary question: **Can the user complete the task accurately, quickly, and with confidence?**

- Prioritize action hierarchy, current state visibility, scannable grouping, keyboard/pointer efficiency, and appropriate information density.
- Keep high-frequency controls calm and predictable; make destructive, dirty, loading, empty, and error states unmistakable.
- Earn every container: use spacing, alignment, table structure, or subtle dividers before wrapping items in cards or callout boxes.

### Read / understand — docs, reports, feeds, analytics, reference views

Primary question: **Can the user locate, comprehend, and compare the information without friction?**

- Prioritize typographic hierarchy, measure, reading sequence, progressive disclosure, and clear comparison across items or time.
- Let headings, whitespace, alignment, and data layout carry structure; reserve callouts, badges, and accent rails for exceptions that change how the reader acts or interprets a section.
- Keep chrome quiet so content and evidence lead.

### Persuade / decide — landing pages, marketing, pricing, onboarding, upgrade flows

Primary question: **Can the visitor understand the value, trust the claim, and take the next step?**

- Prioritize proposition clarity, narrative pacing, concrete product proof, objection handling, and an unambiguous primary action path.
- Use atmosphere, contrast, imagery, or motion where they sharpen the product story or focal point, not as filler between sections.
- Vary section structure to match the argument instead of repeating the same card grid down the page.

### Experience / explore — brand moments, interactive storytelling, creative tools, showcases

Primary question: **Does the pacing, atmosphere, and interaction create the intended feeling while keeping the user oriented?**

- Commit to a clear point of view in typography, color, spatial composition, and motion choreography.
- Give expressive moments room to breathe against quieter supporting chrome, and preserve orientation, responsiveness, and reduced-motion ergonomics.

## 4. Structure before treatment

Before styling containers or adding ornament, make the structural decisions in this order:

1. **First impression and focal point** — what the user must notice first, second, and third.
2. **Task or reading flow** — the sequence of inspection, inputs, decisions, and actions.
3. **Grouping and separation** — prefer proximity, alignment, typographic contrast, and simple dividers first. Introduce a bounded container, card, tinted surface, or accent border only when it communicates a real boundary: an independent interactive unit, a distinct elevation layer, a live status/selection state, or a semantic callout.
4. **State semantics** — decide how selection, focus, status, validation, active region, and hierarchy are distinguished so one visual cue is not overused for everything.

When a meaningful design choice is genuinely open — such as establishing a new system, redesigning a surface, or choosing between distinct layouts/flows — briefly sketch two viable directions (how each structures the task, its trade-off, and why), pick one, and implement only the chosen direction. When applying an established system to a clear pattern, state the existing pattern you are following and proceed directly.

## 5. Examine defaults rather than running on reflex

None of the patterns below are banned when the product system or a specific UI state genuinely calls for them. Avoid them as automatic filler:

- Wrapping every group, list row, or section in a rounded card or left-border callout when spacing, typography, a table, or a divider would be clearer.
- Using the same visual cue (such as an accent rail, badge, or pill) for headings, grouping, status, and decoration on the same screen.
- Glassmorphism, blur, and glow borders spread across every surface instead of reserved for true overlays or an established product motif.
- Default AI palettes (cyan-on-dark, purple gradients), gradient headings/metrics with no semantic meaning, or pure `#000`/`#fff` neutrals where tinted neutrals belong.
- Repeating identical card grids (`icon + heading + paragraph`), nesting cards inside cards, or placing a large rounded icon above every heading.
- Hero metric tiles (`huge number + tiny label + gradient accent`) where trend, context, or comparison is what the user actually needs.
- Center-aligning everything or using uniform spacing everywhere instead of deliberate rhythm and alignment.
- Modals as the reflex for flows that belong inline, in a drawer, or on their own route.
- Styling every action as primary, headings that merely repeat the sentence below, or empty states that say "nothing here" without the next action.
- Gray text on colored backgrounds instead of a shade of that hue, or bounce/elastic easing where crisp exponential easing (`ease-out`) belongs.

## 6. Implement and polish

Implement the smallest coherent change that delivers the chosen design at the requested scope, including the hover, focus, active, loading, empty, and error states the flow actually uses. Account for responsive layout, semantic HTML, keyboard navigation, contrast, reduced motion, and screen-reader labels.

If validation fails, fix the concrete defect rather than restarting design exploration unless the failure disproves the design.

Finish with a `make-interfaces-feel-better` polish pass where it applies to the elements you actually built (concentric radii on genuinely nested rounded surfaces, optical alignment, shadows vs. structural borders, tabular numbers, restrained motion, exact transition properties, minimum hit areas). Load `~/.agents/skills/make-interfaces-feel-better/SKILL.md` (or the project `.agents/skills` copy if present) to refine chosen surfaces — never add extra containers, animations, or borders just to exercise a polish rule.

## 7. Report

Keep the report concise:

- **Context and direction** — design-system mode (`Apply`, `Extend`, or `Establish`), primary surface mode, and the chosen structural/visual approach in 1–2 sentences (plus the two-direction choice when one was required).
- **Files or artifacts** — paths changed or created.
- **Key design decisions** — hierarchy, grouping/containment choices, tokens or components reused/added, and interaction states covered.
- **Accessibility, responsiveness, and polish** — what was verified and which `make-interfaces-feel-better` checks applied.
