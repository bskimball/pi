// Preview harness for the HAL working-indicator candidates.
//   node --experimental-transform-types agent/extensions/apex/preview-indicator.mjs
//   node --experimental-transform-types agent/extensions/apex/preview-indicator.mjs --animate core
//   node --experimental-transform-types agent/extensions/apex/preview-indicator.mjs --animate-all
// Static filmstrip by default so every option compares at a glance. Timers
// here are fine: this is a standalone CLI preview, not the extension render
// path (which stays event-driven per the no-timer rule).

import {
  HAL_DEFAULT_CANDIDATE,
  HAL_INDICATOR_CANDIDATES,
  HAL_WORKING_MESSAGES,
} from "./apex-ui.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const { loadThemeFromPath } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "modes/interactive/theme/theme.js")).href);
const halTheme = loadThemeFromPath(fileURLToPath(new URL("../../themes/hal-dark.json", import.meta.url)), "truecolor");
const fg = (key, text) => halTheme.fg(key, text);
const stubCtx = { hasUI: true, ui: { theme: { fg } } };
// Fixed lead tone keeps every candidate comparable in the filmstrip.
const LEAD = "thinkingHigh";

function pickPhrase() {
  return HAL_WORKING_MESSAGES[Math.floor(Math.random() * HAL_WORKING_MESSAGES.length)];
}

function filmstrip() {
  for (const candidate of HAL_INDICATOR_CANDIDATES) {
    const frames = candidate.build(stubCtx, LEAD);
    const marker = candidate.name === HAL_DEFAULT_CANDIDATE ? " (default)" : "";
    console.log(
      `\n\x1b[1m${candidate.name}${marker}\x1b[0m — ${candidate.description} [${candidate.intervalMs}ms, ${frames.length} frames]`,
    );
    console.log(frames.slice(0, 12).join(" "));
  }
  const sample = [...HAL_WORKING_MESSAGES]
    .sort(() => Math.random() - 0.5)
    .slice(0, 8);
  console.log("\n\x1b[1mphrases\x1b[0m (sample of 8):");
  for (const phrase of sample) console.log(`  ${phrase}...`);
  console.log(
    `\nAnimate one: node --experimental-transform-types agent/extensions/apex/preview-indicator.mjs --animate <name>\nNames: ${HAL_INDICATOR_CANDIDATES.map((candidate) => candidate.name).join(", ")}`,
  );
}

function hideCursor() {
  process.stdout.write("\x1b[?25l");
}

function showCursor() {
  process.stdout.write("\x1b[?25h\n");
}

function animateFor(candidate, ms) {
  const frames = candidate.build(stubCtx, LEAD);
  const phrase = pickPhrase();
  console.log(`\x1b[1m${candidate.name}\x1b[0m — ${candidate.description}`);
  let index = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1b[K${frames[index % frames.length]} ${phrase}...`);
    index++;
  }, candidate.intervalMs);
  return new Promise((resolve) => {
    setTimeout(() => {
      clearInterval(timer);
      process.stdout.write("\r\x1b[K");
      resolve();
    }, ms);
  });
}

const args = process.argv.slice(2);
if (args[0] === "--animate") {
  const candidate = HAL_INDICATOR_CANDIDATES.find((entry) => entry.name === args[1]);
  if (!candidate) {
    console.error(
      `unknown candidate ${JSON.stringify(args[1])}; names: ${HAL_INDICATOR_CANDIDATES.map((entry) => entry.name).join(", ")}`,
    );
    process.exit(1);
  }
  hideCursor();
  process.on("SIGINT", () => {
    showCursor();
    process.exit(0);
  });
  // Loops until Ctrl-C; the SIGINT handler restores the cursor.
  await animateFor(candidate, Number.POSITIVE_INFINITY);
} else if (args[0] === "--animate-all") {
  hideCursor();
  process.on("SIGINT", () => {
    showCursor();
    process.exit(0);
  });
  for (const candidate of HAL_INDICATOR_CANDIDATES) {
    await animateFor(candidate, 3000);
  }
  showCursor();
} else {
  filmstrip();
}
