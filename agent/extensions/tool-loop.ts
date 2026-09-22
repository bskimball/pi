// tool-loop: notice when the agent re-runs the same call and gets the same
// answer, and say so once.
//
// Session telemetry showed one run issue ~15 near-identical bash verification
// commands inside ~2 minutes, and another run 169 bash calls with 30 errors.
// Repeating a call whose result is byte-identical cannot have changed the
// world, so the repetition is pure token burn. On the third identical
// {tool, input, result} this request, append one line saying so.
//
// Advisory by design: identical output can be legitimate (the same test
// passing after unrelated edits), so this never blocks and never rewrites
// the result. It only appends.

import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Repeats needed before the nudge. The third identical answer is the signal. */
const LOOP_THRESHOLD = 3;

/** Distinct signatures tracked per request. Bounds memory on huge requests. */
const MAX_SIGNATURES = 200;

/** Result prefix that feeds the hash. Enough to separate distinct outputs. */
const HASHED_RESULT_CHARS = 2048;

/** Counts per signature for the current agent loop. */
export type LoopState = Map<string, number>;

export function createLoopState(): LoopState {
  return new Map();
}

function digest(value: string): string {
  return createHash("sha1").update(value).digest("base64").slice(0, 16);
}

/**
 * Stable signature for one call+answer pair. Object keys are sorted so
 * argument order cannot disguise an identical call.
 */
export function toolSignature(
  toolName: string,
  input: Record<string, unknown>,
  resultText: string,
): string {
  let args: string;
  try {
    args = JSON.stringify(input, Object.keys(input).sort());
  } catch {
    // Circular or non-serializable input: fall back to the key shape so the
    // signature stays stable instead of throwing inside a tool result.
    args = Object.keys(input).sort().join(",");
  }
  return `${toolName}\u0000${digest(args)}\u0000${digest(resultText.slice(0, HASHED_RESULT_CHARS))}`;
}

export function loopNudge(toolName: string, count: number): string {
  return (
    `[loop] ${toolName} has returned an identical result ${count} times in this request ` +
    `— the state has not changed. Change approach or stop repeating it.`
  );
}

/**
 * Record one call+answer pair and return the nudge when it crosses the
 * threshold. Fires on exactly the threshold hit, so later repeats stay quiet.
 */
export function noteToolSignature(
  state: LoopState,
  toolName: string,
  signature: string,
): string | undefined {
  const seen = state.get(signature);
  if (seen === undefined && state.size >= MAX_SIGNATURES) return undefined;
  const count = (seen ?? 0) + 1;
  state.set(signature, count);
  return count === LOOP_THRESHOLD ? loopNudge(toolName, count) : undefined;
}

export default function (pi: ExtensionAPI): void {
  let state = createLoopState();

  // One agent loop is one user request. Tool repetition spans several model
  // turns, so turn_start would reset the count before a loop is visible.
  pi.on("agent_start", () => {
    state = createLoopState();
  });
  pi.on("session_start", () => {
    state = createLoopState();
  });

  pi.on("tool_result", (event) => {
    if (process.env.PI_BEHAVIOR_MODE === "pi") return;

    let resultText = "";
    for (const block of event.content) {
      if (block.type === "text") {
        resultText += block.text;
        if (resultText.length >= HASHED_RESULT_CHARS) break;
      }
    }
    // Image-only results carry no comparable text; a repeated screenshot is
    // already handled by read-guard.
    if (!resultText) return;

    const signature = toolSignature(event.toolName, event.input, resultText);
    const nudge = noteToolSignature(state, event.toolName, signature);
    if (!nudge) return;

    return { content: [...event.content, { type: "text" as const, text: nudge }] };
  });
}
