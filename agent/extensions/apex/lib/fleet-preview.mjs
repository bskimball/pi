// Preview harness for the fleet waterline.
//   node --experimental-transform-types agent/extensions/apex/lib/fleet-preview.mjs
// Steps the animation deterministically and prints successive frames so travel,
// stalling and the waiting hold can be judged without launching the TUI.

import { FleetWaterline, FLEET_FRAME_MS } from "./fleet-waterline.ts";

const ANSI = {
  customMessageLabel: "\x1b[38;2;167;139;250m",
  borderMuted: "\x1b[38;2;71;85;105m",
  dim: "\x1b[38;2;100;116;139m",
};
const theme = { fg: (key, text) => `${ANSI[key] ?? ""}${text}\x1b[0m` };

const WIDTH = Number(process.argv[2] ?? 74);
const FRAMES = Number(process.argv[3] ?? 14);

const NOW = Date.now();
// Movement is derived from event recency, so a "stalled" worker is simply one
// whose last event is older than the moving window.
const LIVE = NOW;
const STALLED = NOW - 30_000;

const SCENARIOS = {
  "one worker, under way": [
    { id: "task_1", agent: "machinist", lastEventAt: LIVE, waiting: false },
  ],
  "three workers (cap), all under way": [
    { id: "task_1", agent: "machinist", lastEventAt: LIVE, waiting: false },
    { id: "task_2", agent: "scout", lastEventAt: LIVE, waiting: false },
    { id: "task_3", agent: "oracle", lastEventAt: LIVE, waiting: false },
  ],
  "one stalled (drifting), one under way": [
    { id: "task_1", agent: "machinist", lastEventAt: STALLED, waiting: false },
    { id: "task_2", agent: "scout", lastEventAt: LIVE, waiting: false },
  ],
  "one waiting on a reply (holds station)": [
    { id: "task_1", agent: "machinist", lastEventAt: LIVE, waiting: false },
    { id: "task_2", agent: "advisor", lastEventAt: STALLED, waiting: true },
  ],
};

for (const [label, swimmers] of Object.entries(SCENARIOS)) {
  console.log(`\n\x1b[1m${label}\x1b[0m  (${WIDTH} cols, ${FLEET_FRAME_MS}ms/frame)`);
  console.log("\x1b[38;2;71;85;105m" + "\u00b7".repeat(WIDTH) + "\x1b[0m");

  const fleet = new FleetWaterline(theme, () => {});
  fleet.setSwimmers(swimmers);
  for (let frame = 0; frame < FRAMES; frame++) {
    // Drive the clock directly instead of waiting on real time.
    fleet.tick();
    for (const row of fleet.render(WIDTH)) console.log(row);
  }
  fleet.dispose();
}
