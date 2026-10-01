import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, inject, it } from "vitest";
import { AGENT_BINARY_ENV } from "../src/agent-command.js";
import { FactoryEngine } from "../src/engine.js";
import { getProcessStartId } from "../src/process-identity.js";
import { recordServe, serveRunning } from "../src/serve-record.js";
import { FactoryStore } from "../src/store.js";
import type { AttemptContext, Inspection } from "../src/types.js";
import {
	factoryWatchdog,
	reduceSignals,
	runFactoryWatchdogCli,
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


it("sees a serve only while a recorded process lives and runs this entry, and refuses a blank disk threshold", async () => {
	const factory = mkdtempSync(join(tmpdir(), "factory-serve-"));
	roots.push(factory);
	const entry = "/opt/prime-agent-factory/dist/cli-entry.js";
	const recordOf = (pid: number) => join(factory, "serve", `${pid}.json`);
	const write = (pid: number, startId: string) => {
		mkdirSync(join(factory, "serve"), { recursive: true });
		writeFileSync(recordOf(pid), JSON.stringify({ version: 1, pid, startId, entry }));
	};
	const startId = getProcessStartId(process.pid)!;
	// Nothing recorded, then this live process recorded as a serve of this entry, then forgotten again.
	const before = serveRunning(factory, entry);
	const forget = recordServe(factory, entry);
	const recorded = [serveRunning(factory, entry), serveRunning(factory, "/elsewhere/dist/cli-entry.js")];
	forget();
	expect([before, ...recorded, serveRunning(factory, entry), existsSync(recordOf(process.pid))]).toEqual([
		false,
		true,
		false,
		false,
		false,
	]);
	// Records outliving their process: the pid now names another process start, or no process at all.
	const exited = spawnSync(process.execPath, ["-e", ""]).pid;
	write(process.pid, `${startId}0`);
	write(exited, startId);
	expect(serveRunning(factory, entry)).toBe(false);
	// Another scheduler of the same factory starting and stopping leaves a live one's record alone; stale ones go.
	const other = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	try {
		write(other.pid!, getProcessStartId(other.pid!)!);
		recordServe(factory, entry)();
		expect([serveRunning(factory, entry), existsSync(recordOf(exited))]).toEqual([true, false]);
	} finally {
		other.stdin!.end();
		await once(other, "exit");
	}
	expect(serveRunning(factory, entry)).toBe(false);
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

/** Reject action `id` of ticket T in the factory's store, through an adapter whose every attempt exits 1. */
async function reject(factory: string, id: string): Promise<void> {
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
		const action = {
			id,
			ticketId: "T",
			dependencies: [],
			sourceFingerprint: `opaque:${id}`,
			command: { argv: ["false"], cwd: factory },
			requirements: {},
		};
		const ticket = { id: "T", owner: "owner" };
		engine.applyPlan(
			{ version: 1, tickets: [ticket], slots: [{ id: "slot", host: "local" }], actions: [action] },
			store.planRevision(),
		);
		await engine.tick();
		expect(store.actions().find((candidate) => candidate.id === id)?.state).toBe("REJECTED");
	} finally {
		store.close();
	}
}
type Launcher = { host: "local" | "remote"; agent: string };
/** What a launch on that configured host with that agent path leaves in config.json, replaced whole. */
function recordLaunch(root: string, launcher?: Launcher): void {
	const path = join(root, "factory", "config.json");
	const hosts = {
		local: { type: "local", runnerRoot: join(root, "attempts") },
		remote: { type: "ssh", sshHost: "factory-host", runnerRoot: "/attempts" },
	};
	const recorded = launcher && {
		host: launcher.host,
		repo: join(root, "repo"),
		work: join(root, "work"),
		primeAgentBin: launcher.agent,
	};
	writeFileSync(`${path}.tmp`, JSON.stringify({ version: 1, hosts, ...(recorded ? { launcher: recorded } : {}) }));
	renameSync(`${path}.tmp`, path);
}
/** A REJECTED action `a` in a real factory directory, and a watchdog state past its silent baseline. */
async function rejectedFactory(root: string, launcher?: Launcher): Promise<string> {
	const factory = join(root, "factory");
	mkdirSync(factory);
	mkdirSync(join(root, "work"));
	recordLaunch(root, launcher);
	await reject(factory, "a");
	mkdirSync(join(factory, "watchdog"));
	writeFileSync(
		join(factory, "watchdog", "state.json"),
		JSON.stringify({ version: 1, session: "owner", factory, sequence: 0, initialized: true }),
	);
	return factory;
}
/** An agent binary that records each call and acknowledges every send as queued. */
function recordingAgent(root: string, name: string): { binary: string; sends: () => string[][] } {
	const binary = join(root, name);
	const calls = join(root, `${name}-calls.jsonl`);
	writeFileSync(
		binary,
		`#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(JSON.stringify({ deliveryStatus: "queued" }));\n`,
		{ mode: 0o755 },
	);
	const sends = () =>
		existsSync(calls)
			? readFileSync(calls, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as string[])
			: [];
	return { binary, sends };
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
		const { binary: agent, sends } = recordingAgent(root, "agent");
		const factory = await rejectedFactory(
			root,
			selection === "local"
				? { host: "local", agent }
				: selection === "remote"
					? { host: "remote", agent: "/remote/only/prime-agent" }
					: undefined,
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
			// status and events went to the factory entry; the agent saw exactly one send for the new rejection.
			const [send, ...rest] = sends();
			expect([send!.slice(0, 4), rest]).toEqual([["send", "--json", "owner", "--message"], []]);
			const key = send![4]!.match(/^\[FACTORY_EXCEPTION (action:a:[^\]]+)\] a: REJECTED;/)?.[1];
			const delivered = JSON.parse(readFileSync(join(factory, "watchdog", "deliveries.jsonl"), "utf8"));
			expect([delivered.key, delivered.receipt]).toEqual([key, { deliveryStatus: "queued" }]);
		} finally {
			watchdog.kill("SIGTERM");
			await once(watchdog, "exit");
		}
	},
);

