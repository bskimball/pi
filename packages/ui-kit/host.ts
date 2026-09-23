import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  WidthText,
  activeSkinName,
  buildObservatory,
  composerPromptGlyph,
  createObservatoryOrb,
  expandFeatured,
  fallbackTruncateToWidth,
  installSharedPresentation,
  installSharedTools,
  inventoryAt,
  uiChromeEnabled,
  inventorySelectorOptions,
  inventorySelectorTitle,
  isConversationBlank,
  listInventory,
  renderObservatory,
  reportRenderFailure,
  resolveSelectorChoice,
  selectorOptions,
  selectorTitle,
  specialistLaunchDraft,
  stripAnsi,
  type FeaturedEntry,
  type Observatory,
  type ObservatoryOrbResult,
  type SkinName,
  type BuildFooter,
} from "./index.ts";
import { createFooterRuntime } from "./internal/presentation/footer.ts";
import { runFeaturedExtensionCommand } from "./internal/runtime/featured-commands.ts";
import { releaseStaleUiKitClaimant, uiKitShared } from "./once.ts";

export interface UiHostOptions {
  skin: SkinName;
  thinkingLabel: string;
  buildWorkingIndicator: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ) => { frames: string[]; intervalMs: number; message: string };
  /** This UI's footer look; without one, Pi's stock footer stays. */
  buildFooter?: BuildFooter;
}

const presentationEnabled = () => uiChromeEnabled();

function hostsMap(): Map<SkinName, UiHostOptions> {
  return uiKitShared().hosts as Map<SkinName, UiHostOptions>;
}

function activeHost(): UiHostOptions | undefined {
  if (!presentationEnabled()) return undefined;
  return hostsMap().get(activeSkinName());
}

