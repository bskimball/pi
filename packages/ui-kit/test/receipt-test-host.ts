import { ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { resolveHeadlessToolRenderers, type HeadlessComponent } from "../internal/presentation/headless-receipts.ts";

/** Mirror Pi's public resolver -> component constructor contract, without patching Pi. */
export function resolveReceiptFor(component: HeadlessComponent): ToolRenderers | undefined {
  return resolveHeadlessToolRenderers(component.toolName ?? "", () =>
    (component.toolDefinition ?? component.builtInToolDefinition) as ToolRenderers | undefined,
  );
}

export class ReceiptToolExecutionComponent extends ToolExecutionComponent {
  constructor(...args: ConstructorParameters<typeof ToolExecutionComponent>) {
    const owned = args[4];
    args[4] = resolveHeadlessToolRenderers(args[0], () => owned);
    super(...args);
  }
}
