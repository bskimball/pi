#!/usr/bin/env node

import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_PORT = 29300;
const port = parsePort(process.env.BROWSER_PORT);
const profileDir = path.resolve(expandHome(process.env.BROWSER_PROFILE_DIR || "~/.pi/browser/chrome-profile"));
const cdpBase = `http://127.0.0.1:${port}`;
const versionUrl = `${cdpBase}/json/version`;
const platform = process.platform;

function parsePort(value) {
  if (!value) return DEFAULT_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    fail(`Invalid BROWSER_PORT: ${value}`, 2);
  }
  return parsed;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function isHttpUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function fileExists(file) {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(names) {
  const directories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const directory of directories) {
    for (const name of names) {
      const hasExtension = path.extname(name) !== "";
      const candidates = hasExtension ? [name] : extensions.map((ext) => `${name}${ext.toLowerCase()}`);
      for (const candidate of candidates) {
        const fullPath = path.join(directory.replace(/^"|"$/g, ""), candidate);
        if (existsSync(fullPath)) return fullPath;
      }
    }
  }
  return null;
}

async function findChrome() {
  if (process.env.CHROME_PATH) {
    const override = path.resolve(expandHome(process.env.CHROME_PATH));
    if (await fileExists(override)) return override;
    fail(`CHROME_PATH does not exist: ${override}`);
  }

  let candidates = [];
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    candidates = [
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
  } else if (platform === "darwin") {
    candidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  } else {
    const found = findOnPath(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]);
    if (found) return found;
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  fail("Chrome/Chromium was not found. Set CHROME_PATH to the browser executable.");
}

function requestJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
  });
}

async function getCdpVersion() {
  try {
    const version = await requestJson(versionUrl);
    return version?.webSocketDebuggerUrl ? version : null;
  } catch {
    return null;
  }
}

async function waitForCdp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await getCdpVersion();
    if (version) return version;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function launchChrome(url) {
  if (await getCdpVersion()) return false;

  const chrome = await findChrome();
  await mkdir(profileDir, { recursive: true });
  const target = isHttpUrl(url) ? url : "about:blank";
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    target,
  ];

  console.log("Launching dedicated visible Chrome");
  console.log(`  executable: ${chrome}`);
  console.log(`  profile:    ${profileDir}`);
  console.log(`  port:       ${port}`);
  console.log(`  target:     ${target}`);

  const child = spawn(chrome, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  const version = await waitForCdp();
  if (!version) {
    fail(`Chrome was launched, but classic CDP did not become ready at ${versionUrl} within 15 seconds. Check whether port ${port} is already occupied.`);
  }
  console.log(`Classic CDP ready at ${versionUrl}`);
  return true;
}

async function resolveAgentBrowser() {
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const native = path.join(appData, "npm", "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe");
    if (await fileExists(native)) return { executable: native, commandFile: false };
  }

  const resolved = findOnPath(platform === "win32" ? ["agent-browser.exe", "agent-browser.cmd", "agent-browser"] : ["agent-browser"]);
  if (!resolved) return null;
  return { executable: resolved, commandFile: platform === "win32" && /\.(cmd|bat)$/i.test(resolved) };
}

function quoteCmd(value) {
  return `"${String(value).replace(/([()%!^"<>&|])/g, "^$1")}"`;
}

function runResolved(command, args, options = {}) {
  const spawnOptions = {
    encoding: "utf8",
    windowsHide: true,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  };
  if (command.commandFile) {
    const commandLine = [command.executable, ...args].map(quoteCmd).join(" ");
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], spawnOptions);
  }
  return spawnSync(command.executable, args, spawnOptions);
}

async function runAgentBrowser(args, { required = true, capture = false } = {}) {
  const command = await resolveAgentBrowser();
  if (!command) {
    if (required) console.error("agent-browser is unavailable; install it or add it to PATH.");
    return { available: false, ok: false, stdout: "", stderr: "" };
  }

  const result = runResolved(command, ["--cdp", String(port), ...args], { capture });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (capture) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  if (result.error) console.error(`Failed to run agent-browser: ${result.error.message}`);
  return { available: true, ok: result.status === 0, stdout, stderr };
}

async function ensureClassicCdp(url) {
  const version = await getCdpVersion();
  if (version) return { launched: false, version };
  const launched = await launchChrome(url);
  return { launched, version: await getCdpVersion() };
}

async function listPages() {
  const targets = await requestJson(`${cdpBase}/json/list`);
  return targets.filter((target) => target.type === "page");
}

function printPages(pages) {
  for (const page of pages) {
    console.log(`[${page.id}] ${page.url}`);
  }
}

