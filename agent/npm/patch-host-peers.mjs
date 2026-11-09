// pi-antigravity 0.12.0 still depends on host-provided `typebox`.
// Pi warns, and an installed copy can bypass the extension loader.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function patchAntigravityTypebox(prefix) {
	const manifestPath = join(prefix, "node_modules", "pi-antigravity", "package.json");
	if (!existsSync(manifestPath)) return false;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const dependencies = manifest.dependencies;
	if (!dependencies || typeof dependencies !== "object" || !Object.hasOwn(dependencies, "typebox")) {
		return false;
	}
	delete dependencies.typebox;
	if (Object.keys(dependencies).length === 0) delete manifest.dependencies;
	manifest.peerDependencies ??= {};
	manifest.peerDependencies.typebox = "*";
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	return true;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
	patchAntigravityTypebox(process.argv[2] ?? import.meta.dirname);
}
