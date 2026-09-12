import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, Text, fuzzyFilter, getKeybindings, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";

type PickerModel = Model<Api>;
const identity = (model: PickerModel) => `${model.provider}/${model.id}`;
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** Native Pi input and scrolling-list components, using only public extension APIs. */
export class FusionModelPicker implements Component, Focusable {
  private input = new Input();
  private list!: SelectList;
  private filtered: PickerModel[] = [];
  private selectedIndex = 0;
  private visibleRows = 8;
  private scoped: boolean;
  private scopedModels: PickerModel[];

  constructor(
    private title: string,
    private models: PickerModel[],
    scopedIds: ReadonlySet<string>,
    private previous: string | undefined,
    private theme: Theme,
    private terminalRows: () => number,
    private done: (model: PickerModel | undefined) => void,
  ) {
    this.models = [...models].sort((a, b) => {
      const current = Number(identity(b) === previous) - Number(identity(a) === previous);
      return current || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
    });
    this.scopedModels = this.models.filter(model => scopedIds.has(identity(model)));
    this.scoped = this.scopedModels.length > 0;
    this.filter();
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  private filter(): void {
    const models = this.scoped ? this.scopedModels : this.models;
    this.filtered = fuzzyFilter(models, this.input.getValue(), model => `${model.id} ${model.name} ${model.provider}`);
    this.selectedIndex = 0;
    this.rebuildList();
  }

  private rebuildList(): void {
    this.list = new SelectList(this.filtered.map(model => ({
      value: identity(model),
      label: clean(model.id),
      description: `${clean(model.provider)}${identity(model) === this.previous ? " (current)" : ""}`,
    })), this.visibleRows, {
      selectedPrefix: text => this.theme.fg("accent", text),
      selectedText: text => this.theme.fg("accent", text),
      description: text => this.theme.fg("muted", text),
      scrollInfo: text => this.theme.fg("dim", text),
      noMatch: text => this.theme.fg("warning", text),
    });
    this.list.setSelectedIndex(this.selectedIndex);
    this.list.onSelectionChange = item => {
      this.selectedIndex = this.filtered.findIndex(model => identity(model) === item.value);
    };
    this.list.onSelect = item => this.done(this.filtered.find(model => identity(model) === item.value));
    this.list.onCancel = () => this.done(undefined);
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.input.tab") && this.scopedModels.length) {
      this.scoped = !this.scoped;
      this.filter();
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      const delta = matchesKey(data, "pageUp") ? -this.visibleRows : this.visibleRows;
      this.selectedIndex = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIndex + delta));
      this.list.setSelectedIndex(this.selectedIndex);
    } else if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some(action => keys.matches(data, action))) {
      this.list.handleInput(data);
    } else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== before) this.filter();
    }
  }

  render(width: number): string[] {
    const rows = Math.max(1, Math.min(8, this.terminalRows() - 9));
    if (rows !== this.visibleRows) { this.visibleRows = rows; this.rebuildList(); }
    const text = (value: string) => new Text(value, 0, 0).render(width);
    const scope = this.scoped ? "your model scope" : "all configured providers";
    return [
      ...text(this.theme.fg("accent", clean(this.title))),
      ...text(this.theme.fg("dim", `${this.filtered.length} models | ${scope}${this.scopedModels.length ? " | Tab: switch scope" : ""}`)),
      ...this.input.render(width),
      ...(this.filtered.length ? this.list.render(width) : text(this.theme.fg("warning", "No matching models. Clear search or Tab to change scope."))),
      ...text(this.theme.fg("dim", "Type to search | Up/Down, PgUp/PgDn | Enter: select | Esc: cancel")),
    ];
  }

  invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
}

export async function pickFusionModel(ctx: ExtensionContext, role: string, previous?: { provider: string; modelId: string }): Promise<PickerModel | undefined> {
  await ctx.modelRegistry.refresh();
  const models = ctx.modelRegistry.getAvailable();
  if (!models.length) {
    ctx.ui.notify("No models available from configured providers. Use /login or check your provider configuration.", "warning");
    return undefined;
  }
  const previousId = previous ? `${previous.provider}/${previous.modelId}` : undefined;
  if (ctx.mode !== "tui") {
    const value = await ctx.ui.input(`${role} model (provider/model ID)`, previousId);
    if (!value) return undefined;
    const selected = models.find(model => identity(model) === value.trim());
    if (!selected) ctx.ui.notify("Choose a model from a configured provider using its exact provider/model ID.", "warning");
    return selected;
  }
  const scopedIds = new Set(ctx.scopedModels.map(({ model }) => identity(model)));
  return ctx.ui.custom<PickerModel | undefined>((tui, theme, _keys, done) => new FusionModelPicker(
    `${role} model`, models, scopedIds, previousId, theme, () => tui.terminal.rows, done,
  ));
}
