// apex-ui: compact built-in tool chrome and monochrome interactive layout.

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  fallbackTruncateToWidth,
} from "./internal/presentation/safe-text-layout.ts";
import {
  reportRenderFailure,
} from "./internal/presentation/tool-receipt.ts";
import { installBgProcessReceipts } from "./internal/presentation/bg-process-receipt.ts";
import { installGraphifyReceipts } from "./internal/presentation/graphify-receipt.ts";
import { installLspReceipts } from "./internal/presentation/lsp-receipt.ts";
import { installRenderSafety } from "./internal/presentation/render-safety.ts";
import { installWebSearchReceipts } from "./internal/presentation/web-search-receipt.ts";
import { installApexOwnedTools, installBuiltinTools } from "./builtin-tools.ts";
import {
  WidthText,
  stripAnsi,
} from "./internal/presentation/ui-common.ts";
import {
  buildObservatory,
  expandFeatured,
  inventoryAt,
  inventorySelectorOptions,
  inventorySelectorTitle,
  isConversationBlank,
  listInventory,
  renderObservatory,
  resolveSelectorChoice,
  selectorOptions,
  selectorTitle,
  specialistLaunchDraft,
  type FeaturedEntry,
  type Observatory,
} from "./observatory/observatory.ts";
import {
  createObservatoryOrb,
  type ObservatoryOrbResult,
} from "./observatory/observatory-orb.ts";
import { runFeaturedExtensionCommand } from "./internal/runtime/featured-commands.ts";

const RANDOM_INDICATOR_FRAME_COUNT = 256;
const RANDOM_INDICATOR_INTERVAL_MS = 120;

// One message is picked at random per run. The indicator is event-driven only:
// no extension-owned timer rewrites it mid-run.
const WORKING_MESSAGES = [
  "Thinking through it",
  "Tracing the next move",
  "Exploring the code",
  "Working the problem",
  "Following the signal",
  "Chasing the details",
  "Piecing it together",
];

function workingMessage(): string {
  return WORKING_MESSAGES[Math.floor(Math.random() * WORKING_MESSAGES.length)];
}

/** Thinking level drives the indicator hue, making the animation informative. */
const THINKING_TONES: Record<string, string> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

const WORKING_PATTERNS = [
  // Pulse from the center, then settle back on the beat.
  ["000010000", "010111010", "111111111", "010111010", "000010000"],
  // Horizontal and vertical sweeps.
  ["111000000", "000111000", "000000111", "000111000"],
  ["100100100", "010010010", "001001001", "010010010"],
  // Alternating checkerboard rhythm.
  ["101010101", "010101010", "101010101", "010101010"],
  // Expanding corners and contracting diagonals.
  ["100000001", "101010101", "111111111", "010101010"],
  ["001010100", "010101010", "100010001", "010101010"],
  // A dot walking around the perimeter.
  [
    "100000000",
    "010000000",
    "001000000",
    "000001000",
    "000000001",
    "000000010",
    "000000100",
    "000100000",
  ],
  // Two dots orbiting 180 degrees apart.
  [
    "100000001",
    "010000010",
    "001000100",
    "000101000",
    "001000100",
    "010000010",
  ],
  // Rain: columns falling on a stagger.
  [
    "100000000",
    "100100000",
    "010100100",
    "010010100",
    "001010010",
    "001001010",
    "000001001",
    "000000001",
  ],
  // Breathe: density ramps up from the center and releases.
  ["000010000", "010101010", "111111111", "010101010", "000010000"],
  // Scanline with a trailing dimmer column.
  ["100100100", "110110110", "011011011", "001001001", "000000000"],
] as const;

function shuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}

function renderWorkingDots(mask: string): string {
  let firstTwoColumns = 0;
  let thirdColumn = 0;
  for (let cell = 0; cell < 9; cell++) {
    if (mask[cell] !== "1") continue;
    const row = Math.floor(cell / 3);
    const column = cell % 3;
    if (column < 2) firstTwoColumns |= 1 << (row + column * 3);
    else thirdColumn |= 1 << row;
  }
  return `${String.fromCodePoint(0x2800 + firstTwoColumns)}${String.fromCodePoint(0x2800 + thirdColumn)}`;
}

