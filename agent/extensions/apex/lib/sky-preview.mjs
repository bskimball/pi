// Preview harness for the star field, the re-entry line and the dive.
//   node --experimental-transform-types agent/extensions/apex/lib/sky-preview.mjs

import { starFieldRow } from "./star-field.ts";
import { renderReentry } from "./reentry.ts";
import { DiveView } from "./dive.ts";

const ANSI = {
  accent: "\x1b[38;2;125;211;252m",
  customMessageLabel: "\x1b[38;2;167;139;250m",
  text: "\x1b[38;2;226;232;240m",
  muted: "\x1b[38;2;148;163;184m",
  dim: "\x1b[38;2;100;116;139m",
  borderMuted: "\x1b[38;2;71;85;105m",
};
const fg = (key, text) => `${ANSI[key] ?? ANSI.text}${text}\x1b[0m`;
const theme = { fg };

const WIDTH = Number(process.argv[2] ?? 74);
const rule = () => console.log(fg("borderMuted", "\u2500".repeat(WIDTH)));

console.log("\n\x1b[1mSAME PROJECT, SAME SKY (stability across launches)\x1b[0m");
rule();
for (let run = 0; run < 3; run++) {
  console.log(starFieldRow(fg, 42, "C:/Users/me/dev/apex", 0));
}

console.log("\n\x1b[1mDIFFERENT PROJECTS, DIFFERENT SKIES\x1b[0m");
rule();
for (const seed of [
  "C:/Users/me/dev/apex",
  "C:/Users/me/dev/other-repo",
  "C:/Users/me/.pi",
  "/tmp/scratch",
]) {
  console.log(`${starFieldRow(fg, 42, seed, 0)}   ${fg("dim", seed)}`);
}

console.log("\n\x1b[1mCONTEXT FILLS, STARS GO OUT (same project)\x1b[0m");
rule();
for (const fill of [0, 0.25, 0.5, 0.7, 0.85, 0.95]) {
  const sky = starFieldRow(fg, 42, "C:/Users/me/dev/apex", fill);
  console.log(`${sky.padEnd(60)} ${fg("dim", `${Math.round(fill * 100)}% full`)}`);
}

console.log("\n\x1b[1mRE-ENTRY\x1b[0m");
rule();
for (const view of [
  { workspace: "apex", seed: "C:/Users/me/dev/apex", messages: 48, sinceMs: 7_400_000, contextFill: 0.3 },
  { workspace: "pi", seed: "C:/Users/me/.pi", messages: 1, sinceMs: 45_000, contextFill: 0.05 },
  { workspace: "long-project-name", seed: "/tmp/scratch", messages: 312, sinceMs: 400_000_000, contextFill: 0.8 },
]) {
  for (const row of renderReentry(fg, WIDTH, view)) console.log(row);
  console.log();
}

console.log("\x1b[1mDIVE\x1b[0m");
rule();
const dive = new DiveView(theme, () => {});
dive.start("threshold");
for (let frame = 0; frame < 16; frame++) {
  dive.tick();
  if (frame % 4 !== 3) continue;
  for (const row of dive.render(WIDTH)) console.log(row);
  console.log();
}
dive.surface(148_000, 42_000);
for (const row of dive.render(WIDTH)) console.log(row);
dive.dispose();
