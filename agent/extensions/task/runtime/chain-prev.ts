import { boundText } from "./text-bounds.ts";
import { SETTLED_RESULT_CHARS } from "./worker-status.ts";

/** Replace every `{{prev}}` with a char-capped previous-step report. */
export function substitutePrev(template: string, previous: string, cap = SETTLED_RESULT_CHARS): string {
  const capped = boundText(previous, cap, Number.POSITIVE_INFINITY).text;
  return template.split("{{prev}}").join(capped);
}
