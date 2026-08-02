// Preview harness for the Observatory landing screen.
//   node --experimental-transform-types agent/extensions/apex/lib/observatory-preview.mjs
// Renders every scenario at several widths with apex-dark colors approximated,
// so composition can be judged without launching the TUI.

import { buildObservatory, renderObservatory, OBSERVATORY_MAX_LINES } from "./observatory.ts";
import { fallbackVisibleWidth } from "./safe-text-layout.ts";

const ANSI = {
  accent: "\x1b[38;2;125;211;252m", // cyan
  customMessageLabel: "\x1b[38;2;167;139;250m", // violet
  text: "\x1b[38;2;226;232;240m",
  muted: "\x1b[38;2;148;163;184m",
  dim: "\x1b[38;2;100;116;139m",
  borderMuted: "\x1b[38;2;71;85;105m",
  success: "\x1b[38;2;134;239;172m",
  warning: "\x1b[38;2;253;224;71m",
};
const fg = (key, text) => `${ANSI[key] ?? ANSI.text}${text}\x1b[0m`;

const cmd = (name, source, scope, description) => ({
  name,
  description,
  source,
  sourceInfo: { path: `/tmp/${name}.md`, scope, origin: "top-level", source: "local" },
});

const SCENARIOS = {
  // Real specialist agents from ~/.pi/agent/agents are always discovered too.
  "screenshot (3 pathways, 16 skills + specialists)": [
    cmd("brainstorm", "prompt", "user", "Explore the space of options"),
    cmd("browser", "extension", "user", "Attach to dedicated authenticated debug Chrome"),
    cmd("deploy", "extension", "user", "Delegate lint, format, verify, and deploy"),
    ...[
      "create-implementation-plan", "autoresearch", "a11y-debugging",
      "acquire-codebase-knowledge", "agent-browser", "background-process",
      "chrome-devtools", "chrome-devtools-cli", "codex", "debug-optimize-lcp",
      "generate-image", "grill-me", "make-interfaces-feel-better",
      "memory-leak-debugging", "troubleshooting", "vscode",
    ].map((n) => cmd(`skill:${n}`, "skill", "user", `Do ${n}`)),
  ],
  "balanced project (3 prompts, 3 skills + specialists)": [
    cmd("plan", "prompt", "project", "Plan the change"),
    cmd("review", "prompt", "project", "Review a diff"),
    cmd("brainstorm", "prompt", "user", "Explore options"),
    cmd("skill:autoresearch", "skill", "project", "Research"),
    cmd("skill:generate-image", "skill", "user", "Make an image"),
    cmd("skill:vscode", "skill", "user", "Drive vscode"),
  ],
  "pathways with extension commands": [
    cmd("brainstorm", "prompt", "user", "Explore options"),
    cmd("browser", "extension", "user", "Attach to dedicated authenticated debug Chrome"),
    cmd("deploy", "extension", "user", "Delegate lint, format, verify, and deploy"),
    cmd("observatory", "extension", "user", "Should not appear as a pathway"),
    cmd("skill:agent-browser", "skill", "user", "Browse"),
  ],
  // Commands empty; specialists from the agent catalog still appear.
  "empty command inventory": [],
};

const WIDTHS = process.argv.slice(2).map(Number).filter(Boolean);
const widths = WIDTHS.length ? WIDTHS : [40, 60, 80, 100, 120, 160];

let failures = 0;
for (const [label, commands] of Object.entries(SCENARIOS)) {
  const view = buildObservatory(commands, "C:/Users/bskim/Dev/thin-lsp");
  for (const width of widths) {
    const lines = renderObservatory(view, fg, width);
    const overflow = lines.filter((l) => fallbackVisibleWidth(l) > width);
    const tooTall = lines.length > OBSERVATORY_MAX_LINES;
    if (overflow.length || tooTall) failures++;
    console.log(
      `\n\x1b[7m ${label} — ${width} cols — ${lines.length} lines ` +
        `${tooTall ? "TOO TALL " : ""}${overflow.length ? "OVERFLOW " : ""}\x1b[0m`,
    );
    console.log("\x1b[48;2;10;12;20m" + "·".repeat(width) + "\x1b[0m");
    for (const line of lines) {
      const pad = " ".repeat(Math.max(0, width - fallbackVisibleWidth(line)));
      console.log(`\x1b[48;2;10;12;20m${line}${pad}\x1b[0m`);
    }
    console.log("\x1b[48;2;10;12;20m" + "·".repeat(width) + "\x1b[0m");
  }
}

console.log(failures ? `\n${failures} scenario(s) FAILED bounds` : "\nall scenarios within bounds");
process.exit(failures ? 1 : 0);
