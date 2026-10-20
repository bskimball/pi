import { registerHeadlessReceiptPrefix } from "./headless-receipts.ts";
import { boundedOutput, toolRenderers } from "./tool-receipt.ts";
import { cleanInline } from "./ui-common.ts";

type Args = Record<string, unknown>;

function compactArgs(args: Args, budget: number): string {
  const parts: string[] = [];
  const target = args.target && typeof args.target === "object" ? args.target as Args : args;
  for (const key of ["name", "path", "url", "element_token", "pid", "window_id", "scope"]) {
    const value = args[key] ?? target[key];
    if (typeof value === "string" || typeof value === "number") parts.push(`${key}=${cleanInline(value, 100)}`);
  }
  if (typeof args.x === "number" && typeof args.y === "number") parts.push(`at (${args.x}, ${args.y})`);
  if (typeof args.from_x === "number" && typeof args.to_x === "number") {
    parts.push(`(${args.from_x}, ${args.from_y}) -> (${args.to_x}, ${args.to_y})`);
  }
  for (const key of ["key", "direction", "button", "action", "delivery_mode", "query"]) {
    if (typeof args[key] === "string") parts.push(`${key}=${cleanInline(args[key], 100)}`);
  }
  if (Array.isArray(args.keys)) parts.push(args.keys.map((key) => cleanInline(key, 20)).slice(0, 8).join("+"));
  // Text entry can contain credentials; show its size rather than echoing it.
  for (const key of ["text", "value"]) {
    if (typeof args[key] === "string") parts.push(`${key}=${args[key].length} chars`);
  }
  return cleanInline(parts.join(" · "), budget);
}

export function computerUseRenderers(toolName: string) {
  return toolRenderers<Args>({
    surface: "computer-use",
    title: () => `computer / ${toolName.slice("computer_use_".length).replaceAll("_", " ")}`,
    arg: compactArgs,
    stats(result) {
      const parts: string[] = [];
      const images = result.content?.filter((block: any) => block.type === "image").length ?? 0;
      if (images) parts.push(`${images} image${images === 1 ? "" : "s"}`);
      if (result.details?.truncated) parts.push("truncated");
      return parts.join(" · ");
    },
    preview(output, result) {
      const details = result.details;
      const lines: string[] = [];
      for (const key of ["app_name", "window_title", "status", "outcome"]) {
        if (typeof details?.[key] === "string") lines.push(`${key.replaceAll("_", " ")}: ${cleanInline(details[key], 160)}`);
      }
      // Keep the actual response visible: dispatch is not proof of success.
      return [...lines.slice(0, 2), ...(output ? boundedOutput(output, 2, 900) : [])];
    },
    body: (output) => output ? boundedOutput(output, 72) : [],
  });
}

export function installComputerUseReceipts(): void {
  registerHeadlessReceiptPrefix("computer_use_", computerUseRenderers);
}
