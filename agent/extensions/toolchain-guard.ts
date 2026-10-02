// toolchain-guard: stop agents from switching the Node.js runtime or
// re-pinning it as a workaround for app errors. Blocks version-manager
// switches, global installs of node toolchains, piped installer URLs,
// vp env version changes, and edits to version-pin files.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const REASON =
  "Blocked: changing the Node.js runtime or its version pin is not a fix. " +
  "Read the actual error and fix the application code or dependency instead. " +
  "If the project's pinned Node version genuinely conflicts with the installed runtime, " +
  "report the mismatch to the user and stop. " +
  "(User opt-in: PI_ALLOW_TOOLCHAIN_CHANGE=1.)";

const NVM_READ_ONLY = new Set([
  "ls",
  "list",
  "current",
  "version",
  "ls-remote",
  "which",
]);

const INSTALLER_URLS: Array<[string, string]> = [
  ["nvm-sh/nvm", "nvm installer"],
  ["fnm.vercel.app", "fnm installer"],
  ["get.volta.sh", "volta installer"],
];

function stripExe(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(/\.(cmd|exe|ps1|bat)$/, "");
}

function tokensOf(segment: string): string[] {
  const out: string[] = [];
  for (const raw of segment.split(/\s+/)) {
    const t = raw.trim().replace(/^['"]+|['"]+$/g, "");
    if (t.length > 0) out.push(t.toLowerCase());
  }
  let i = 0;
  while (i < out.length) {
    const t = out[i]!;
    if (
      t === "sudo" ||
      t === "&" ||
      t === "command" ||
      t === "env" ||
      /^[a-z_][a-z0-9_]*=/.test(t)
    ) {
      i++;
    } else {
      break;
    }
  }
  return out.slice(i);
}

function matchSegment(segment: string): string | undefined {
  const tokens = tokensOf(segment);
  if (tokens.length === 0) return undefined;
  const cmd = stripExe(tokens[0]!);
  const rest = tokens.slice(1);
  const verb = rest[0];

  if (cmd === "nvm") {
    if (verb === undefined || verb.startsWith("-") || NVM_READ_ONLY.has(verb)) {
      return undefined;
    }
    return `nvm ${verb}`;
  }

  if (cmd === "fnm") {
    if (verb === undefined || verb.startsWith("-")) return undefined;
    if (
      verb === "use" ||
      verb === "install" ||
      verb === "i" ||
      verb === "default" ||
      verb === "alias" ||
      verb === "unalias"
    ) {
      return `fnm ${verb}`;
    }
    if (
      verb === "env" &&
      rest.some((t) => t === "--use-on-cd" || t.startsWith("--use-on-cd="))
    ) {
      return "fnm env --use-on-cd";
    }
    if (
      verb === "exec" &&
      rest.some((t) => t === "--using" || t.startsWith("--using="))
    ) {
      return "fnm exec --using";
    }
    return undefined;
  }

  if (cmd === "volta") {
    if (verb === undefined || verb.startsWith("-")) return undefined;
    if (verb === "install" || verb === "pin") return `volta ${verb}`;
    if (
      verb === "run" &&
      rest.some((t) => t === "--node" || t.startsWith("--node="))
    ) {
      return "volta run --node";
    }
    return undefined;
  }

  if (cmd === "n") {
    if (rest.every((t) => t.startsWith("-"))) {
      return undefined;
    }
    return `n ${rest[0]}`;
  }

  if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") {
    if ((cmd === "pnpm" || cmd === "yarn") && verb === "dlx") {
      const hit = rest.slice(1).find((t) => /^node@./.test(t));
      return hit === undefined ? undefined : `${cmd} dlx ${hit}`;
    }
    if (!rest.includes("-g") && !rest.includes("--global")) return undefined;
    const words = rest.filter((t) => !t.startsWith("-") && t !== "global");
    const sub = words[0];
    if (sub !== "install" && sub !== "i" && sub !== "add") return undefined;
    const hit = words
      .slice(1)
      .find((t) => /^(node|n|nvm|nvm-windows|fnm|volta)(@.+)?$/.test(t));
    return hit === undefined ? undefined : `${cmd} global install ${hit}`;
  }

  if (cmd === "npx") {
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k]!;
      if (/^node@./.test(t)) return `npx ${t}`;
      if (
        (t === "-p" || t === "--package") &&
        rest[k + 1] !== undefined &&
        /^node@./.test(rest[k + 1]!)
      ) {
        return `npx ${rest[k + 1]}`;
      }
    }
    return undefined;
  }

  if (cmd === "winget") {
    if (!rest.includes("install")) return undefined;
    const hit = rest.find((t) =>
      /^(openjs\.nodejs(\.lts)?|nodejs(\.lts)?|node(\.lts)?|nvm|fnm|volta)$/.test(
        t,
      ),
    );
    return hit === undefined ? undefined : `winget install ${hit}`;
  }

  if (cmd === "choco" || cmd === "chocolatey") {
    if (!rest.some((t) => t === "install" || t === "upgrade")) return undefined;
    const hit = rest.find((t) =>
      /^(nodejs(\.lts)?|node(\.lts)?|nvm|fnm|volta)$/.test(t),
    );
    return hit === undefined ? undefined : `${cmd} ${hit}`;
  }

  if (cmd === "scoop") {
    if (!rest.some((t) => t === "install" || t === "reset")) return undefined;
    const hit = rest.find((t) =>
      /^(nodejs(\.lts)?|node(\.lts)?|nvm|fnm|volta)$/.test(t),
    );
    return hit === undefined ? undefined : `scoop ${hit}`;
  }

  if (cmd === "vp") {
    if (verb !== "env") return undefined;
    const sub = rest[1];
    if (sub === undefined || sub.startsWith("-")) return undefined;
    if (
      sub === "use" ||
      sub === "install" ||
      sub === "i" ||
      sub === "uninstall" ||
      sub === "uni" ||
      sub === "unpin"
    ) {
      return `vp env ${sub}`;
    }
    if (sub === "pin" || sub === "default") {
      return tokens.length > 3 ? `vp env ${sub}` : undefined;
    }
    if (sub === "exec" || sub === "run") {
      return rest.some((t) => t === "--node" || t.startsWith("--node="))
        ? "vp env exec --node"
        : undefined;
    }
    return undefined;
  }

  if (
    ["curl", "wget", "iwr", "invoke-webrequest", "invoke-restmethod"].some(
      (d) => tokens.includes(d),
    )
  ) {
    const low = segment.toLowerCase();
    for (const [url, label] of INSTALLER_URLS) {
      if (low.includes(url)) return label;
    }
  }

  return undefined;
}

