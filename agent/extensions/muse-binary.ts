// muse-binary: point npm:pi-muse-bridge at the real Muse Code executable on Windows.
//
// The bridge spawns `muse` with shell:false, but Windows installs `muse` as
// `muse.cmd` -> `.muse-launcher.ps1`, which Node cannot spawn without a shell
// (ENOENT). The launcher only selects `muse-bin-<.muse-version>.exe` and runs
// it; login lives in the binary. Resolve that same file at load so updates are
// followed on the next Pi start. An explicit PI_MUSE_BINARY still wins.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(\.[0-9]+)?$/;

function activeMuseBinary(): string | undefined {
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return undefined;
	const dir = join(localAppData, "Programs", "muse");
	try {
		const version = readFileSync(join(dir, ".muse-version"), "utf8").trim();
		if (!VERSION_PATTERN.test(version)) return undefined;
		const binary = join(dir, `muse-bin-${version}.exe`);
		return existsSync(binary) ? binary : undefined;
	} catch {
		return undefined;
	}
}

export default function (_pi: ExtensionAPI): void {
	if (process.platform !== "win32" || process.env.PI_MUSE_BINARY?.trim()) return;
	const binary = activeMuseBinary();
	if (binary) process.env.PI_MUSE_BINARY = binary;
}
