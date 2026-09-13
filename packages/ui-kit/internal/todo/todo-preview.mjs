// Width harness for the todo surface. Renders the collapsed panel, the
// expanded panel, and the transcript receipt across terminal widths, flags any
// line that overflows its budget, and exits nonzero on a bound failure.
//
//   node --experimental-transform-types agent/extensions/apex/internal/todo/todo-preview.mjs
//   node --experimental-transform-types agent/extensions/apex/internal/todo/todo-preview.mjs 44 100

import {
  TODO_LIST_MAX_LINES,
  buildTodoList,
  renderTodoList,
} from "./todo-view.ts";
import { safeVisibleWidth } from "../presentation/safe-text-layout.ts";

const PALETTE = {
  toolTitle: "\u001b[38;2;125;211;252m",
  text: "\u001b[38;2;226;232;240m",
  muted: "\u001b[38;2;148;163;184m",
  dim: "\u001b[38;2;100;116;139m",
  success: "\u001b[38;2;74;222;128m",
  warning: "\u001b[38;2;251;191;36m",
  error: "\u001b[38;2;248;113;113m",
  borderMuted: "\u001b[38;2;51;65;85m",
};

const theme = {
  fg: (key, text) => `${PALETTE[key] ?? PALETTE.text}${text}\u001b[0m`,
};

const visible = (line) => safeVisibleWidth(line);

const SAMPLE = [
  { content: "Read the Observatory conventions", status: "completed" },
  { content: "Move the todo surface under apex/internal", status: "completed" },
  {
    content:
      "Render bounded rows that keep working past the right edge of a narrow terminal",
    status: "in_progress",
    note: "width-safe layout",
  },
  { content: "Restore the edit diff receipt", status: "blocked", note: "waiting on theme" },
  { content: "Adapt the moved tests", status: "pending" },
  { content: "Delete the standalone entry points", status: "pending" },
  { content: "Re-run the observatory preview", status: "pending" },
  { content: "Drop the retired footer patch", status: "cancelled" },
];

const SCENARIOS = [
  { label: "collapsed panel", view: SAMPLE, options: { collapsed: true, toggleHint: "alt+t" } },
  { label: "expanded panel", view: SAMPLE, options: { toggleHint: "alt+t" } },
  { label: "transcript receipt (expanded)", view: SAMPLE, options: { expanded: true } },
  { label: "empty", view: [], options: { emptyHint: "todo_write to start a plan" } },
];

const widths = process.argv.slice(2).map(Number).filter(Number.isFinite);
const columns = widths.length ? widths : [40, 60, 80, 100, 120];

let failures = 0;
for (const width of columns) {
  for (const scenario of SCENARIOS) {
    const view = buildTodoList(scenario.view);
    const lines = renderTodoList(theme, width, view, scenario.options);
    console.log(
      `\n\u001b[2m${String(width).padStart(3)} cols \u00b7 ${scenario.label}\u001b[0m`,
    );
    console.log(`\u001b[2m${"\u2500".repeat(width)}\u001b[0m`);
    for (const line of lines) {
      const cells = visible(line);
      if (cells > width) {
        failures++;
        console.log(`${line}  \u001b[31m<- OVERFLOW ${cells}/${width}\u001b[0m`);
      } else {
        console.log(line);
      }
    }
    if (lines.length > TODO_LIST_MAX_LINES) {
      failures++;
      console.log(
        `\u001b[31mTOO TALL ${lines.length}/${TODO_LIST_MAX_LINES}\u001b[0m`,
      );
    }
  }
}

console.log(
  failures ? `\n${failures} bound failure(s)` : "\nall todo scenarios within bounds",
);
process.exit(failures ? 1 : 0);