it("re-reads the agent binary a relaunch recorded on every pass, and refuses an SSH factory without a local route", async () => {
	const root = mkdtempSync(join(tmpdir(), "factory-watchdog-"));
	roots.push(root);
	const [first, second] = [recordingAgent(root, "agent-a"), recordingAgent(root, "agent-b")];
	const factory = await rejectedFactory(root, { host: "local", agent: first.binary });
	const env = { ...process.env, [AGENT_BINARY_ENV]: "" };
	const factoryArgv = [process.execPath, join(inject("factoryDist"), "cli-entry.js")];
	const watchdog = factoryWatchdog({ factory, session: "owner", factoryArgv, env });
	await watchdog.pass();
	// A relaunch switches the binary while the watchdog runs; the next exception goes through the new one.
	recordLaunch(root, { host: "local", agent: second.binary });
	await reject(factory, "b");
	await watchdog.pass();
	const key = (send: string[]) => send[4]?.match(/^\[FACTORY_EXCEPTION (action:[ab]):/)?.[1];
	expect([first.sends().map(key), second.sends().map(key)]).toEqual([["action:a"], ["action:b"]]);
	// The recorded path of an SSH launcher names a binary over there: no local agent stands in for it.
	recordLaunch(root, { host: "remote", agent: second.binary });
	expect(() => factoryWatchdog({ factory, session: "owner", factoryArgv, env })).toThrow(
		`the factory's agent binary ${second.binary} is on SSH host remote; pass --agent-bin or set ${AGENT_BINARY_ENV}`,
	);
	const explicit = { ...env, [AGENT_BINARY_ENV]: first.binary };
	expect(() => factoryWatchdog({ factory, session: "owner", factoryArgv, env: explicit })).not.toThrow();
});