function randomWorkingFrames(ctx: ExtensionContext, leadTone: string): string[] {
  const frames: string[] = [];
  while (frames.length < RANDOM_INDICATOR_FRAME_COUNT) {
    for (const sourcePattern of shuffle(WORKING_PATTERNS)) {
      // Randomly reverse each motif so repeated cycles keep their rhythm without
      // always moving in the same direction or appearing in the same order.
      const pattern =
        Math.random() < 0.5 ? [...sourcePattern].reverse() : sourcePattern;
      for (let beat = 0; beat < pattern.length; beat++) {
        // The leading beat carries the thinking-level hue; the rest decay so the
        // motion still reads as a trail.
        const tone = beat === 0 ? leadTone : beat % 2 === 0 ? "muted" : "dim";
        frames.push(ctx.ui.theme.fg(tone as any, renderWorkingDots(pattern[beat])));
        if (frames.length >= RANDOM_INDICATOR_FRAME_COUNT) return frames;
      }
    }
  }
  return frames;
}

function applyRandomWorkingIndicator(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (!ctx.hasUI) return;
  let leadTone = "accent";
  try {
    leadTone = THINKING_TONES[String(pi.getThinkingLevel())] ?? "accent";
  } catch {
    // Keep the default accent hue.
  }
  ctx.ui.setWorkingVisible(true);
  ctx.ui.setWorkingMessage(ctx.ui.theme.fg("dim", `${workingMessage()}...`));
  ctx.ui.setWorkingIndicator({
    frames: randomWorkingFrames(ctx, leadTone),
    intervalMs: RANDOM_INDICATOR_INTERVAL_MS,
  });
}

