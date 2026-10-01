import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { getProcessStartId, getPsProcessStartId, getWindowsProcessStartId } from "../src/process-identity.js";

it("names a live process by its start, keeps that name for its lifetime and never falls back to the pid", async () => {
	const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	const pid = child.pid!;
	const identity = getProcessStartId(pid);
	expect(identity).toMatch(/^(?:proc|ps|win):\S/);
	expect(getProcessStartId(pid)).toBe(identity);
	child.stdin!.end();
	await once(child, "exit");
	expect([getProcessStartId(0), getProcessStartId(-1), getProcessStartId(1.5)]).toEqual([
		undefined,
		undefined,
		undefined,
	]);
});

it("pins the portable queries to a stable rendering and refuses unusable answers", () => {
	const calls: Array<[string, string[], NodeJS.ProcessEnv | undefined]> = [];
	const answer = (text: string) => (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
		calls.push([command, args, options?.env]);
		return text;
	};
	expect(getPsProcessStartId(42, answer(" Wed Oct  1 08:00:00 2026\n"))).toBe("ps:Wed Oct  1 08:00:00 2026");
	expect(calls[0]![0]).toBe("ps");
	expect(calls[0]![1]).toEqual(["-p", "42", "-o", "lstart="]);
	expect(calls[0]![2]).toMatchObject({ LC_ALL: "C", LC_TIME: "C", LANG: "C", TZ: "UTC" });
	expect([getPsProcessStartId(42, answer("  \n")), getPsProcessStartId(0, answer("x"))]).toEqual([
		undefined,
		undefined,
	]);
	expect([
		getWindowsProcessStartId(42, answer("638950000000000000\r\n")),
		getWindowsProcessStartId(42, answer("not ticks")),
		getWindowsProcessStartId(42, () => {
			throw new Error("powershell missing");
		}),
	]).toEqual(["win:638950000000000000", undefined, undefined]);
});
