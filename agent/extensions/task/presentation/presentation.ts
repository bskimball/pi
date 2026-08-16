// presentation: gate for standalone Task tool chrome.
//
// When disabled, tools omit renderCall/renderResult/renderShell so Pi's default
// boxed renderer shows the model-facing text content. Domain logic, details
// payloads, and tool registration stay loaded either way.
//
// Set PI_TASK_UI=0 to disable Task cards independently. PI_APEX_UI=0 remains
// the installation-wide emergency opt-out for all custom presentation.

/** True when Task's standalone activity cards should attach to task tools. */
export function taskPresentationEnabled(): boolean {
  return process.env.PI_APEX_UI !== "0" && process.env.PI_TASK_UI !== "0";
}

/** Renderer slots that belong to the optional Task presentation adapter. */
type PresentationSlots = {
  renderShell?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
};

/**
 * Spread onto a tool definition to attach Task chrome only when presentation
 * is enabled. When off, only renderer slots are removed; execution and every
 * other tool property are preserved. This is intentionally safe even when a
 * caller groups `execute` beside the renderer slots.
 */
export function withTaskPresentation<T extends Record<string, unknown>>(
  definition: T,
): T {
  if (taskPresentationEnabled()) return definition;
  const {
    renderShell: _renderShell,
    renderCall: _renderCall,
    renderResult: _renderResult,
    ...core
  } = definition as T & PresentationSlots;
  return core as T;
}
