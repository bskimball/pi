export interface ContextUsageLike {
  percent: number | null;
  tokens: number | null;
  contextWindow: number;
}

/**
 * End a timed-out wait turn when the parent context is already crowded enough
 * that another status/wait loop would delay Pi's between-run auto-compaction.
 * The worker is independent and continues running.
 */
export function shouldCheckpointTimedOutWait(
  usage: ContextUsageLike | undefined,
  reserveTokens: number,
): boolean {
  return (
    usage?.tokens != null &&
    Number.isFinite(usage.tokens) &&
    usage.contextWindow > 0 &&
    usage.tokens > Math.max(0, usage.contextWindow - reserveTokens)
  );
}

export function contextCheckpointNote(
  usage: ContextUsageLike | undefined,
  reserveTokens: number,
): string | undefined {
  if (!shouldCheckpointTimedOutWait(usage, reserveTokens)) return undefined;
  const percent =
    usage!.percent == null ? "near its limit" : `${Math.round(usage!.percent)}% full`;
  return `Parent context is ${percent}; ending this turn so Pi can auto-compact while the worker continues.`;
}
