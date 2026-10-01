// Process start identity, vendored from the Prime Agent TypeScript session lease
// (packages/coding-agent/src/core/session-lease.ts; MIT License, see LICENSE). Only the identity concern moved
// here; the factory needs no lease storage or locking.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface ProcessQueryOptions {
	env?: NodeJS.ProcessEnv;
}

type ProcessQuery = (command: string, args: string[], options?: ProcessQueryOptions) => string;

function runProcessQuery(command: string, args: string[], options?: ProcessQueryOptions): string {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: options?.env,
		windowsHide: true,
	});
}

export function getWindowsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const startTicks = query("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
		]).trim();
		return /^\d+$/.test(startTicks) ? `win:${startTicks}` : undefined;
	} catch {
		return undefined;
	}
}

export function getPsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		// `lstart` is rendered in the subprocess timezone and locale, so pin both for a durable identity.
		const startTime = query("ps", ["-p", String(pid), "-o", "lstart="], {
			env: { ...process.env, LC_ALL: "C", LC_TIME: "C", LANG: "C", TZ: "UTC" },
		}).trim();
		return startTime ? `ps:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A durable identity for the process with this pid: `proc:<starttime>` from /proc on Linux, `ps:<lstart>` on other
 * POSIX systems, `win:<ticks>` on Windows. An invalid pid or a process that cannot be observed gives undefined,
 * never a pid-only identity.
 */
export function getProcessStartId(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "win32") return getWindowsProcessStartId(pid);
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		const fields = stat.slice(commandEnd + 2).split(" ");
		const startTime = fields[19];
		if (startTime) return `proc:${startTime}`;
	} catch {
		// Fall through to the portable process listing used on macOS and BSD.
	}
	return getPsProcessStartId(pid);
}
