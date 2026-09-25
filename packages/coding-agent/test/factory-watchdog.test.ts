import { expect, it } from "vitest";
import {
	reduceSignals,
	runFactoryWatchdogCli,
	servesFactory,
	type WatchdogSnapshot,
	type WatchdogState,
} from "../src/factory/watchdog.js";

type Actions = WatchdogSnapshot["status"]["actions"];
type Attempts = WatchdogSnapshot["status"]["attempts"];
const snapshot = (
	actions: Array<[string, string]>,
	attempts: Array<[string, string]>,
	freeGiB = 50,
	lost: string[] = [],
) =>
	({
		status: {
			actions: actions.map(([id, state]) => ({ id, ticketId: `T-${id}`, state })) as unknown as Actions,
			attempts: attempts.map(([id, state]) => ({ id, actionId: "a", state })) as unknown as Attempts,
			tickets: [],
		},
		sequence: 100,
		lost,
		failures: {},
		serve: true,
		freeGiB,
		at: "fixture",
	}) satisfies WatchdogSnapshot;

it("alerts once per new exception, baselines known ones, confirms a lost runner twice and rearms the disk floor", () => {
	const state: WatchdogState = { version: 1, session: "s", factory: "/f", sequence: 0 };
	const options = { diskLowGiB: 30 };
	const known = snapshot([["a", "REJECTED"]], [["attempt-1", "TERMINAL"]]);
	expect(reduceSignals(state, known, { ...options, baseline: true })).toHaveLength(0);
	expect(reduceSignals(structuredClone(state), known, options)).toHaveLength(0);
	const fresh = snapshot(
		[
			["a", "REJECTED"],
			["b", "REJECTED"],
		],
		[["attempt-1", "TERMINAL"]],
	);
	expect(reduceSignals(state, fresh, options).map((alert) => alert.key)).toEqual(["action:b:none"]);
	expect(reduceSignals(state, fresh, options)).toHaveLength(0);
	const disk = (freeGiB: number) => reduceSignals(state, snapshot([], [], freeGiB), options).length;
	expect([disk(29), disk(35), disk(29), disk(41), disk(29)]).toEqual([1, 0, 0, 0, 1]);
	// A provider failure, then a lost runner, then a rejection of the same attempt: each alerts once.
	const failing = {
		...snapshot([["a", "RUNNING"]], [["attempt-2", "RUNNING"]]),
		failures: { "T-a": "user_prompt_too_long" },
	};
	expect(reduceSignals(state, failing, options).map((alert) => alert.key)).toEqual([
		"provider:a:attempt-2:user_prompt_too_long",
	]);
	const lost = {
		...snapshot([["a", "RUNNING"]], [["attempt-2", "RUNNING"]], 50, ["attempt-2"]),
		failures: failing.failures,
	};
	expect([lost, lost, lost].map((next) => reduceSignals(state, next, options).length)).toEqual([0, 1, 0]);
	const rejected = snapshot([["a", "REJECTED"]], [["attempt-2", "TERMINAL"]]);
	expect(reduceSignals(state, rejected, options).map((alert) => alert.key)).toEqual(["action:a:attempt-2"]);
	const serveGone = { ...snapshot([], []), serve: false };
	expect(reduceSignals(state, serveGone, options).map((alert) => alert.key)).toEqual(["serve-lost:0"]);
	expect(state.outbox?.map((alert) => alert.key)).toEqual([
		"action:b:none",
		"disk-low:1",
		"disk-low:2",
		"provider:a:attempt-2:user_prompt_too_long",
		"lost:a:attempt-2",
		"action:a:attempt-2",
		"serve-lost:0",
	]);
});

it("finds a serve started with a relative directory and refuses a blank disk threshold", async () => {
	const cwd = () => "/work";
	expect(servesFactory(["node", "cli.js", "factory", "serve", "factory"], cwd, "/work/factory")).toBe(true);
	expect(servesFactory(["node", "cli.js", "factory", "serve", "."], () => "/work/factory", "/work/factory")).toBe(
		true,
	);
	expect(servesFactory(["node", "cli.js", "factory", "serve", "/work/factory"], cwd, "/work/factory")).toBe(true);
	expect(servesFactory(["node", "cli.js", "factory", "serve", "other"], cwd, "/work/factory")).toBe(false);
	expect(servesFactory(["node", "cli.js", "factory", "serve"], () => "/work/factory", "/work/factory")).toBe(false);
	const usage = console.error;
	console.error = () => undefined;
	try {
		for (const threshold of [" ", "", "Infinity", "-1"])
			expect(
				await runFactoryWatchdogCli(["--factory", "/work/factory", "--session", "s", "--disk-low-gib", threshold]),
			).toBe(2);
	} finally {
		console.error = usage;
	}
});
