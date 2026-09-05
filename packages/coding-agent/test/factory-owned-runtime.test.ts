import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { shouldStartDaemonEarly } from "../src/cli/daemon-launch.js";
import {
	classifyOwnedSessionWorkerInvocation,
	createOwnedWorkerLaunchSpec,
	isOwnedSessionWorkerProcess,
} from "../src/cli/owned-session-worker.js";
import { factoryOwnedEnvironment } from "../src/factory/runtime.js";
import { shouldUseDaemonClientRuntime } from "../src/main.js";

const roots: string[] = [];
afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("factory native owned frontend routing", () => {
	test("automatically clears only inherited worker authority and selects the real owned profile", () => {
		const parent = {
			PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
			PRIME_AGENT_INTERNAL_OWNED_WORKER: "1",
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD: "9",
			PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "0",
			PRIME_FACTORY_ATTEMPT_ID: "attempt",
			PATH: "/preserved",
		};
		const copy = { ...parent };
		const environment = { ...parent, ...factoryOwnedEnvironment() };
		expect(parent).toEqual(copy);
		expect(environment.PATH).toBe("/preserved");
		expect(environment.PRIME_FACTORY_ATTEMPT_ID).toBe("attempt");
		for (const [name, value] of Object.entries(factoryOwnedEnvironment()))
			expect(value).toBe(name === "PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND" ? "1" : "");
		expect(isOwnedSessionWorkerProcess(environment)).toBe(false);
		const argv = ["--print", "--mode", "json", "--offline", "--no-tools", "fixture"];
		expect(classifyOwnedSessionWorkerInvocation(argv, false, environment)).toBe("json");
		expect(
			classifyOwnedSessionWorkerInvocation(["factory", "status", "/fixture"], false, environment),
		).toBeUndefined();
		expect(shouldStartDaemonEarly(["factory", "status", "/fixture"], false)).toBe(false);
		const childEnvironment = { ...environment, PRIME_AGENT_INTERNAL_OWNED_WORKER: "1" };
		expect(classifyOwnedSessionWorkerInvocation(argv, false, childEnvironment)).toBeUndefined();
		expect(
			shouldUseDaemonClientRuntime({
				appMode: "json",
				startupBenchmark: false,
				ownedSessionWorker: isOwnedSessionWorkerProcess(childEnvironment),
			}),
		).toBe(false);
		expect(createOwnedWorkerLaunchSpec(argv, "/exact/node", [], "/exact/cli.js")).toEqual({
			command: "/exact/node",
			args: ["/exact/cli.js", ...argv],
		});
	});
	test("real cli-main takes native same-runtime IPC-owned frontend before daemon startup", async () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-owned-cli-"));
		roots.push(directory);
		const fixture = join(directory, "owned-cli-fixture.mts");
		const reached = join(directory, "worker.json");
		const cliMain = resolve("src/cli-main.ts");
		const ownedWorker = resolve("src/cli/owned-session-worker.ts");
		// Provider work is replaced only after the actual frontend has created its native same-entry IPC worker.
		writeFileSync(
			fixture,
			`import {writeFileSync} from 'node:fs'; import {runCli} from ${JSON.stringify(cliMain)}; import {isOwnedSessionWorkerProcess,installOwnedSessionWorkerOwnerWatch,closeOwnedSessionWorkerOwnerWatch} from ${JSON.stringify(ownedWorker)}; if(isOwnedSessionWorkerProcess()){ installOwnedSessionWorkerOwnerWatch(); const result={pid:process.pid,ppid:process.ppid,execPath:process.execPath,entry:process.argv[1],profile:process.env.PRIME_AGENT_INTERNAL_OWNED_PROFILE,owned:process.env.PRIME_AGENT_INTERNAL_OWNED_WORKER,daemon:process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER,catalog:process.env.PRIME_AGENT_INTERNAL_DAEMON_CATALOG,attempt:process.env.PRIME_FACTORY_ATTEMPT_ID,ipc:process.connected,lease:process.env.PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID}; writeFileSync(${JSON.stringify(reached)},JSON.stringify(result)); process.stdout.write(JSON.stringify(result)); closeOwnedSessionWorkerOwnerWatch(); }else{await runCli();}`,
		);
		const child = spawn(
			process.execPath,
			[
				"--import",
				resolve("../../node_modules/tsx/dist/loader.mjs"),
				fixture,
				"--print",
				"--mode",
				"json",
				"--offline",
				"--no-tools",
				"fixture",
			],
			{
				env: {
					...process.env,
					PRIME_AGENT_CODING_AGENT_DIR: join(directory, "isolated-agent"),
					PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
					PRIME_AGENT_INTERNAL_OWNED_WORKER: "1",
					PRIME_AGENT_INTERNAL_DAEMON_CATALOG: "1",
					PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD: "987",
					PRIME_FACTORY_ATTEMPT_ID: "fixture-attempt",
					...factoryOwnedEnvironment(),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "",
			stderr = "";
		child.stdout.on("data", (bytes: Buffer) => {
			stdout += bytes.toString();
		});
		child.stderr.on("data", (bytes: Buffer) => {
			stderr += bytes.toString();
		});
		const exit = await new Promise<number | null>((done, fail) => {
			const timeout = setTimeout(() => {
				child.kill("SIGTERM");
				fail(new Error("Owned frontend did not finish"));
			}, 10000);
			child.once("error", (error) => {
				clearTimeout(timeout);
				fail(error);
			});
			child.once("close", (code) => {
				clearTimeout(timeout);
				done(code);
			});
		});
		expect(exit, stderr).toBe(0);
		expect(existsSync(reached)).toBe(true);
		const result = JSON.parse(readFileSync(reached, "utf8")) as {
			pid: number;
			ppid: number;
			execPath: string;
			entry: string;
			profile: string;
			owned: string;
			daemon: string;
			catalog: string;
			attempt: string;
			ipc: boolean;
			lease: string;
		};
		expect(result).toMatchObject({
			execPath: process.execPath,
			entry: fixture,
			ppid: child.pid,
			profile: "json",
			owned: "1",
			daemon: "",
			catalog: "",
			attempt: "fixture-attempt",
			ipc: true,
		});
		expect(result.pid).not.toBe(child.pid);
		expect(result.lease).toMatch(/^owned-/);
		expect(JSON.parse(stdout)).toEqual(result);
		// The main daemon/client path is not reached: no agent config, catalog or shared session is created.
		expect(existsSync(join(directory, "isolated-agent"))).toBe(false);
	}, 15000);
});
