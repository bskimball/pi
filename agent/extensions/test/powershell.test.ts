import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  buildPowerShellScript,
  executePowerShell,
  resolvePowerShellExecutable,
} from "../powershell.ts";

function probeExecutable(executable: string): boolean {
  try {
    return (
      resolvePowerShellExecutable({
        envPath: executable,
        probe: undefined,
      }) === executable
    );
  } catch {
    return false;
  }
}

function tryResolve(): string | undefined {
  try {
    return resolvePowerShellExecutable();
  } catch {
    return undefined;
  }
}

function tryResolveNamed(name: string): string | undefined {
  try {
    return resolvePowerShellExecutable({
      envPath: null,
      candidates: [name],
    });
  } catch {
    return undefined;
  }
}

describe("buildPowerShellScript", () => {
  it("includes Stop preference and conditional native-command preference", () => {
    const script = buildPowerShellScript("Write-Output 'hi'");
    assert.match(script, /\$ErrorActionPreference = 'Stop'/);
    assert.match(
      script,
      /Get-Variable -Name PSNativeCommandUseErrorActionPreference/,
    );
    assert.match(
      script,
      /\$PSNativeCommandUseErrorActionPreference = \$true/,
    );
    assert.match(script, /Write-Output 'hi'/);
  });

  it("includes LASTEXITCODE epilogue for native nonzero propagation", () => {
    const script = buildPowerShellScript("cmd /c exit 7");
    assert.match(script, /\$LASTEXITCODE/);
    assert.match(script, /exit \[int\]\$LASTEXITCODE/);
  });
});

describe("resolvePowerShellExecutable", () => {
  it("returns an explicit env path when the probe succeeds", () => {
    const resolved = resolvePowerShellExecutable({
      envPath: "C:\\Custom\\pwsh.exe",
      probe: (exe) => exe === "C:\\Custom\\pwsh.exe",
      candidates: ["pwsh.exe", "powershell.exe"],
    });
    assert.equal(resolved, "C:\\Custom\\pwsh.exe");
  });

  it("hard-fails when an explicit env path does not probe successfully", () => {
    assert.throws(
      () =>
        resolvePowerShellExecutable({
          envPath: "C:\\Missing\\pwsh.exe",
          probe: () => false,
          candidates: ["pwsh.exe"],
        }),
      /PI_POWERSHELL_PATH is set to "C:\\Missing\\pwsh\.exe"/,
    );
  });

  it("tries candidates in order when no env path is set", () => {
    const tried: string[] = [];
    const resolved = resolvePowerShellExecutable({
      envPath: null,
      candidates: ["first.exe", "second.exe", "third.exe"],
      probe: (exe) => {
        tried.push(exe);
        return exe === "second.exe";
      },
    });
    assert.equal(resolved, "second.exe");
    assert.deepEqual(tried, ["first.exe", "second.exe"]);
  });

  it("uses Windows default candidate order including powershell.exe", () => {
    const tried: string[] = [];
    resolvePowerShellExecutable({
      envPath: null,
      platform: "win32",
      probe: (exe) => {
        tried.push(exe);
        return exe === "powershell.exe";
      },
    });
    assert.deepEqual(tried, ["pwsh.exe", "pwsh", "powershell.exe"]);
  });

  it("omits Windows-only powershell.exe on non-Windows defaults", () => {
    const tried: string[] = [];
    assert.throws(() =>
      resolvePowerShellExecutable({
        envPath: null,
        platform: "linux",
        probe: (exe) => {
          tried.push(exe);
          return false;
        },
      }),
    );
    assert.deepEqual(tried, ["pwsh", "pwsh.exe"]);
  });
});

describe("executePowerShell", () => {
  const executable = tryResolve();
  const itIfPs = executable ? it : it.skip;

  itIfPs("runs a successful command and returns stdout", async () => {
    const result = await executePowerShell(
      "Write-Output 'hello-from-ps'",
      process.cwd(),
      { executable },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.aborted, false);
    assert.equal(result.timedOut, false);
    assert.match(result.output, /hello-from-ps/);
    assert.equal(result.truncated, false);
    assert.equal(result.fullOutputPath, undefined);
  });

  itIfPs("runs in the requested cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ps-cwd-"));
    writeFileSync(join(dir, "marker.txt"), "marker", "utf8");
    const result = await executePowerShell(
      "Get-Content -Path .\\marker.txt",
      dir,
      { executable },
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /marker/);
  });

  itIfPs("fails on Write-Error under ErrorActionPreference Stop", async () => {
    const result = await executePowerShell(
      "Write-Error 'intentional-failure'",
      process.cwd(),
      { executable },
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.output, /intentional-failure|exited with code/i);
  });

  itIfPs("fails on native nonzero exit when pwsh is available", async () => {
    const command =
      process.platform === "win32" ? "cmd /c exit 2" : "false";
    const result = await executePowerShell(command, process.cwd(), {
      executable,
    });
    // PowerShell 7+ with PSNativeCommandUseErrorActionPreference should fail.
    // Windows PowerShell 5.1 relies on the LASTEXITCODE epilogue.
    assert.notEqual(result.exitCode, 0);
  });

  itIfPs("times out and kills the process tree", async () => {
    const result = await executePowerShell(
      "Start-Sleep -Seconds 30",
      process.cwd(),
      {
        executable,
        timeout: 1,
      },
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, false);
    assert.match(result.output, /timed out after 1 seconds/);
  });

  itIfPs(
    "truncates large output, retains fullOutputPath with early and late lines, and allows cleanup",
    async () => {
      // 2500 short lines exceeds the 2000-line limit while staying quick.
      const result = await executePowerShell(
        "1..2500 | ForEach-Object { \"line-$_\" }",
        process.cwd(),
        { executable },
      );
      assert.equal(result.truncated, true);
      assert.ok(result.fullOutputPath, "fullOutputPath should be set");
      assert.ok(
        existsSync(result.fullOutputPath!),
        "full output file should exist",
      );
      const full = readFileSync(result.fullOutputPath!, "utf8");
      assert.match(full, /line-1\b/);
      assert.match(full, /line-2500\b/);
      // Tail notice / content should mention late lines, not dump everything.
      assert.match(result.output, /line-2500/);
      assert.match(result.output, /Full output:/);
      assert.ok(
        !result.output.includes("line-1\n") ||
          result.output.includes("Showing lines"),
        "truncated view should not be the full stream without a notice",
      );

      // Test cleanup of retained full-output temp.
      const fullDir = dirname(result.fullOutputPath!);
      rmSync(fullDir, { recursive: true, force: true });
      assert.equal(existsSync(result.fullOutputPath!), false);
    },
  );
});

describe("executePowerShell via Windows PowerShell 5.1", () => {
  const winPs =
    process.platform === "win32" ? tryResolveNamed("powershell.exe") : undefined;
  const itIfWinPs = winPs ? it : it.skip;

  itIfWinPs(
    "propagates native cmd /c exit 7 as nonzero via powershell.exe",
    async () => {
      const result = await executePowerShell("cmd /c exit 7", process.cwd(), {
        executable: winPs,
      });
      assert.notEqual(
        result.exitCode,
        0,
        `expected nonzero exit from powershell.exe for cmd /c exit 7, got ${result.exitCode}`,
      );
      assert.equal(result.exitCode, 7);
    },
  );
});

// Keep probe helper referenced so tree-shaking tools leave it alone.
void probeExecutable;
