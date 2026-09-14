---
name: frontend-design
description: Distinctive, production-grade frontend and visual design in code. Use when building, restyling, or redesigning web UI, landing pages, dashboards, design systems, components, layouts, interaction polish, diagrams, slides, or data visualization. Triggers on frontend design, visual design, redesign, UI restyle, landing page, dashboard, design system, aesthetic direction, visitor mode, "make it look good", avoid AI slop, memorable interface. Load this skill for substantial visual or design work even when a specialist is not available.
---

# Frontend Design

Create production-grade, memorable interfaces in code. Respect the existing product, framework, design system, performance constraints, and accessibility requirements. Intentionality matters more than intensity, but restraint without a point of view is blandness — a deliberately quiet direction still needs a stated reason it is quiet.

## Aesthetic direction

Before implementation, commit to a coherent aesthetic direction based on purpose, audience, tone, constraints, and one memorable differentiator.

For existing products, preserve established tokens, fonts, components, and visual language unless the task explicitly calls for a redesign; product consistency outranks novelty. For greenfield work, choose typography, color, atmosphere, and animation on purpose rather than by generic-AI default: purposeful type (a workhorse face is fine only when you state why it fits this product, not merely that it is deliberate), a defined color direction over purple-on-white/dark-mode defaults, atmosphere via gradients/shapes/patterns rather than flat backgrounds, a few high-impact animations over scattered micro-motion, and varied visual language across outputs.

Taste intake (required when material): the brief should carry audience, tone, visitor mode, one reference or anti-reference, and either a differentiator or an explicit "deliberately plain" waiver. Visitor mode names what the surface is for:

- **Persuade** — landing/marketing: help someone decide
- **Operate** — dashboard/workflow: help someone get something done
- **Read** — docs/content: help someone scan and comprehend
- **Experience** — brand/moment: make someone feel something

If those are missing and the choice is taste-load-bearing, stop and report the exact missing taste decision rather than designing from nothing.

Diverge then commit: sketch two distinct directions in a few lines each (direction, trade-off, what default it rejects), pick one with a stated reason, then implement only the chosen direction. No second implementation, no extra files.

Taste block to copy into a work order: audience / tone; mode — Persuade, Operate, Read, or Experience; reference or anti-reference; differentiator or "deliberately plain" waiver; scope — preserve tokens vs. redesign.

## What to avoid

These are unexamined defaults, not prohibitions: the problem is the reflex, not the technique. In an established product, the design system's deliberate choices override this list.

- Glassmorphism as a default: blur, glass cards, and glow borders spread across every surface to stand in for hierarchy. Chosen deliberately for a specific surface and consistent with the product's visual language, glass is legitimate and we do use it.
- Cyan-on-dark with purple gradients, the default AI palette.
- Gradient text on headings and metrics where the gradient carries no meaning.
- Card grids of identical cards: icon, heading, body text, repeated until the page ends.
- Cards nested inside cards. Flatten the hierarchy instead.
- A large rounded-corner icon above every heading.
- Hero metric layouts: big number, small label, gradient accent.
- Uniform spacing everywhere. Rhythm comes from varying it.
- Center-aligning everything. Left alignment with deliberate asymmetry reads as designed.
- Modals as the reflex for every interaction; they are rarely the best answer.
- Pure black or pure white. Tint the neutrals.
- Gray text on a colored background. Use a shade of that background instead.
- Bounce and elastic easing. Exponential easing such as ease-out-quart or ease-out-expo has aged better.
- Every button styled as primary. Hierarchy matters in actions as much as in type.
- Headings that restate the sentence beneath them.
- Empty states that announce "nothing here" instead of telling the user what to do next.

The standard is intentionality and fit: every choice above should be one you would defend on the product's terms, not one that arrived by default.

## How to implement

Once the target behavior and existing visual language are clear, state the two candidate directions and the choice, then implement only the chosen direction.

Implement the most coherent visual solution at the requested scope — the smallest diff that carries the chosen direction — including the hover, focus, active, loading, empty, and error states the requested flow actually needs. Account for responsive behavior, semantic HTML, keyboard use, contrast, reduced motion, and screen-reader needs.

Spend effort on the two-direction sketch, the assigned visual decision, and implementation — not a survey of every possible design direction. If validation fails, diagnose the concrete failure and fix it. Do not restart design exploration unless the failure disproves the chosen direction.

## Polish

Finish with a `make-interfaces-feel-better` polish pass where it applies (concentric radius, optical alignment, shadows over borders, staggered enters, tabular numbers, exact transitions). Load `~/.agents/skills/make-interfaces-feel-better/SKILL.md` (or the project `.agents/skills` copy if present) and state what was applied or why nothing applied.

Then self-critique against the generic defaults: name which "What to avoid" defaults you rejected and why the alternative fits this product.

Report:

- chosen direction in one sentence, including the differentiator and what default it rejects
- files changed or artifact paths
- important visual tokens and interaction decisions
- accessibility and responsive considerations
