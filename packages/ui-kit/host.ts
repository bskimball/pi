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
} from "./index.ts";
import { runFeaturedExtensionCommand } from "./internal/runtime/featured-commands.ts";

export interface UiHostOptions {
  skin: SkinName;
  thinkingLabel: string;
  buildWorkingIndicator: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ) => { frames: string[]; intervalMs: number; message: string };
}

const presentationEnabled = () => process.env.PI_APEX_UI !== "0";

const hosts = new Map<SkinName, UiHostOptions>();
const g = globalThis as typeof globalThis & {
  __piUiKitChromeClear?: boolean;
  __piUiKitHostListeners?: boolean;
};

function activeHost(): UiHostOptions | undefined {
  if (!presentationEnabled()) return undefined;
  return hosts.get(activeSkinName());
}

export function installUiHost(pi: ExtensionAPI, options: UiHostOptions): void {
  hosts.set(options.skin, options);
  installSharedTools(pi);
  if (activeHost()?.skin === options.skin) installSharedPresentation(pi);
  if (g.__piUiKitHostListeners) return;
  g.__piUiKitHostListeners = true;

  pi.on("agent_start", (_event, ctx) => {
    const host = activeHost();
    if (!host || !ctx.hasUI) return;
    const built = host.buildWorkingIndicator(ctx, pi);
    ctx.ui.setWorkingVisible(true);
    ctx.ui.setWorkingMessage(built.message);
    ctx.ui.setWorkingIndicator({ frames: built.frames, intervalMs: built.intervalMs });
  });

  let observatory: Observatory | undefined;
  let observatoryCtx: ExtensionContext | undefined;

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
    if (!presentationEnabled() && ctx.hasUI && !g.__piUiKitChromeClear) {
      g.__piUiKitChromeClear = true;
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setWorkingIndicator(undefined);
      ctx.ui.setWorkingMessage(undefined);
      ctx.ui.setHiddenThinkingLabel(undefined);
      clearObservatory();
      queueMicrotask(() => {
        g.__piUiKitChromeClear = false;
      });
    }
  });

  function installLayout(piApi: ExtensionAPI, ctx: ExtensionContext) {
    const host = activeHost();
    if (!ctx.hasUI || !host) return;
    const built = host.buildWorkingIndicator(ctx, piApi);
    ctx.ui.setWorkingVisible(true);
    ctx.ui.setWorkingMessage(built.message);
    ctx.ui.setWorkingIndicator({ frames: built.frames, intervalMs: built.intervalMs });
    ctx.ui.setHiddenThinkingLabel(host.thinkingLabel);

    class SkinEditor extends CustomEditor {
      constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
        super(tui, theme, keybindings, { paddingX: 2 });
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
              lines[1] = `${ctx.ui.theme.fg("accent", composerPromptGlyph())} ${lines[1].slice(2)}`;
            }
          }
          return lines;
        } catch (error) {
          reportRenderFailure("editor", error);
          return [fallbackTruncateToWidth("─".repeat(Math.max(0, width)), width)];
        }
      }
    }

    ctx.ui.setEditorComponent((tui, theme, keybindings) => new SkinEditor(tui, theme, keybindings));
  }
}
