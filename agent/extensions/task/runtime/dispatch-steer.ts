/** Concurrent /dispatch steering for the parent orchestrator. */

export const DISPATCH_ENTRY_TYPE = "async-task-dispatch";
export const DISPATCH_USAGE = "Usage: /dispatch <request>";

export function nextDispatchId(now = Date.now(), seq = 0): string {
  return `d-${now.toString(36)}-${(seq + 1).toString(36)}`;
}

export function formatDispatchPrompt(id: string, request: string): string {
  return [
    `Concurrent user dispatch (id=${id}). This is additional work for the SAME orchestrator, not a new session. It arrives while workers may still be running.`,
    "",
    "Route it under the active delegation policy (Regular inline-by-default vs strict-orchestrator specialist-first). Do NOT perform substantial work inline ahead of running workers: if the request outgrows trivial glue, delegate via task_start with the correct specialist (artisan for visual/UI, machinist for non-visual code/config/tests, scribe for prose) in an isolated worktree when parallel.",
    "",
    "Preserve existing tasks. Assess overlap and capacity.",
    "Independent work: isolated worktrees. Overlapping requests: steer the owner or wait.",
    "Review and integrate centrally.",
    "",
    "Request:",
    request,
  ].join("\n");
}

export function formatDispatchAck(id: string): string {
  return `Recorded ${id}; parent steering requested. Route under active delegation policy; delegate via task_start when it outgrows trivial glue.`;
}

export function formatDispatchWaitYield(id: string): string {
  return [
    `Wait yielded for concurrent /dispatch (id=${id}); worker was NOT aborted and this is not a timeout.`,
    "No timeout cooldown was applied. Reconnect with task_wait after the parent absorbs the dispatch, or continue other lead work.",
  ].join("\n");
}