async function attachUrl(url) {
  const pages = await listPages();
  const destination = new URL(url);
  const matching = pages.find((page) => page.url === destination.href)
    || (destination.pathname === "/" && !destination.search && !destination.hash
      ? pages.find((page) => isHttpUrl(page.url) && new URL(page.url).origin === destination.origin)
      : null);

  // Initial strict attachment creates a blank tab, so select the target before pinning.
  const selected = await runAgentBrowser([
    "--no-pin-tab", "tab", ...(matching ? [matching.id] : ["new", url]),
  ]);
  const pinned = await runAgentBrowser(["--pin-tab", "tab", "list"]);
  if (!selected.available || !selected.ok) fail(`Could not select the requested app tab on CDP port ${port}.`);
  if (!pinned.ok) fail(`Could not pin the requested app tab on CDP port ${port}.`);
  console.log(matching ? "TAB: reused matching app tab (left open)" : "TAB: opened requested URL in a new tab (left open)");
}

async function connect(input) {
  const url = isHttpUrl(input) ? input : null;
  if (input && !url) {
    console.log(`Task noted (no navigation): ${input}`);
  }

  const { launched } = await ensureClassicCdp(url);
  console.log("Connecting");
  console.log("  mode:  classic");
  console.log(`  port:  ${port}`);
  console.log("  allow: not required");

  const agentBrowser = await resolveAgentBrowser();
  if (!agentBrowser) {
    if (url && launched) {
      console.log("agent-browser is unavailable; Chrome was launched directly with the requested URL.");
      return;
    }
    if (url) {
      fail("agent-browser is unavailable, so the already-running debug Chrome cannot be navigated to the requested URL.");
    }
    console.log("agent-browser is unavailable; Chrome is attached via classic CDP, but automation verification was skipped.");
    return;
  }

  if (url) {
    await attachUrl(url);
  } else {
    printPages(await listPages());
    console.log("No tab selected. Connect with the target HTTP(S) URL before browser actions.");
  }
  console.log("STATUS: connected");
}

async function status() {
  console.log(`Dedicated profile: ${profileDir}`);
  console.log(`Preferred port:    ${port}`);
  const version = await getCdpVersion();
  if (!version) {
    console.log("Mode:              down");
    console.log(`HTTP discovery:    ${versionUrl} (unavailable)`);
    return;
  }
  console.log("Mode:              classic");
  console.log(`HTTP discovery:    ${versionUrl} (OK)`);
  console.log(`Browser:           ${version.Browser || "unknown"}`);
  printPages(await listPages());
}

async function tabs() {
  if (!(await getCdpVersion())) fail(`Debug Chrome is not running at ${versionUrl}. Run 'node browser-connect.mjs launch' first.`);
  printPages(await listPages());
}

async function openUrl(url) {
  if (!isHttpUrl(url)) fail("Usage: node browser-connect.mjs open <http-or-https-url>", 2);
  await connect(url);
}

async function login() {
  const google = "https://accounts.google.com/";
  const microsoft = "https://login.microsoftonline.com/";
  const { launched } = await ensureClassicCdp(google);
  const command = await resolveAgentBrowser();
  if (command) {
    await attachUrl(google);
    await attachUrl(microsoft);
  } else if (!launched) {
    fail("agent-browser is unavailable, so login pages cannot be opened in the already-running debug Chrome.");
  }
  console.log("Sign into Google/Microsoft once in the dedicated debug Chrome window; this profile will retain those sessions.");
}

function help() {
  console.log(`Usage: node browser-connect.mjs <command> [args]

Commands:
  connect [url-or-task]  Reuse a matching app tab for HTTP(S) URLs; otherwise only list tabs
  status                 Show classic CDP status and tabs without attaching
  tabs                   List tabs without attaching or creating a tab
  open <url>              Reuse a matching app tab, or open the URL in a new tab
  launch                  Launch the dedicated visible debug Chrome
  login                   Open Google and Microsoft login pages
  stop                    Refuse broad killing; close this profile manually
  disconnect              No-op compatibility command; Chrome remains running
  help                    Show this help

Environment:
  BROWSER_PORT            CDP port (default: ${DEFAULT_PORT})
  BROWSER_PROFILE_DIR     Profile directory (default: ~/.pi/browser/chrome-profile)
  CHROME_PATH             Chrome/Chromium executable override`);
}

async function main() {
  const [command = "connect", ...args] = process.argv.slice(2);
  const input = args.join(" ").trim();
  switch (command) {
    case "connect":
    case "attach":
      await connect(input);
      break;
    case "status":
      await status();
      break;
    case "tabs":
      await tabs();
      break;
    case "open":
      await openUrl(input);
      break;
    case "launch":
    case "start":
      await ensureClassicCdp(null);
      break;
    case "login":
    case "auth":
      await login();
      break;
    case "disconnect":
      console.log("No detach action is needed; all automation commands explicitly use the dedicated CDP port.");
      break;
    case "stop":
      fail(`For safety, stop is unsupported: close the Chrome window using profile '${profileDir}' manually. Daily Chrome was not touched.`);
      break;
    case "help":
    case "-h":
    case "--help":
      help();
      break;
    default:
      if (isHttpUrl(command) && args.length === 0) await connect(command);
      else {
        help();
        fail(`Unknown command: ${command}`, 2);
      }
  }
}

main().catch((error) => fail(error?.stack || String(error)));
