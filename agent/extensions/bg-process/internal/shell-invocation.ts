// shell-invocation: platform shell for long-running background jobs.
//
// Windows must hand the command to cmd.exe /d /s /c as one verbatim quoted
// line. Node's default argument quoting plus /S strips the wrong quotes, so a
// command with a quoted path exits immediately (or crashes) instead of running.

import * as path from "node:path";

export interface ShellInvocation {
  file: string;
  args: string[];
  detached: boolean;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
}

export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellInvocation {
  if (platform === "win32") {
    const comspec =
      env.ComSpec?.trim() ||
      path.join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    // A trailing backslash would escape the closing quote that /S strips.
    const line = command.endsWith("\\") ? `${command} ` : command;
    return {
      file: comspec,
      args: ["/d", "/s", "/c", `"${line}"`],
      detached: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    };
  }
  const sh = env.SHELL?.trim() || "/bin/sh";
  return {
    file: sh,
    args: ["-c", command],
    detached: true,
  };
}
