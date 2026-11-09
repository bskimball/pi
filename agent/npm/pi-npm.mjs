// settings.json npmCommand wrapper. Pi's package install runs
// `npm install <spec> --prefix <root>` and does not run this project's postinstall.
import { spawn } from "node:child_process";
import { patchAntigravityTypebox } from "./patch-host-peers.mjs";

const forwarded = process.argv.slice(process.argv.indexOf("--") + 1);
const [command, ...args] = forwarded;
if (!command) {
	console.error("pi-npm: missing forwarded package-manager command");
	process.exit(1);
}

const child = spawnPackageManager(command, args);
child.on("error", (error) => {
	console.error(error.message);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	const status = code ?? 1;
	if (status === 0 && isPackageInstall(command, args)) {
		try {
			patchAntigravityTypebox(installPrefix(args));
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	}
	process.exit(status);
});

function spawnPackageManager(command, args) {
	if (process.platform !== "win32") {
		return spawn(command, args, { stdio: "inherit" });
	}
	// Node rejects spawn("npm") / spawn("npm.cmd") without a shell (EINVAL),
	// and shell:true does not escape arguments (DEP0190). Quote for cmd.exe instead.
	const meta = /([()\][%!^"`<>&|;, *?])/g;
	const escapeCommand = (value) => value.replace(meta, "^$1");
	const escapeArgument = (value) => {
		let arg = `${value}`;
		arg = arg.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
		arg = arg.replace(/(?=(\\+?)?)\1$/g, "$1$1");
		return `"${arg}"`.replace(meta, "^$1");
	};
	const shellCommand = [escapeCommand(command), ...args.map(escapeArgument)].join(" ");
	return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${shellCommand}"`], {
		stdio: "inherit",
		windowsHide: true,
		windowsVerbatimArguments: true,
	});
}

function isPackageInstall(command, args) {
	const base = command.replace(/\.(cmd|exe)$/i, "").toLowerCase();
	return (base === "npm" || base === "pnpm" || base === "bun") && ["install", "update", "ci"].includes(args[0]);
}

function installPrefix(args) {
	const flag = args.indexOf("--prefix");
	if (flag >= 0 && args[flag + 1]) return args[flag + 1];
	const cwd = args.indexOf("--cwd");
	if (cwd >= 0 && args[cwd + 1]) return args[cwd + 1];
	return import.meta.dirname;
}
