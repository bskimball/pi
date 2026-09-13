// presentation: gate for Apex custom tool/task chrome.
//
// When disabled, tools omit renderCall/renderResult/renderShell so Pi's default
// boxed renderer shows the model-facing text content. Domain logic, details
// payloads, and tool registration stay loaded either way.
//
// Same emergency opt-out as apex-ui: PI_APEX_UI=0.

/** True when Apex custom receipts/cards should attach to tools and notices. */
export function apexPresentationEnabled(): boolean {
  return process.env.PI_APEX_UI !== "0";
}

/** Renderer slots that belong to the optional Apex presentation adapter. */
type PresentationSlots = {
  renderShell?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
};

/**
 * Spread onto a tool definition to attach Apex chrome only when presentation
 * is enabled. When off, only renderer slots are removed; execution and every
 * other tool property are preserved. This is intentionally safe even when a
 * caller groups `execute` beside the renderer slots.
 */
export function withApexPresentation<T extends Record<string, unknown>>(
  definition: T,
): T {
  if (apexPresentationEnabled()) return definition;
  const {
    renderShell: _renderShell,
    renderCall: _renderCall,
    renderResult: _renderResult,
    ...core
  } = definition as T & PresentationSlots;
  return core as T;
}