export default function (pi: ExtensionAPI) {
  // Tools Apex owns outright (`edit`, `todo_write`/`todo_read` and the todo
  // panel) register before the presentation opt-out: PI_APEX_UI=0 removes the
  // custom receipts and styled chrome, never the tools themselves. The todo
  // panel stays mounted there as an unstyled plain widget.
  installApexOwnedTools(pi);

  // PI_APEX_UI=0 disables Apex styling, chrome, and custom render hooks. Do not
  // install any Apex process-wide rendering hooks in diagnostic fallback mode;
  // the persistent plain todo widget installed above is the sole exception.
  if (process.env.PI_APEX_UI === "0") return;

  // Install the process-wide boundary only when Apex presentation is active.
  // It keeps malformed model/extension values from terminating the TUI while
  // preserving the full Apex UI.
  installRenderSafety();
  // Headless extensions own execute. Apex skins their ToolExecutionComponent
  // receipts here because first registration wins the whole tool and Apex
  // cannot import those extensions. Settlement notices use a message renderer.
  installGraphifyReceipts();
  installLspReceipts();
  installWebSearchReceipts();
  installBgProcessReceipts(pi);

  // Regenerate the sequence for every run so retries and subsequent turns do
  // not reuse the same pseudo-random loop. This is event-driven only; Pi owns
  // the animation clock.
  pi.on("agent_start", (_event, ctx) => applyRandomWorkingIndicator(pi, ctx));

  // MCP presentation is installed by agent/extensions/mcp-adapter.ts on the
  // adapter's own ExtensionAPI — not here (per-extension tool maps).

  installBuiltinTools(pi);

  // The observatory landing screen. It exists only for a conversation-blank
  // fresh chat and is owned entirely by this module through Pi's startup
  // header. No timers.
  let observatory: Observatory | undefined;
  let observatoryCtx: ExtensionContext | undefined;

  /** Context usage as 0..1, or undefined when Pi cannot report it yet. */
  function contextFill(ctx: ExtensionContext): number | undefined {
    try {
      const percent = ctx.getContextUsage()?.percent;
      return typeof percent === "number" ? percent / 100 : undefined;
    } catch {
      return undefined;
    }
  }

  function clearObservatory(): void {
    const ctx = observatoryCtx;
    observatory = undefined;
    observatoryCtx = undefined;
    if (!ctx) return;
    try {
      ctx.ui.setHeader(undefined);
    } catch {
      // A teardown failure must never propagate into Pi's event loop.
    }
  }

  function showObservatory(piApi: ExtensionAPI, ctx: ExtensionContext): void {
    let view: Observatory;
    try {
      view = buildObservatory(piApi.getCommands(), ctx.cwd, contextFill(ctx));
    } catch (error) {
      reportRenderFailure("observatory", error);
      return;
    }

    // The startup header is the real opening surface: with quiet startup there
    // is nothing above it, so it IS the splash screen. Unlike an above-editor
    // widget it has no line cap, hence OBSERVATORY_MAX_LINES = 25.
    try {
      ctx.ui.setHeader((_tui, theme) =>
        new WidthText(
          (width) =>
            renderObservatory(view, (key, text) => theme.fg(key, text), width),
          "[observatory unavailable]",
        ),
      );
      observatory = view;
      observatoryCtx = ctx;
    } catch (error) {
      reportRenderFailure("observatory", error);
      observatory = undefined;
      observatoryCtx = undefined;
      try {
        ctx.ui.setHeader(undefined);
      } catch {
        // ignore
      }
    }
  }

  async function launchFeatured(
    entry: FeaturedEntry,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (entry.source === "extension") {
      // Native pathway commands need executable pre-steps; invoke the shared
      // handlers rather than inlining a prompt template.
      try {
        await runFeaturedExtensionCommand(pi, entry.name, "", ctx);
      } catch (error) {
        ctx.ui.notify(
          `Could not run /${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      // Only a successful launch dismisses the screen.
      clearObservatory();
      return;
    }

    if (entry.source === "agent") {
      // Specialists need a user-authored brief. Prefill the composer; do not
      // auto-start a task with an empty mission.
      try {
        ctx.ui.setEditorText(specialistLaunchDraft(entry));
      } catch (error) {
        ctx.ui.notify(
          `Could not prepare /${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      clearObservatory();
      ctx.ui.notify(
        `Specialist ${entry.name} ready — fill the brief and send.`,
        "info",
      );
      return;
    }

    let expanded: string;
    try {
      expanded = await expandFeatured(entry);
    } catch (error) {
      ctx.ui.notify(
        `Could not read /${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    // Only a successful launch dismisses the screen.
    clearObservatory();
    pi.sendUserMessage(expanded);
  }

  /**
   * The interactive orb: the splash rendered as a focused overlay whose
   * selection is driven by the arrow keys. Any printable key hands the
   * character straight back to the composer, so opening the orb never costs
   * the user a keystroke.
   *
   * Deliberately never opened automatically at startup. The blank-session
   * splash stays the passive `setHeader` render and the composer keeps focus,
   * because passthrough only rescues a *single* printable keystroke: a
   * bracketed paste, an IME commit, or any app keybinding arriving before the
   * first character would be swallowed by the overlay. The hotkey and
   * `/observatory` are the entry points.
   */
  async function openObservatoryOrb(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Observatory requires the interactive TUI.", "info");
      return;
    }
    let view: Observatory;
    try {
      // Rebuilt per invocation so the orb always reflects current inventory.
      view = buildObservatory(pi.getCommands(), ctx.cwd, contextFill(ctx));
    } catch (error) {
      reportRenderFailure("observatory", error);
      return;
    }
    if (
      view.pathways.length === 0 &&
      view.specialists.length === 0 &&
      view.skillCount === 0
    ) {
      ctx.ui.notify("No prompts, skills, or specialists are available.", "info");
      return;
    }

    let result;
    try {
      result = await ctx.ui.custom<ObservatoryOrbResult>(
        (_tui, theme, _keybindings, done) =>
          createObservatoryOrb(view, theme, done),
        { overlay: true },
      );
    } catch (error) {
      reportRenderFailure("observatory-orb", error);
      return;
    }

    if (result.action === "launch") {
      await launchFeatured(result.entry, ctx);
      return;
    }
    if (result.action === "passthrough") {
      try {
        ctx.ui.pasteToEditor(result.text);
      } catch (error) {
        reportRenderFailure("observatory-orb", error);
      }
    }
    // Dismiss leaves the splash and the session exactly as they were.
  }

  pi.registerShortcut("alt+o", {
    description: "Open the Observatory portal",
    handler: (ctx) => openObservatoryOrb(ctx),
  });

  pi.registerCommand("observatory", {
    description:
      "Open the Observatory portal and launch a pathway or instrument",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Observatory requires the interactive TUI.", "info");
        return;
      }
      // Always present the visual portal when the command is invoked.
      if (!observatory) showObservatory(pi, ctx);
      const view =
        observatory ??
        buildObservatory(pi.getCommands(), ctx.cwd, contextFill(ctx));
      if (!observatory) observatory = view;

      const options = selectorOptions(view);
      // options always ends with Cancel; need at least one real choice.
      if (options.length <= 1) {
        ctx.ui.notify("No prompts, skills, or specialists are available.", "info");
        return;
      }

      const choice = await ctx.ui.select(selectorTitle(view), options);
      const resolved = resolveSelectorChoice(view, choice, options);

      if (resolved.action === "cancel") return;

      if (resolved.action === "featured") {
        await launchFeatured(resolved.entry, ctx);
        return;
      }

      const source =
        resolved.action === "all-prompts"
          ? "prompt"
          : resolved.action === "all-skills"
            ? "skill"
            : "agent";
      const inventory = listInventory(pi.getCommands(), source, ctx.cwd);
      if (!inventory.length) {
        ctx.ui.notify(
          source === "prompt"
            ? "No prompts are available."
            : source === "skill"
              ? "No skills are available."
              : "No specialists are available.",
          "info",
        );
        return;
      }
      const invOptions = inventorySelectorOptions(inventory);
      const invChoice = await ctx.ui.select(
        inventorySelectorTitle(source, inventory.length),
        invOptions,
      );
      const entry = inventoryAt(inventory, invChoice, invOptions);
      if (!entry) return;
      await launchFeatured(entry, ctx);
    },
  });

  pi.on("input", () => {
    clearObservatory();
  });
  pi.on("session_shutdown", () => {
    clearObservatory();
  });

  pi.on("session_start", (event, ctx) => {
    // Always drop a prior session's header/widget/model before any guard so
    // new/resume/reload/fork never inherits a stale observatory.
    clearObservatory();
    installLayout(pi, ctx);
    // Rebuild only for a conversation-blank new/initial startup chat.
    // Ignore model_change / thinking_level_change / session_info seeds that
    // the SDK appends before session_start on every fresh session.
    if (!ctx.hasUI) return;
    let blank: boolean;
    try {
      blank = isConversationBlank(ctx.sessionManager.getEntries());
    } catch {
      return;
    }
    if (event.reason === "new" || event.reason === "startup") {
      if (blank) showObservatory(pi, ctx);
      return;
    }
  });

  function installLayout(piApi: ExtensionAPI, ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    applyRandomWorkingIndicator(piApi, ctx);

    // Collapsed reasoning is otherwise a bare italic sentence that reads like
    // narration. The shared quiet glyph marks it as the assistant's private
    // channel without adding a row and matches Apex's restrained glyph set.
    // Pi paints and italicises this label itself.
    ctx.ui.setHiddenThinkingLabel("\u00b7 thinking");

    class ApexEditor extends CustomEditor {
      constructor(
        tui: TUI,
        theme: EditorTheme,
        keybindings: KeybindingsManager,
      ) {
        super(tui, theme, keybindings, { paddingX: 2 });
      }

      render(width: number): string[] {
        try {
          // Pi colors both input borders from the thinking level (and bash mode).
          // Apex keeps the chrome quiet: mute the border painter before
          // super.render so the bottom rule and scroll indicators stay muted
          // too, not just the top line. Model/thinking stay on Pi's stock footer.
          this.borderColor = (str: string) =>
            ctx.ui.theme.fg("borderMuted", str);

          const lines = super.render(width);
          if (!lines.length) return lines;

          // Keep every upstream editor row and cursor calculation intact. Only
          // repaint the existing top border and replace its two leading padding
          // cells with a prompt glyph; no rows or terminal columns are added.
          lines[0] = ctx.ui.theme.fg(
            "borderMuted",
            "─".repeat(Math.max(0, width)),
          );

          if (lines.length > 1) {
            const inputLine = stripAnsi(lines[1]);
            if (inputLine.startsWith("  ")) {
              lines[1] = `${ctx.ui.theme.fg("accent", "❯")} ${lines[1].slice(2)}`;
            }
          }
          // The editor itself uses Pi's authoritative width/cursor layout.
          // Do not post-process its rows; clipping here can remove the hidden
          // hardware-cursor marker that anchors IME placement.
          return lines;
        } catch (error) {
          reportRenderFailure("editor", error);
          return [
            fallbackTruncateToWidth("─".repeat(Math.max(0, width)), width),
          ];
        }
      }
    }

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new ApexEditor(tui, theme, keybindings),
    );

  }
}
