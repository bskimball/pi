import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildCmdExeCLine,
  firstResolvable,
  killWindowsProcessTree,
  quoteCmdArg,
  resolveCommandPath,
  resolveSpawnCommand,
  windowsExecutableExtensions,
} from "../command.ts";

describe("command resolution", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-cmd-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("parses PATHEXT extensions", () => {
    assert.deepEqual(windowsExecutableExtensions(".COM;.EXE;.BAT;.CMD"), [
      ".COM",
      ".EXE",
      ".BAT",
      ".CMD",
    ]);
    assert.deepEqual(windowsExecutableExtensions("EXE;CMD"), [".EXE", ".CMD"]);
  });

  it("prefers PATHEXT executables over bare shims on Windows (npm dual-file layout)", () => {
    const bin = join(dir, "npm-layout");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "typescript-language-server"), "#!/usr/bin/env node\n");
    writeFileSync(join(bin, "typescript-language-server.cmd"), "@echo off\n");
    writeFileSync(join(bin, "typescript-language-server.ps1"), "echo");

    const resolved = resolveCommandPath(
      "typescript-language-server",
      undefined,
      "win32",
      bin,
      ".COM;.EXE;.BAT;.CMD",
    );
    assert.ok(resolved);
    assert.match(resolved!, /\.cmd$/i);

    const spawnPlan = resolveSpawnCommand(resolved!, ["--stdio"], "win32", "cmd.exe");
    assert.equal(spawnPlan.command, "cmd.exe");
    assert.equal(spawnPlan.windowsVerbatimArguments, true);
    assert.equal(spawnPlan.args[0], "/d");
    assert.equal(spawnPlan.args[1], "/s");
    assert.equal(spawnPlan.args[2], "/c");
    assert.match(spawnPlan.args[3]!, /typescript-language-server\.cmd/i);
  });

  it("never resolves bare names from cwd/repo (PATH hijack regression)", () => {
    const workspace = join(dir, "workspace-hijack");
    const trustedPath = join(dir, "trusted-path");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(trustedPath, { recursive: true });

    // Malicious repo-local fake — must NOT win for bare "gopls".
    writeFileSync(join(workspace, "gopls.cmd"), "@echo off\necho HIJACKED\n");
    writeFileSync(join(workspace, "gopls"), "#!/bin/sh\necho HIJACKED\n");
    // Trusted PATH entry.
    writeFileSync(join(trustedPath, "gopls.cmd"), "@echo off\necho TRUSTED\n");
    writeFileSync(join(trustedPath, "gopls"), "#!/bin/sh\necho TRUSTED\n");

    const previous = process.cwd();
    try {
      process.chdir(workspace);
      const resolvedWin = resolveCommandPath(
        "gopls",
        workspace, // even if a caller passes cwd, bare names must ignore it
        "win32",
        trustedPath,
        ".COM;.EXE;.BAT;.CMD",
      );
      assert.ok(resolvedWin);
      assert.ok(resolvedWin!.toLowerCase().includes("trusted-path"));
      assert.ok(!resolvedWin!.toLowerCase().includes("workspace-hijack"));

      const resolvedUnix = resolveCommandPath("gopls", workspace, "linux", trustedPath);
      assert.equal(resolvedUnix, join(trustedPath, "gopls"));
    } finally {
      process.chdir(previous);
    }
  });

  it("resolves explicit relative commands against baseDir (config dir), not PATH", () => {
    const configDir = join(dir, "cfg-dir");
    const bin = join(configDir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "custom-ls"), "#!/bin/sh\n");
    writeFileSync(join(bin, "custom-ls.cmd"), "@echo off\n");

    const rel = resolveCommandPath(
      "./bin/custom-ls",
      undefined,
      process.platform,
      join(dir, "empty-path-dir-should-not-matter"),
      process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      configDir,
    );
    assert.ok(rel);
    assert.ok(rel!.includes("cfg-dir"));

    const viaFirst = firstResolvable([{ command: "./bin/custom-ls", args: ["--stdio"] }], configDir);
    assert.ok(viaFirst);
    assert.equal(viaFirst!.resolved, rel);
  });

  it("prefers .exe over bare name when both exist on PATH", () => {
    const bin = join(dir, "exe-layout");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gopls"), "not-an-exe");
    writeFileSync(join(bin, "gopls.exe"), "MZ");

    const resolved = resolveCommandPath("gopls", undefined, "win32", bin, ".COM;.EXE;.BAT;.CMD");
    assert.ok(resolved);
    assert.match(resolved!, /\.exe$/i);
  });

  it("leaves non-Windows resolution as exact name on PATH", () => {
    const bin = join(dir, "unix");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gopls"), "#!/bin/sh\n");
    const resolved = resolveCommandPath("gopls", undefined, "linux", bin);
    assert.equal(resolved, join(bin, "gopls"));
  });

  it("quotes cmd args for spaces and supported metacharacters", () => {
    assert.equal(quoteCmdArg("a b"), `"a b"`);
    assert.equal(quoteCmdArg("a&b"), `"a^&b"`);
    assert.equal(quoteCmdArg("p|q"), `"p^|q"`);
    const line = buildCmdExeCLine("C:\\tools\\my server.cmd", ["--stdio", "a&b"]);
    assert.equal(line.startsWith('"'), true);
    assert.equal(line.endsWith('"'), true);
    assert.match(line, /my server\.cmd/);
    assert.match(line, /a\^&b/);
  });

  it("rejects cmd/bat tokens containing % or embedded quotes", () => {
    assert.throws(() => quoteCmdArg("%PATH%"), /cannot contain % or "/);
    assert.throws(() => quoteCmdArg('say "hi"'), /cannot contain % or "/);
    assert.throws(
      () => buildCmdExeCLine("C:\\tools\\my%server.cmd", ["--stdio"]),
      /command path/,
    );
    assert.throws(
      () => resolveSpawnCommand("C:\\tools\\server.cmd", ["--flag=%x%"], "win32", "cmd.exe"),
      /cannot contain % or "/,
    );
    assert.throws(
      () => resolveSpawnCommand('C:\\tools\\ser"ver.cmd', ["--stdio"], "win32", "cmd.exe"),
      /cannot contain % or "/,
    );
  });

  it("spawns .cmd under a spaced directory with meta args (Windows)", async (t) => {
    if (process.platform !== "win32") {
      t.skip("Windows-only cmd.exe quoting integration");
      return;
    }

    const spaced = join(dir, "path with spaces");
    mkdirSync(spaced, { recursive: true });
    const script = join(spaced, "echoargs.cmd");
    writeFileSync(
      script,
      ["@echo off", "echo ARG1=%~1", "echo ARG2=%~2", "echo ARG3=%~3", ""].join("\r\n"),
    );

    const plan = resolveSpawnCommand(script, ["--stdio", "a&b", "x y"], "win32", process.env.ComSpec);
    assert.equal(plan.windowsVerbatimArguments, true);

    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(plan.command, plan.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`exit ${code} stderr=${stderr} stdout=${stdout}`));
          return;
        }
        resolve(stdout);
      });
    });

    assert.match(out, /ARG1=--stdio/);
    assert.match(out, /ARG2=a&b/);
    assert.match(out, /ARG3=x y/);
    assert.doesNotMatch(out, /HIJACK/);
  });

  it("killWindowsProcessTree finishes without throwing on missing pid", async () => {
    await killWindowsProcessTree(2_147_483_646);
  });

  it("kills Windows process tree descendants (cmd-wrapped)", async (t) => {
    if (process.platform !== "win32") {
      t.skip("Windows-only process-tree termination");
      return;
    }

    const work = join(dir, "tree-kill");
    mkdirSync(work, { recursive: true });
    const marker = join(work, "alive.txt");
    const wrapper = join(work, "wrapper.cmd");
    // Wrapper starts a long-running grandchild via start /b and exits the wait loop on marker deletion by parent.
    // We keep the wrapper itself alive with ping so it remains the tree root.
    writeFileSync(
      wrapper,
      [
        "@echo off",
        `start /b \"\" cmd.exe /d /c \"ping -n 60 127.0.0.1 >nul & echo still>%MARKER%\"`.replace(
          "%MARKER%",
          marker.replace(/%/g, "%%"),
        ),
        "ping -n 60 127.0.0.1 >nul",
        "",
      ].join("\r\n"),
    );

    // Simpler tree: cmd.exe /c runs ping as child — kill tree of outer spawn.
    const outer = spawn(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", `ping -n 60 127.0.0.1 >nul`],
      { stdio: "ignore", windowsHide: true },
    );
    const pid = outer.pid;
    assert.ok(pid && pid > 0);

    await new Promise((r) => setTimeout(r, 200));
    await killWindowsProcessTree(pid!);

    const exited = await new Promise<boolean>((resolve) => {
      if (outer.exitCode !== null || outer.killed) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), 3_000);
      outer.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.equal(exited, true, "outer process tree should exit after taskkill /T");
  });
});
