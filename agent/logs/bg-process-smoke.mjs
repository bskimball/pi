import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

const piRoot = path.join(os.homedir(), ".pi");
const require = createRequire(
  path.join(
    piRoot,
    "node_modules/@earendil-works/pi-coding-agent/package.json",
  ),
);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = jiti(
  path.join(piRoot, "agent/extensions/bg-process.ts"),
).default;

const tools = new Map();
const api = {
  registerTool(t) {
    tools.set(t.name, t);
  },
  on() {},
  sendMessage(msg, opts) {
    console.log("NOTIFY", JSON.stringify({ content: msg.content, opts }));
  },
};
factory(api);

const ctx = { cwd: process.cwd() };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bg-smoke-"));
fs.writeFileSync(
  path.join(tmp, "server.mjs"),
  `
console.log("ready on bg-smoke");
console.error("stderr-hello");
let n = 0;
setInterval(() => {
  n++;
  console.log("tick", n);
}, 200);
setInterval(() => {}, 1000);
`,
);
fs.writeFileSync(
  path.join(tmp, "parent.mjs"),
  `
import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  ["-e", "setInterval(() => console.log('child-alive'), 300); setInterval(() => {}, 1000);"],
  { stdio: "inherit", windowsHide: true },
);
console.log("parent", process.pid, "child", child.pid);
setInterval(() => {}, 1000);
`,
);

function textOf(r) {
  return r.content.map((c) => c.text).join("\n");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listNodeChildren(pid) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | Select-Object -ExpandProperty ProcessId`,
      ],
      { windowsHide: true },
    );
    let out = "";
    ps.stdout.on("data", (c) => (out += c.toString()));
    ps.on("close", () => {
      resolve(
        out
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number)
          .filter((n) => Number.isFinite(n)),
      );
    });
  });
}

async function run() {
  // Direct cmd sanity (matches extension spawn style)
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "node -e \"console.log('cmd-ok')\""],
      { cwd: tmp, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => {
      console.log("CMD_SANITY", { code, out: out.trim(), err: err.trim() });
      if (code !== 0) reject(new Error("cmd sanity failed"));
      else resolve();
    });
  });

  const start = await tools.get("bg_start").execute(
    "1",
    {
      command: "node server.mjs",
      title: "smoke-server",
      working_dir: tmp,
    },
    undefined,
    undefined,
    ctx,
  );
  console.log("START\n" + textOf(start));
  if (start.isError) process.exit(1);
  const id = textOf(start).match(/bg_\d+/)[0];
  await new Promise((r) => setTimeout(r, 900));

  const status = await tools
    .get("bg_status")
    .execute("2", { id }, undefined, undefined, ctx);
  console.log("STATUS\n" + textOf(status).slice(0, 900));
  if (!textOf(status).includes("ready on bg-smoke")) {
    console.error("FAIL: missing stdout");
    process.exitCode = 1;
  }
  const list = await tools
    .get("bg_list")
    .execute("3", {}, undefined, undefined, ctx);
  console.log("LIST\n" + textOf(list));

  const pid = Number(textOf(status).match(/pid=(\d+)/)[1]);
  console.log("pid", pid, "alive_before_kill", alive(pid));
  if (!alive(pid)) {
    console.error("FAIL: expected running process");
    process.exitCode = 1;
  }

  const kill = await tools
    .get("bg_kill")
    .execute("4", { id }, undefined, undefined, ctx);
  console.log("KILL\n" + textOf(kill).slice(0, 700));
  await new Promise((r) => setTimeout(r, 900));

  const status2 = await tools
    .get("bg_status")
    .execute("5", { id }, undefined, undefined, ctx);
  console.log(
    "STATUS2\n" + textOf(status2).split("\n").slice(0, 10).join("\n"),
  );
  console.log("alive_after_kill", alive(pid));
  if (alive(pid)) {
    console.error("FAIL: parent still alive");
    process.exitCode = 2;
  }
  if (!/killed|failed|completed/.test(textOf(status2))) {
    console.error("FAIL: unexpected status after kill");
    process.exitCode = 2;
  }

  // Nested child process tree
  const start2 = await tools.get("bg_start").execute(
    "6",
    {
      command: "node parent.mjs",
      title: "tree-smoke",
      working_dir: tmp,
    },
    undefined,
    undefined,
    ctx,
  );
  console.log("START2\n" + textOf(start2));
  const id2 = textOf(start2).match(/bg_\d+/)[0];
  await new Promise((r) => setTimeout(r, 900));
  const st2 = await tools
    .get("bg_status")
    .execute("7", { id: id2 }, undefined, undefined, ctx);
  console.log("TREE_STATUS\n" + textOf(st2).slice(0, 700));
  const pid2 = Number(textOf(st2).match(/pid=(\d+)/)[1]);
  // On Windows the shell is the job pid; find node descendants via CIM from that pid tree is hard.
  // Capture child pid from stdout if present.
  const childPidMatch = textOf(st2).match(/child\s+(\d+)/);
  const nestedChild = childPidMatch ? Number(childPidMatch[1]) : null;
  console.log("tree pids", { shellOrNode: pid2, nestedChild });

  await tools
    .get("bg_kill")
    .execute("8", { id: id2 }, undefined, undefined, ctx);
  await new Promise((r) => setTimeout(r, 1200));
  console.log("tree_parent_alive_after_kill", alive(pid2));
  if (nestedChild != null) {
    console.log("tree_child_alive_after_kill", alive(nestedChild));
    if (alive(nestedChild)) {
      console.error("FAIL: nested child still alive");
      process.exitCode = 3;
    }
  }
  if (alive(pid2)) {
    console.error("FAIL: tree parent still alive");
    process.exitCode = 3;
  }

  const bad = await tools.get("bg_start").execute(
    "9",
    { command: "echo hi", working_dir: path.join(tmp, "nope-missing") },
    undefined,
    undefined,
    ctx,
  );
  console.log("BAD_CWD_IS_ERROR", !!bad.isError, textOf(bad));

  // Cap check: not exhausting, just ensure list still works
  const list2 = await tools
    .get("bg_list")
    .execute("10", { include_settled: true }, undefined, undefined, ctx);
  console.log("LIST2\n" + textOf(list2).slice(0, 500));

  console.log(process.exitCode ? "SMOKE_FAIL" : "SMOKE_OK");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