function matchShellCommand(command: string): string | undefined {
  for (const segment of command.split(/\r?\n|\|\||&&|\||;/)) {
    if (segment.trim().length === 0) continue;
    const rule = matchSegment(segment);
    if (rule !== undefined) return rule;
  }
  return undefined;
}

function readCurrent(abs: string): string | undefined {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

function applyEdits(
  base: string,
  edits: Array<{ oldText: string; newText: string }>,
): string {
  let out = base;
  for (const e of edits) {
    if (typeof e.oldText !== "string" || typeof e.newText !== "string") {
      continue;
    }
    const idx = out.indexOf(e.oldText);
    if (idx !== -1) {
      out = out.slice(0, idx) + e.newText + out.slice(idx + e.oldText.length);
    }
  }
  return out;
}

function toolVersionsNodeLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().toLowerCase();
    if (/^(nodejs|node)\s+\S/.test(t)) lines.push(t);
  }
  return lines;
}

// Parse failure (or unreadable old file) allows: without two JSON trees to
// compare we cannot tell a pin change from a legit edit.
function packagePinChanged(
  before: string | undefined,
  after: string,
): boolean {
  let next: unknown;
  try {
    next = JSON.parse(after);
  } catch {
    return false;
  }
  let prev: unknown = {};
  if (before !== undefined) {
    try {
      prev = JSON.parse(before);
    } catch {
      return false;
    }
  }
  if (typeof prev !== "object" || prev === null) return false;
  if (typeof next !== "object" || next === null) return false;
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  return ["engines", "devEngines", "volta"].some(
    (key) => JSON.stringify(p[key]) !== JSON.stringify(n[key]),
  );
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (process.env.PI_ALLOW_TOOLCHAIN_CHANGE === "1") return;

    if (
      isToolCallEventType("bash", event) ||
      isToolCallEventType("powershell", event)
    ) {
      const command = event.input.command;
      if (typeof command !== "string" || command.length === 0) return;
      const rule = matchShellCommand(command);
      if (rule !== undefined) return { block: true, reason: `${REASON} [${rule}]` };
      return;
    }

    if (
      !isToolCallEventType("edit", event) &&
      !isToolCallEventType("write", event)
    ) {
      return;
    }
    const rawPath = event.input.path;
    if (typeof rawPath !== "string" || rawPath.length === 0) return;
    const base = path.basename(rawPath);
    if (
      base !== ".nvmrc" &&
      base !== ".node-version" &&
      base !== ".tool-versions" &&
      base !== "package.json"
    ) {
      return;
    }
    if (base === ".nvmrc" || base === ".node-version") {
      return { block: true, reason: `${REASON} [${base}]` };
    }
    const abs = path.resolve(ctx.cwd, rawPath);
    const before = readCurrent(abs);
    let after: string;
    if (isToolCallEventType("edit", event)) {
      const edits = event.input.edits;
      if (!Array.isArray(edits)) return;
      after = applyEdits(before ?? "", edits);
    } else {
      const content = event.input.content;
      if (typeof content !== "string") return;
      after = content;
    }
    if (base === ".tool-versions") {
      const prevLines = before === undefined ? [] : toolVersionsNodeLines(before);
      if (
        JSON.stringify(prevLines) !== JSON.stringify(toolVersionsNodeLines(after))
      ) {
        return { block: true, reason: `${REASON} [.tool-versions nodejs]` };
      }
      return;
    }
    if (packagePinChanged(before, after)) {
      return { block: true, reason: `${REASON} [package.json pin]` };
    }
  });
}
