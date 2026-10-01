import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, inject, it } from "vitest";
import { AGENT_BINARY_ENV } from "../src/agent-command.js";
import { FactoryEngine } from "../src/engine.js";
import { FactoryStore } from "../src/store.js";
import type { AttemptContext, Inspection } from "../src/types.js";
import {
	reduceSignals,
	runFactoryWatchdogCli,
	servesFactory,
	type WatchdogSnapshot,
	type WatchdogState,
} from "../src/watchdog.js";
import { fileReady, holdsLine } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

it("finds this package's serve by its exact entry and directory, and refuses a blank disk threshold", async () => {
	const root = mkdtempSync(join(tmpdir(), "factory-serve-"));
	roots.push(root);
	const entry = join(root, "dist", "cli-entry.js");
	mkdirSync(join(root, "dist"));
	mkdirSync(join(root, "bin"));
	writeFileSync(entry, "");
	writeFileSync(join(root, "other.js"), "");
	symlinkSync(entry, join(root, "bin", "prime-agent-factory"));
	const factory = join(root, "factory");
	const at = (cwd: string) => () => cwd;
	const serves = (argv: string[], cwd = root) => servesFactory(argv, at(cwd), factory, realpathSync(entry));
	expect([
		serves(["node", entry, "serve", "factory"]),
		serves(["node", join(root, "bin", "prime-agent-factory"), "serve", "."], factory),
		serves(["node", "dist/cli-entry.js", "serve", factory]),
		serves(["node", "--import", "loader.mjs", entry, "serve", factory, "--interval-ms", "50"]),
		serves(["node", entry, "serve", "other"]),
		serves(["node", entry, "serve"], factory),
		serves(["node", entry, "status", factory]),
		serves(["node", join(root, "other.js"), "serve", factory]),
		// The old in-binary form names no entry of this package.
		serves(["node", "cli.js", "factory", "serve", factory]),
	]).toEqual([true, true, true, true, false, false, false, false, false]);
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

/**
 * A REJECTED action in a real factory directory, and a watchdog state past its silent baseline. `launcher` records
 * a launch on that configured host with that agent path.
 */
async function rejectedFactory(root: string, launcher?: { host: "local" | "remote"; agent: string }): Promise<string> {
	const factory = join(root, "factory");
	mkdirSync(factory);
	mkdirSync(join(root, "work"));
	writeFileSync(
		join(factory, "config.json"),
		JSON.stringify({
			version: 1,
			hosts: {
				local: { type: "local", runnerRoot: join(root, "attempts") },
				remote: { type: "ssh", sshHost: "factory-host", runnerRoot: "/attempts" },
			},
			...(launcher
				? {
						launcher: {
							host: launcher.host,
							repo: join(root, "repo"),
							work: join(root, "work"),
							primeAgentBin: launcher.agent,
						},
					}
				: {}),
		}),
	);
	const store = new FactoryStore(join(factory, "factory.db"));
	try {
		const failed = async (context: AttemptContext): Promise<Inspection> => ({
			kind: "terminal",
			receipt: {
				attemptId: context.attempt.id,
				sourceFingerprint: context.action.sourceFingerprint,
				exitCode: 1,
				finishedAt: new Date().toISOString(),
			},
		});
		const engine = new FactoryEngine(store, { launch: failed, inspect: failed }, { enabled: true });
		engine.applyPlan({
			version: 1,
			tickets: [{ id: "T", owner: "owner" }],
			slots: [{ id: "slot", host: "local" }],
			actions: [
				{
					id: "a",
					ticketId: "T",
					dependencies: [],
					sourceFingerprint: "opaque:a",
					command: { argv: ["false"], cwd: root },
					requirements: {},
				},
			],
		});
		await engine.tick();
		expect(store.actions().map((action) => action.state)).toEqual(["REJECTED"]);
	} finally {
		store.close();
	}
	mkdirSync(join(factory, "watchdog"));
	writeFileSync(
		join(factory, "watchdog", "state.json"),
		JSON.stringify({ version: 1, session: "owner", factory, sequence: 0, initialized: true }),
	);
	return factory;
}

it.each([
	["--agent-bin", "flag"],
	[AGENT_BINARY_ENV, "environment"],
	["the recorded launcher.primeAgentBin of a local host", "local"],
	["the environment, not an SSH host's recorded path", "remote"],
] as const)(
	"reads the factory through its own entry and delivers through the agent binary named by %s",
	async (_name, selection) => {
		const root = mkdtempSync(join(tmpdir(), "factory-watchdog-"));
		roots.push(root);
		const agent = join(root, "agent");
		const factory = await rejectedFactory(
			root,
			selection === "local"
				? { host: "local", agent }
				: selection === "remote"
					? { host: "remote", agent: "/remote/only/prime-agent" }
					: undefined,
		);
		const calls = join(root, "agent-calls.jsonl");
		writeFileSync(
			agent,
			`#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(JSON.stringify({ deliveryStatus: "queued" }));\n`,
			{ mode: 0o755 },
		);
		const watchdog = spawn(
			process.execPath,
			[
				join(inject("factoryDist"), "watchdog.js"),
				"--factory",
				factory,
				"--session",
				"owner",
				...(selection === "flag" ? ["--agent-bin", agent] : []),
			],
			{
				env: {
					...process.env,
					[AGENT_BINARY_ENV]: selection === "environment" || selection === "remote" ? agent : "",
				},
				stdio: "ignore",
			},
		);
		try {
			await fileReady(join(factory, "watchdog", "deliveries.jsonl"), holdsLine);
			const sends = readFileSync(calls, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			// status and events went to the factory entry; the agent saw exactly one send for the new rejection.
			expect(sends).toHaveLength(1);
			expect(sends[0]!.slice(0, 4)).toEqual(["send", "--json", "owner", "--message"]);
			const key = sends[0]![4]!.match(/^\[FACTORY_EXCEPTION (action:a:[^\]]+)\] a: REJECTED;/)?.[1];
			const delivered = JSON.parse(readFileSync(join(factory, "watchdog", "deliveries.jsonl"), "utf8"));
			expect([delivered.key, delivered.receipt]).toEqual([key, { deliveryStatus: "queued" }]);
		} finally {
			watchdog.kill("SIGTERM");
			await once(watchdog, "exit");
		}
	},
);
