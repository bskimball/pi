// Environment isolation for child Pi processes (sync `task` and RPC workers).
//
// Child Pi processes are noninteractive on every OS: their callsites pipe or
// ignore all stdio, keep them supervised (not detached), and disable Apex plus
// the terminal watchdog. On Windows, `windowsHide` additionally prevents a
// child console association with the interactive ConPTY.
//
// Supervised children stay attached to the parent so close/kill still work.

const BROWSER_TOOLS = [
  "browser_tabs", "browser_read_page", "browser_screenshot", "browser_click",
  "browser_type", "browser_press_key", "browser_scroll", "browser_evaluate",
  "browser_navigate", "terminal_read",
];

/** Child tool policy shared by sync tasks and RPC workers. */
export function childToolArgs(
  def: { apexBrowser?: boolean; tools?: string },
  excludedTools: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [];
  const injectedTools: string[] = [];
  if (def.apexBrowser && env.PRIME_WORK_BROWSER_URL?.trim() &&
      env.PRIME_WORK_BROWSER_TOKEN?.trim() && env.PRIME_WORK_BROWSER_EXTENSION_PATH?.trim()) {
    args.push("--extension", env.PRIME_WORK_BROWSER_EXTENSION_PATH);
    injectedTools.push(...BROWSER_TOOLS);
    if (env.APEX_BROWSER_AGENT_EXTENSION_PATH?.trim()) {
      args.push("--extension", env.APEX_BROWSER_AGENT_EXTENSION_PATH);
      injectedTools.push("browser_run");
    }
    excludedTools += ",browser_task";
  }
  args.push("--exclude-tools", excludedTools);
  if (def.tools) {
    const tools = def.tools.split(",").map((tool) => tool.trim()).filter(Boolean);
    if (tools.length) args.push("--tools", [...new Set([...tools, ...injectedTools])].join(","));
  }
  return args;
}

/** Environment for a child Pi. Always disables Apex UI in the child. */
export function isolatedChildEnv(
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    PI_UI_CHROME: "0",
    PI_APEX_UI: "0",
    PI_TERMINAL_WATCHDOG: "0",
  };
}
