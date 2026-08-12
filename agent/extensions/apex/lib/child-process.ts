// Environment isolation for child Pi processes (sync `task` and RPC workers).
//
// Child Pi processes are noninteractive on every OS: their callsites pipe or
// ignore all stdio, keep them supervised (not detached), and disable Apex plus
// the terminal watchdog. On Windows, `windowsHide` additionally prevents a
// child console association with the interactive ConPTY.
//
// Supervised children stay attached to the parent so close/kill still work.

/** Environment for a child Pi. Always disables Apex UI in the child. */
export function isolatedChildEnv(
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    PI_APEX_UI: "0",
    PI_TERMINAL_WATCHDOG: "0",
  };
}
