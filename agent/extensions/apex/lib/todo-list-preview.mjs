// Preview harness for the Apex todo-list surface.
//   node --experimental-transform-types agent/extensions/apex/lib/todo-list-preview.mjs
//   node --experimental-transform-types agent/extensions/apex/lib/todo-list-preview.mjs 80
// Renders every scenario collapsed and expanded at several widths with apex-dark
// colors approximated, so composition can be judged without launching the TUI.

import { buildTodoList, renderTodoList, TODO_LIST_MAX_LINES } from "./todo-list.ts";
import { fallbackVisibleWidth } from "./safe-text-layout.ts";

const ANSI = {
  accent: "\x1b[38;2;125;211;252m", // cyan
  customMessageLabel: "\x1b[38;2;167;139;250m", // violet
  toolTitle: "\x1b[38;2;167;139;250m",
  toolOutput: "\x1b[38;2;148;163;184m",
  text: "\x1b[38;2;226;232;240m",
  muted: "\x1b[38;2;148;163;184m",
  dim: "\x1b[38;2;100;116;139m",
  borderMuted: "\x1b[38;2;71;85;105m",
  success: "\x1b[38;2;134;239;172m",
  warning: "\x1b[38;2;253;224;71m",
  error: "\x1b[38;2;248;113;113m",
};
const theme = { fg: (key, text) => `${ANSI[key] ?? ANSI.text}${text}\x1b[0m` };

const todo = (content, status, note) => ({ content, status, note });

const LONG_TITLE =
  "Render every bounded row so that a pathological single-line task description " +
  "with no natural break points at all still stops cleanly at the right edge";

/** An actually unbroken token: no spaces at all, so wrapping must hard-split. */
const UNBROKEN_TOKEN = "x".repeat(60) + "/" + "y".repeat(60) + "_" + "z".repeat(60);

/** Values that throw on plain property access or on String() coercion. */
const throwingGetter = { get content() { throw new Error("getter boom"); } };
const throwingProxy = new Proxy({}, { get() { throw new Error("proxy boom"); } });
const revoked = (() => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
})();
const nullProto = Object.create(null);
const throwingToString = { content: { toString() { throw new Error("toString boom"); } } };
const hostileStatus = { content: "hostile status field", get status() { throw new Error("status boom"); } };

const SCENARIOS = {
  "empty list": { raw: [], title: "", emptyHint: "todo_write to start a plan" },
  "mixed statuses": {
    title: "Ship the harness",
    raw: [
      todo("Read the Observatory conventions", "completed"),
      todo("Draft the builder and renderer", "completed"),
      todo("Render bounded rows", "in_progress", "blocked on theme keys"),
      todo("Add the preview harness", "pending"),
      todo("Publish the release notes", "blocked", "waiting on the user's copy review"),
      todo("Wire it into the live UI", "cancelled", "out of scope"),
    ],
  },
  "blocked behind completed work (anchor must reach the open item)": {
    title: "All remaining work blocked",
    raw: [
      ...Array.from({ length: 8 }, (_, index) => todo(`Completed step ${index + 1}`, "completed")),
      todo("Waiting on reviewer decision", "blocked", "needs design approval"),
    ],
  },
  "long text": {
    title: "Wrapping behaviour",
    raw: [
      todo("Short settled item", "completed"),
      todo(LONG_TITLE, "in_progress", "note text is bounded too, and also quite long"),
      todo(LONG_TITLE, "pending"),
    ],
  },
  "long list (24 items, active near the end)": {
    title: "Migration",
    raw: Array.from({ length: 24 }, (_, index) =>
      todo(
        `Step ${index + 1}: migrate module ${String.fromCharCode(97 + (index % 26))}`,
        index < 18 ? "completed" : index === 18 ? "in_progress" : "pending",
      ),
    ),
  },
  "all pending": {
    title: "Fresh plan",
    raw: [
      todo("Investigate the crash", "pending"),
      todo("Write a failing test", "pending"),
      todo("Fix it", "pending"),
    ],
  },
  "unbroken token (no spaces at all)": {
    title: "Hard split",
    raw: [
      todo(UNBROKEN_TOKEN, "in_progress", "note"),
      todo(UNBROKEN_TOKEN, "pending"),
    ],
  },
  "exactly 200 items (full tally, no truncation)": {
    title: "Tally width",
    raw: Array.from({ length: 200 }, (_, index) =>
      todo(`Item ${index + 1}`, index < 198 ? "completed" : "pending"),
    ),
  },
  "hostile values (null-proto, symbols, throwing getters/proxies)": {
    title: "Untrusted payload",
    raw: [
      null,
      undefined,
      nullProto,
      throwingGetter,
      throwingProxy,
      revoked,
      throwingToString,
      hostileStatus,
      { content: Symbol("symbol title") },
      { content: "symbol status", status: Symbol("doing") },
      { content: "hostile note", get note() { throw new Error("note boom"); } },
      { content: "hostile id", get id() { throw new Error("id boom"); } },
      { content: "", status: "completed" },
      { title: "Alternate field name", status: "DOING" },
      { text: "Third field name", state: "skipped" },
      "bare string item",
      ...Array.from({ length: 400 }, (_, index) => todo(`overflow ${index}`, "pending")),
    ],
  },
};

