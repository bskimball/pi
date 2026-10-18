import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shipping } from "./shipping.ts";
import { textResult } from "./tool-result.ts";

export function registerShipping(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "shipping", label: "Shipping",
    description: "Task-scoped Git closeout. Start with status; read the shipping skill before begin. Records ownership and exact-revision gates in Git-local metadata. Mutations require task-specific user permission; confirm is an attestation, not permission by itself. Never use this to sweep all branches. Operations: begin, status, authorize, amend, attach, release, checkpoint, settle, integrate, refresh, review, verify, publish, land, cleanup.",
    parameters: Type.Object({
      operation: Type.Union(["begin", "status", "authorize", "amend", "attach", "release", "checkpoint", "settle", "integrate", "refresh", "review", "verify", "publish", "land", "cleanup"].map(x => Type.Literal(x))),
      task: Type.Optional(Type.String({ description: "Stable task slug; required except repository-wide read-only status." })),
      path: Type.Optional(Type.String({ description: "Worker worktree for attach/release/checkpoint/settle/integrate." })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Owned repository-relative paths for begin/attach/amend." })),
      base: Type.Optional(Type.String({ description: "Explicit base commit/ref, recorded as a SHA." })),
      delivery: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("pr"), Type.Literal("ship")])),
      route: Type.Optional(Type.Union([Type.Literal("pr"), Type.Literal("direct")])),
      remote: Type.Optional(Type.String({ description: "Configured remote name, never an inferred origin." })),
      repo: Type.Optional(Type.String({ description: "Explicit GitHub owner/repo matching that remote; required for PR route." })),
      target: Type.Optional(Type.String({ description: "Verified default branch name." })),
      checks: Type.Optional(Type.Array(Type.Object({ command: Type.String(), args: Type.Array(Type.String()) }), { description: "Complete canonical verification executables and argv for begin or an explicitly authorized amend. No shell scripts." })),
      mergeMethod: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")])),
      confirm: Type.Optional(Type.Boolean({ description: "Attest explicit user permission for this exact action; settle also attests writers/processes are stopped." })),
      includeExisting: Type.Optional(Type.Boolean({ description: "Adopt inspected existing dirty changes in owned paths only, with confirm." })),
      fresh: Type.Optional(Type.Boolean({ description: "Invalidate cached gate success and rerun all checks, e.g. after environment/dependency changes." })),
      discardIgnored: Type.Optional(Type.Array(Type.String(), { description: "Cleanup only: inspected disposable ignored paths, e.g. node_modules. Never include local user data." })),
      expectedHead: Type.Optional(Type.String({ description: "Exact inspected HEAD; required for revision-sensitive operations." })),
      message: Type.Optional(Type.String({ description: "Conventional checkpoint commit title." })),
      verdict: Type.Optional(Type.Union(["pass", "advisory", "not-required", "block"].map(x => Type.Literal(x)))),
      evidence: Type.Optional(Type.String({ description: "Review source/evidence (never a substitute for required review), or the user-approved reason for release." })),
      title: Type.Optional(Type.String()), body: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      try {
        const result = await shipping(ctx.cwd, ctx.sessionManager.getSessionId(), params as Parameters<typeof shipping>[2], pi.exec.bind(pi), signal);
        const json = JSON.stringify(result, null, 2);
        const bounded = json.split("\n").slice(0, 240).join("\n").slice(0, 24000);
        return textResult(bounded.length < json.length ? `${bounded}\n...[truncated; request status for one task]` : json, false, result);
      } catch (e) { return textResult(e instanceof Error ? e.message : String(e), true); }
    },
  });
}
