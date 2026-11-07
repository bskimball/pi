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
    "Treat this as a request to launch a subagent as soon as you receive it. Choose the appropriate available specialist and call task_start promptly; do not first do the requested investigation or implementation yourself. This explicit dispatch takes precedence over an inline-by-default preference.",
    "",
    "Preserve existing tasks and assess overlap, capacity, and ownership. Choose whether the worker needs an isolated worktree; never allow concurrent writers to overlap in a shared worktree. If an existing worker owns overlapping work, steer that owner or wait rather than start a conflicting writer. If capacity or another prerequisite prevents a launch, tell the user and launch when safe.",
    "Review and integrate centrally.",
    "",
    "Request:",
    request,
  ].join("\n");
}

export function formatDispatchAck(id: string): string {
  return `Recorded ${id}; parent steering requested to launch a worker. Launch is not yet confirmed.`;
}

export function formatDispatchWaitYield(id: string): string {
  return [
    `Wait yielded for concurrent /dispatch (id=${id}); worker was NOT aborted and this is not a timeout.`,
    "No timeout cooldown was applied. Reconnect with task_wait after the parent absorbs the dispatch, or continue other lead work.",
  ].join("\n");
}