/* ------------------------------------------------------------------ */
/* Semantic assertions                                                 */
/* ------------------------------------------------------------------ */

const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
const problems = [];
const check = (label, condition, detail = "") => {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

// (1) buildTodoList never throws, and skips entries it cannot render.
for (const [label, value] of [
  ["Object.create(null)", nullProto],
  ["throwing getter", throwingGetter],
  ["throwing proxy", throwingProxy],
  ["revoked proxy", revoked],
  ["throwing toString", throwingToString],
  ["symbol title", { content: Symbol("s") }],
  ["symbol item", Symbol("bare")],
  ["bigint item", 10n],
]) {
  try {
    const view = buildTodoList([value]);
    check(`build tolerates ${label}`, view.total <= 1);
    for (const item of view.items) {
      check(`item from ${label} has a title`, item.title.length > 0);
      check(`item from ${label} has an id`, item.id.length > 0);
    }
  } catch (error) {
    problems.push(`build THREW on ${label}: ${error?.message ?? error}`);
  }
}
for (const [label, title] of [
  ["null-proto title", nullProto],
  ["symbol title", Symbol("opt")],
  ["throwing title", { toString() { throw new Error("title boom"); } }],
  ["missing options", undefined],
]) {
  try {
    const view = buildTodoList([], label === "missing options" ? undefined : { title });
    check(`options.title tolerates ${label}`, typeof view.title === "string");
  } catch (error) {
    problems.push(`options.title THREW on ${label}: ${error?.message ?? error}`);
  }
}
try {
  check("non-array payload yields an empty list", buildTodoList("not an array").total === 0);
  check("null payload yields an empty list", buildTodoList(null).total === 0);
} catch (error) {
  problems.push(`non-array payload THREW: ${error?.message ?? error}`);
}
// Focused array-container intake: length and slice must not throw past the guard.
{
  const throwingLength = new Proxy([], {
    get(target, prop, receiver) {
      if (prop === "length") throw new Error("length boom");
      return Reflect.get(target, prop, receiver);
    },
  });
  const hostileSlice = new Proxy([todo("kept if slice were honest", "pending")], {
    get(target, prop, receiver) {
      if (prop === "slice") return () => {
        throw new Error("slice boom");
      };
      return Reflect.get(target, prop, receiver);
    },
  });
  const nonArraySlice = new Proxy([todo("item", "pending"), todo("other", "pending")], {
    get(target, prop, receiver) {
      if (prop === "slice") return () => ({ not: "an array" });
      return Reflect.get(target, prop, receiver);
    },
  });
  for (const [label, value, expectDroppedZero] of [
    ["array proxy with throwing length", throwingLength, true],
    ["array proxy with throwing slice", hostileSlice, true],
    ["array proxy with non-array slice result", nonArraySlice, false],
  ]) {
    try {
      const view = buildTodoList(value);
      check(`build tolerates ${label}`, view.total === 0);
      if (expectDroppedZero) {
        check(`dropped is zero for ${label}`, view.dropped === 0);
      }
    } catch (error) {
      problems.push(`build THREW on ${label}: ${error?.message ?? error}`);
    }
  }
}

// (2) the tally keeps every digit for the largest list the builder will keep.
{
  const view = buildTodoList(
    Array.from({ length: 200 }, (_, index) =>
      todo(`Item ${index + 1}`, index < 198 ? "completed" : "pending"),
    ),
  );
  check("builder keeps 200 items", view.total === 200, `total=${view.total}`);
  for (const width of [60, 80, 120]) {
    const header = plain(renderTodoList(theme, width, view, {})[0]);
    check(
      `tally is intact at ${width} cols`,
      header.includes("198/200"),
      `header=${JSON.stringify(header)}`,
    );
  }
}

// (3) the elision note is truthful: the skipped head is not necessarily done.
{
  const view = buildTodoList(
    Array.from({ length: 24 }, (_, index) =>
      todo(`Step ${index + 1}`, index === 18 ? "in_progress" : "pending"),
    ),
  );
  const body = renderTodoList(theme, 80, view, {}).map(plain).join("\n");
  check("elision note omits 'done'", !body.includes("done earlier"), body.split("\n")[1]);
  check("elision note reads 'N earlier'", /\u251c\u2500 \d+ earlier/.test(body));
}

// (4) blocked is open work: never counted as done, and never windowed out of view.
{
  const view = buildTodoList([
    ...Array.from({ length: 8 }, (_, index) => todo(`Completed step ${index + 1}`, "completed")),
    todo("Waiting on reviewer decision", "blocked", "needs design approval"),
  ]);
  check("blocked is not counted as done", view.done === 8, `done=${view.done}`);
  check("blocked is counted", view.counts.blocked === 1, `blocked=${view.counts.blocked}`);
  check("activeIndex stays in-progress-only", view.activeIndex === -1, `activeIndex=${view.activeIndex}`);
  check("anchor falls back to the blocked item", view.anchorIndex === 8, `anchorIndex=${view.anchorIndex}`);
  for (const width of [60, 80, 120]) {
    const body = renderTodoList(theme, width, view, {}).map(plain).join("\n");
    check(
      `blocked row is visible at ${width} cols`,
      body.includes("Waiting on reviewer decision"),
      body,
    );
    check(`blocked count is in the header at ${width} cols`, body.includes("1 blocked"));
  }
}

// (5) the anchor prefers in_progress, then blocked, then pending.
{
  const anchorOf = (statuses) =>
    buildTodoList(statuses.map((status, index) => todo(`Item ${index + 1}`, status))).anchorIndex;
  check("anchor prefers in_progress", anchorOf(["completed", "blocked", "in_progress", "pending"]) === 2);
  check("anchor falls back to blocked", anchorOf(["completed", "pending", "blocked"]) === 2);
  check("anchor falls back to pending", anchorOf(["completed", "completed", "pending"]) === 2);
  check("anchor is -1 with no open work", anchorOf(["completed", "cancelled"]) === -1);
}

// Worst-case height and pad: neither may exceed the caps.
for (const scenario of Object.values(SCENARIOS)) {
  const view = buildTodoList(scenario.raw, { title: scenario.title });
  for (const width of [8, 20, 40, 80, 200]) {
    for (const pad of [0, 2, 8, 99]) {
      const lines = renderTodoList(theme, width, view, { expanded: true, pad });
      check(
        `height <= ${TODO_LIST_MAX_LINES} at ${width}/pad ${pad}`,
        lines.length <= TODO_LIST_MAX_LINES,
        `got ${lines.length}`,
      );
      for (const line of lines) {
        check(
          `width <= ${width} at pad ${pad}`,
          fallbackVisibleWidth(line) <= width,
          JSON.stringify(plain(line)),
        );
      }
    }
  }
}
check("zero width renders nothing", renderTodoList(theme, 0, buildTodoList([todo("x", "pending")])).length === 0);

// A collapsed dock is one truthful summary row and keeps its toggle affordance.
{
  const view = buildTodoList([
    todo("Finished", "completed"),
    todo("Current work", "in_progress"),
    todo("Next work", "pending"),
  ]);
  for (const width of [20, 40, 80, 120]) {
    const lines = renderTodoList(theme, width, view, {
      collapsed: true,
      toggleHint: "alt+t",
    });
    check(`collapsed dock is one line at ${width} cols`, lines.length === 1, lines.join("\n"));
    check(
      `collapsed dock fits at ${width} cols`,
      lines.every((line) => fallbackVisibleWidth(line) <= width),
      lines.map(plain).join("\n"),
    );
  }
  const wide = renderTodoList(theme, 120, view, {
    collapsed: true,
    toggleHint: "alt+t",
  }).map(plain).join("\n");
  check("collapsed dock shows its toggle hint", wide.includes("alt+t"), wide);
  check("collapsed dock omits item rows", !wide.includes("Current work"), wide);
}

const OVERRIDES = process.argv.slice(2).map(Number).filter(Boolean);
const widths = OVERRIDES.length ? OVERRIDES : [40, 60, 80, 100, 120];

let failures = 0;
for (const [label, scenario] of Object.entries(SCENARIOS)) {
  const view = buildTodoList(scenario.raw, { title: scenario.title });
  for (const width of widths) {
    for (const expanded of [false, true]) {
      const lines = renderTodoList(theme, width, view, {
        expanded,
        emptyHint: scenario.emptyHint,
      });
      const overflow = lines.filter((line) => fallbackVisibleWidth(line) > width);
      const tooTall = lines.length > TODO_LIST_MAX_LINES;
      if (overflow.length || tooTall) failures++;
      console.log(
        `\n\x1b[7m ${label} — ${width} cols — ${expanded ? "expanded" : "collapsed"} — ` +
          `${lines.length} lines ${tooTall ? "TOO TALL " : ""}${overflow.length ? "OVERFLOW " : ""}\x1b[0m`,
      );
      console.log("\x1b[48;2;10;12;20m" + "·".repeat(width) + "\x1b[0m");
      for (const line of lines) {
        const gap = " ".repeat(Math.max(0, width - fallbackVisibleWidth(line)));
        console.log(`\x1b[48;2;10;12;20m${line}${gap}\x1b[0m`);
      }
      console.log("\x1b[48;2;10;12;20m" + "·".repeat(width) + "\x1b[0m");
    }
  }
}

if (problems.length) {
  console.log(`\n${problems.length} semantic assertion(s) FAILED:`);
  for (const problem of problems.slice(0, 20)) console.log(`  × ${problem}`);
  if (problems.length > 20) console.log(`  · ${problems.length - 20} more`);
} else {
  console.log("\nall semantic assertions passed");
}
console.log(failures ? `${failures} scenario(s) FAILED bounds` : "all scenarios within bounds");
process.exit(failures || problems.length ? 1 : 0);