export function installUiHost(pi: ExtensionAPI, options: UiHostOptions): void {
  releaseStaleUiKitClaimant();
  const shared = uiKitShared();
  hostsMap().set(options.skin, options);
  installSharedTools(pi);
  if (activeHost()?.skin === options.skin) installSharedPresentation(pi);

  // Working indicator refreshes on every host (not just the first owner)
  // so the active skin's frames are (re)applied on each run even if the
  // first owner's listener is stale. Every host resolves the same
  // activeHost dynamically, so concurrent writes agree on one skin.
  pi.on("agent_start", (_event, ctx) => {
    const host = activeHost();
    if (!host || !ctx.hasUI) return;
    try {
      const built = host.buildWorkingIndicator(ctx, pi);
      ctx.ui.setWorkingVisible(true);
      ctx.ui.setWorkingMessage(built.message);
      ctx.ui.setWorkingIndicator({ frames: built.frames, intervalMs: built.intervalMs });
    } catch (error) {
      // A skin/theme key mismatch must never take the working chrome down:
      // keep whatever indicator settings are already in place.
      reportRenderFailure("working-indicator", error);
    }
  });

  if (shared.hostListeners) return;
  shared.hostListeners = true;

  let observatory: Observatory | undefined;
  let observatoryCtx: ExtensionContext | undefined;
  const footer = createFooterRuntime(pi, () => activeHost()?.buildFooter);

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
      // teardown must not throw
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
    try {
      ctx.ui.setHeader((_tui, theme) =>
        new WidthText(
          (width) => renderObservatory(view, (key, text) => theme.fg(key, text), width),
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

  async function launchFeatured(entry: FeaturedEntry, ctx: ExtensionContext): Promise<void> {
    if (entry.source === "extension") {
      try {
        await runFeaturedExtensionCommand(pi, entry.name, "", ctx);
      } catch (error) {
        ctx.ui.notify(
          `Could not run /${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      clearObservatory();
      return;
    }
    if (entry.source === "agent") {
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
      ctx.ui.notify(`Specialist ${entry.name} ready — fill the brief and send.`, "info");
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
    clearObservatory();
    pi.sendUserMessage(expanded);
  }

  async function openObservatoryOrb(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Observatory requires the interactive TUI.", "info");
      return;
    }
    let view: Observatory;
    try {
      view = buildObservatory(pi.getCommands(), ctx.cwd, contextFill(ctx));
    } catch (error) {
      reportRenderFailure("observatory", error);
      return;
    }
    if (view.pathways.length === 0 && view.specialists.length === 0 && view.skillCount === 0) {
      ctx.ui.notify("No prompts, skills, or specialists are available.", "info");
      return;
    }
    let result;
    try {
      result = await ctx.ui.custom<ObservatoryOrbResult>(
        (_tui, theme, _keybindings, done) => createObservatoryOrb(view, theme, done),
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
  }

  pi.registerShortcut("alt+o", {
    description: "Open the Observatory portal",
    handler: (ctx) => {
      if (!activeHost()) return;
      return openObservatoryOrb(ctx);
    },
  });

  pi.registerCommand("observatory", {
    description: "Open the Observatory portal and launch a pathway or instrument",
    handler: async (_args, ctx) => {
      if (!activeHost()) return;
      if (!ctx.hasUI) {
        ctx.ui.notify("Observatory requires the interactive TUI.", "info");
        return;
      }
      if (!observatory) showObservatory(pi, ctx);
      const view = observatory ?? buildObservatory(pi.getCommands(), ctx.cwd, contextFill(ctx));
      if (!observatory) observatory = view;
      const options = selectorOptions(view);
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
        resolved.action === "all-prompts" ? "prompt" : resolved.action === "all-skills" ? "skill" : "agent";
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
      const invChoice = await ctx.ui.select(inventorySelectorTitle(source, inventory.length), invOptions);
      const entry = inventoryAt(inventory, invChoice, invOptions);
      if (!entry) return;
      await launchFeatured(entry, ctx);
    },
  });

  pi.on("input", () => {
    if (activeHost()) clearObservatory();
  });
  pi.on("session_shutdown", () => {
    if (activeHost()) clearObservatory();
  });

  pi.on("session_start", (event, ctx) => {
    if (!activeHost()) return;
    clearObservatory();
    installLayout(pi, ctx);
    if (!ctx.hasUI || !presentationEnabled()) return;
    let blank: boolean;
    try {
      blank = isConversationBlank(ctx.sessionManager.getEntries());
    } catch {
      return;
    }
    if ((event.reason === "new" || event.reason === "startup") && blank) showObservatory(pi, ctx);
  });

  pi.events.on("pi:ui:changed", (payload: unknown) => {
    const { ctx } = payload as { ctx: ExtensionContext };
    if (activeHost()) {
      clearObservatory();
      installSharedPresentation(pi);
      installLayout(pi, ctx);
      if (ctx.hasUI && isConversationBlank(ctx.sessionManager.getEntries())) {
        showObservatory(pi, ctx);
      }
      return;
    }
    if (!presentationEnabled() && ctx.hasUI && !shared.chromeClear) {
      shared.chromeClear = true;
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setWorkingIndicator(undefined);
      ctx.ui.setWorkingMessage(undefined);
      ctx.ui.setHiddenThinkingLabel(undefined);
      footer.clear(ctx);
      clearObservatory();
      queueMicrotask(() => {
        shared.chromeClear = false;
      });
    }
  });

  function installLayout(piApi: ExtensionAPI, ctx: ExtensionContext) {
    const host = activeHost();
    if (!ctx.hasUI || !host) return;
    // The thinking label lands before the indicator build, and the custom
    // editor installs after it unconditionally: a throwing indicator build
    // (e.g. skin/theme key mismatch) must never skip the editor, otherwise
    // Pi keeps its default editor, whose spinner embeds in the top border
    // instead of the standalone row above the composer.
    ctx.ui.setHiddenThinkingLabel(host.thinkingLabel);

    function composerPrompt(): string {
      if (activeSkinName() === "hal") {
        // HAL cursor pulse: Pi owns render scheduling (no timers), so the
        // phase is evaluated per render and advances on keystrokes and
        // streaming frames. Bright/dim keeps either frozen frame looking
        // intentional when idle.
        const bright = Math.floor(Date.now() / 530) % 2 === 0;
        return ctx.ui.theme.fg(bright ? "accent" : "dim", "\u258c");
      }
      return ctx.ui.theme.fg("accent", composerPromptGlyph());
    }

    class SkinEditor extends CustomEditor {
      constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
        // Pin embedding off: newer Pi defaults CustomEditor to embedding the
        // working spinner inside the top border, but our chrome keeps the
        // indicator on its own line above the composer.
        super(tui, theme, keybindings, { paddingX: 2, embedWorkingStatus: false });
      }
      render(width: number): string[] {
        try {
          this.borderColor = (str: string) => ctx.ui.theme.fg("borderMuted", str);
          const lines = super.render(width);
          if (!lines.length) return lines;
          lines[0] = ctx.ui.theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
          if (lines.length > 1) {
            const inputLine = stripAnsi(lines[1]);
            if (inputLine.startsWith("  ")) {
              lines[1] = `${composerPrompt()} ${lines[1].slice(2)}`;
            }
          }
          return lines;
        } catch (error) {
          reportRenderFailure("editor", error);
          return [fallbackTruncateToWidth("─".repeat(Math.max(0, width)), width)];
        }
      }
    }

    try {
      const built = host.buildWorkingIndicator(ctx, piApi);
      ctx.ui.setWorkingVisible(true);
      ctx.ui.setWorkingMessage(built.message);
      ctx.ui.setWorkingIndicator({ frames: built.frames, intervalMs: built.intervalMs });
    } catch (error) {
      reportRenderFailure("working-indicator", error);
    }
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new SkinEditor(tui, theme, keybindings));
    footer.install(ctx);
  }
}
