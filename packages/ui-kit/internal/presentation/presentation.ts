// presentation: gate for Apex custom tool/task chrome.
//
// When disabled, tools omit renderCall/renderResult/renderShell so Pi's default
// boxed renderer shows the model-facing text content. Domain logic, details
// payloads, and tool registration stay loaded either way.
//
// Installation-wide chrome opt-out: PI_UI_CHROME=0. PI_APEX_UI=0 remains the
// deprecated alias. When both are set, PI_UI_CHROME wins.

export const UI_CHROME_ENV_VAR = "PI_UI_CHROME";
export const UI_CHROME_LEGACY_ENV_VAR = "PI_APEX_UI";

/** True when custom receipts/cards should attach to tools and notices. */
export function uiChromeEnabled(): boolean {
  const chrome = process.env[UI_CHROME_ENV_VAR];
  if (chrome !== undefined) return chrome !== "0";
  return process.env[UI_CHROME_LEGACY_ENV_VAR] !== "0";
}

/** @deprecated Use uiChromeEnabled. Kept so existing call sites keep working. */
export function apexPresentationEnabled(): boolean {
  return uiChromeEnabled();
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
