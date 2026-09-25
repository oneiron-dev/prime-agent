import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { factoryArguments, supportsFactoryRuntime } from "../src/cli/factory-launch.js";
import { tickWithBusyRetry } from "../src/factory/cli.js";
import { FactoryStore } from "../src/factory/store.js";
import type { FactoryPlan, FactoryStatus } from "../src/factory/types.js";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeArgs = ["--import", require.resolve("tsx")];
const cli = join(packageRoot, "src", "cli.ts");
const factoryEntry = join(packageRoot, "src", "factory", "cli-entry.ts");
const roots: string[] = [];
function invoke(args: string[], root?: string): string {
	return execFileSync(process.execPath, [...nodeArgs, cli, "factory", ...args], {
		cwd: packageRoot,
		encoding: "utf8",
		env: { ...process.env, ...(root ? { HOME: root } : {}) },
		stdio: ["ignore", "pipe", "pipe"],
	});
}
function setup() {
	const root = mkdtempSync(join(tmpdir(), "prime-factory-cli-"));
	roots.push(root);
	const directory = join(root, "factory");
	const runnerRoot = join(root, "attempts");
	const marker = join(root, "marker");
	const plan: FactoryPlan = {
		version: 1,
		tickets: [{ id: "ticket", owner: "launcher" }],
		slots: [{ id: "local-slot", host: "local" }],
		actions: [
			{
				id: "a",
				ticketId: "ticket",
				dependencies: [],
				sourceFingerprint: "opaque:fixture",
				command: {
					argv: [
						process.execPath,
						"-e",
						`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => {}, 700)`,
					],
					cwd: root,
				},
				requirements: {},
			},
		],
		roles: { writer: { provider: "cpa-r", model: "gpt-6-astra", effort: "xhigh" } },
	};
	const planPath = join(root, "plan.json");
	const hostsPath = join(root, "hosts.json");
	writeFileSync(planPath, JSON.stringify(plan));
	writeFileSync(hostsPath, JSON.stringify({ local: { type: "local", runnerRoot } }));
	return { root, directory, runnerRoot, marker, planPath, hostsPath };
}
function unpauseFixture(directory: string): void {
	const store = new FactoryStore(join(directory, "factory.db"));
	try {
		store.resume();
	} finally {
		store.close();
	}
}
async function waitUntil(test: () => boolean) {
	const deadline = Date.now() + 6000;
	while (Date.now() < deadline) {
		if (test()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	throw new Error("Condition did not become true");
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("optional factory CLI", () => {
	it("keeps help independent of SQLite, sessions and daemon startup", () => {
		const { root } = setup();
		const help = invoke(["help"], root);
		expect(help).toContain("Factory mode is optional");
		expect(help).toContain("The factory is a DAG launcher");
		expect(help).toContain("A changed installed runtime is journaled at resume and never refused");
		expect(help).not.toContain("decide");
		expect(existsSync(join(root, ".prime"))).toBe(false);
		expect(factoryArguments(["factory", "status", "/tmp/test"])).toEqual(["status", "/tmp/test"]);
		expect(factoryArguments(["help", "factory"])).toEqual(["help"]);
		expect(factoryArguments(["-p", "factory"])).toBeUndefined();
		expect(supportsFactoryRuntime({ node: "22.8.0" })).toBe(false);
		expect(supportsFactoryRuntime({ node: "22.13.0" })).toBe(true);
		expect(supportsFactoryRuntime({ node: "26.2.0" })).toBe(true);
		expect(supportsFactoryRuntime({ node: "24.0.0", bun: "1.2.0" })).toBe(false);
	});

	it("requires explicit revision for imports and replays an import token without another revision", () => {
		const { directory, planPath, hostsPath } = setup();
		invoke(["init", directory, planPath, "--hosts", hostsPath]);
		unpauseFixture(directory);
		expect(() => invoke(["import", directory, planPath])).toThrow();
		expect(JSON.parse(invoke(["import", directory, planPath, "--expected-revision", "1"])).planRevision).toBe(1);
		const plan = JSON.parse(readFileSync(planPath, "utf8")) as FactoryPlan;
		plan.tickets[0].owner = "coordinator";
		writeFileSync(planPath, JSON.stringify(plan));
		const command = ["import", directory, planPath, "--expected-revision", "1", "--mutation-id", "outbox-1"];
		expect(JSON.parse(invoke(command)).planRevision).toBe(2);
		expect(JSON.parse(invoke(command)).planRevision).toBe(2);
		expect(() => invoke(["import", directory, planPath, "--expected-revision", "1"])).toThrow();
	});

	it("starts paused and reconciles a detached job after the scheduling process is killed", async () => {
		const { root, directory, runnerRoot, marker, planPath, hostsPath } = setup();
		const initialized = JSON.parse(
			invoke(["init", directory, planPath, "--hosts", hostsPath], root),
		) as FactoryStatus;
		expect(initialized.paused).toBe(true);
		expect(JSON.parse(invoke(["tick", directory])).launched).toEqual([]);
		expect(existsSync(runnerRoot)).toBe(false);
		expect(invoke(["resume", directory])).toContain("TICKET\tACCEPTED");
		const server = spawn(process.execPath, [...nodeArgs, factoryEntry, "serve", directory, "--interval-ms", "50"], {
			cwd: packageRoot,
			stdio: "ignore",
		});
		try {
			await waitUntil(() => existsSync(marker));
			server.kill("SIGKILL");
			await new Promise<void>((resolveExit) => server.once("exit", () => resolveExit()));
			const state = JSON.parse(invoke(["status", directory])) as FactoryStatus;
			const attempt = state.attempts[0]!;
			await waitUntil(() => existsSync(join(runnerRoot, attempt.id, "terminal.json")));
			invoke(["tick", directory]);
			const recovered = JSON.parse(invoke(["status", directory])) as FactoryStatus;
			expect(recovered.actions[0]?.state).toBe("ACCEPTED");
			expect(recovered.attempts[0]?.receipt?.exitCode).toBe(0);
			expect(readFileSync(marker, "utf8")).toBe("x");
			expect(recovered.roles?.writer?.effort).toBe("xhigh");
		} finally {
			server.kill("SIGKILL");
		}
	}, 15_000);

	it("keeps serve alive through a SQLite write lock and reconciles after the lock clears", async () => {
		const { root, directory, runnerRoot, marker, planPath, hostsPath } = setup();
		const plan = JSON.parse(readFileSync(planPath, "utf8")) as FactoryPlan;
		plan.actions[0]!.command.argv = [
			process.execPath,
			"-e",
			`const fs=require('node:fs'); process.on('SIGUSR1',()=>process.exit(0)); fs.watch(${JSON.stringify(root)},()=>{}); fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
		];
		writeFileSync(planPath, JSON.stringify(plan));
		invoke(["init", directory, planPath, "--hosts", hostsPath]);
		unpauseFixture(directory);
		const server = spawn(process.execPath, [...nodeArgs, factoryEntry, "serve", directory, "--interval-ms", "50"], {
			cwd: packageRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let holder: ReturnType<typeof spawn> | undefined;
		const watchers: ReturnType<typeof watch>[] = [];
		const fileReady = (path: string) =>
			new Promise<void>((resolveReady) => {
				if (existsSync(path)) return resolveReady();
				const watcher = watch(dirname(path), () => {
					if (existsSync(path)) {
						watcher.close();
						resolveReady();
					}
				});
				watchers.push(watcher);
			});
		let launched!: (attemptId: string) => void;
		let busy!: () => void;
		let recovered!: () => void;
		const launchedEvent = new Promise<string>((resolveEvent) => {
			launched = resolveEvent;
		});
		const busyEvent = new Promise<void>((resolveEvent) => {
			busy = resolveEvent;
		});
		const recoveredEvent = new Promise<void>((resolveEvent) => {
			recovered = resolveEvent;
		});
		let sawBusy = false;
		const lines = createInterface({ input: server.stdout! });
		lines.on("line", (line) => {
			const event = JSON.parse(line) as { error?: string; launched?: string[]; reconciled?: string[] };
			if (event.launched?.length) launched(event.launched[0]!);
			if (event.error === "SQLITE_BUSY") {
				sawBusy = true;
				busy();
			}
			if (sawBusy && event.reconciled?.length) recovered();
		});
		try {
			const markerReady = fileReady(marker);
			const attemptId = await launchedEvent;
			await markerReady;
			const terminalReady = fileReady(join(runnerRoot, attemptId, "terminal.json"));
			const script = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(${JSON.stringify(join(directory, "factory.db"))}); db.exec('BEGIN IMMEDIATE'); console.log('LOCKED'); process.stdin.once('data',()=>{ db.exec('ROLLBACK'); db.close(); });`;
			holder = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
			expect(String((await once(holder.stdout!, "data"))[0])).toContain("LOCKED");
			process.kill(Number(readFileSync(marker, "utf8")), "SIGUSR1");
			await terminalReady;
			await Promise.race([
				busyEvent,
				once(server, "exit").then(() => {
					throw new Error("serve exited during SQLite lock");
				}),
			]);
			expect(server.exitCode).toBeNull();
			holder.kill("SIGTERM");
			await once(holder, "exit");
			await recoveredEvent;
			expect((JSON.parse(invoke(["status", directory])) as FactoryStatus).actions[0]?.state).toBe("ACCEPTED");
			expect(readFileSync(marker, "utf8")).toMatch(/^\d+$/);
		} finally {
			for (const watcher of watchers) watcher.close();
			lines.close();
			if (holder?.exitCode === null) holder.kill("SIGKILL");
			if (server.exitCode === null) server.kill("SIGKILL");
		}
		// test-policy: allow explicit-test-timeout -- A real SQLite five-second busy timeout needs a failure bound; process events signal readiness.
	}, 20_000);

	it.each([11, 1])("does not retry native SQLite errcode %i", async (errcode) => {
		const root = mkdtempSync(join(tmpdir(), "prime-factory-corrupt-"));
		roots.push(root);
		const path = join(root, "query.db");
		let db = new DatabaseSync(path);
		try {
			if (errcode === 11) {
				db.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1)");
				const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
				const rootPage = Number(db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='t'").get()?.rootpage);
				db.close();
				const bytes = readFileSync(path);
				bytes[pageSize * (rootPage - 1)] = 0xff;
				writeFileSync(path, bytes);
				db = new DatabaseSync(path);
			}
			let calls = 0;
			await expect(
				tickWithBusyRetry({
					tick: async (): Promise<never> => {
						calls++;
						db.exec(errcode === 11 ? "SELECT * FROM t" : "SELECT * FROM absent");
						throw new Error("SQLite query unexpectedly succeeded");
					},
				}),
			).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR", errcode });
			expect(calls).toBe(1);
		} finally {
			db.close();
		}
	});

	it("retries a native SQLITE_BUSY only within the bounded budget", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-factory-busy-"));
		roots.push(root);
		const path = join(root, "lock.db");
		const holder = new DatabaseSync(path);
		holder.exec("CREATE TABLE t (x); BEGIN IMMEDIATE");
		const contender = new DatabaseSync(path);
		contender.exec("PRAGMA busy_timeout=0");
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.useFakeTimers();
		try {
			let calls = 0;
			const pending = tickWithBusyRetry({
				tick: async (): Promise<never> => {
					calls++;
					contender.exec("INSERT INTO t VALUES (1)");
					throw new Error("SQLite insert unexpectedly succeeded");
				},
			});
			await vi.runAllTimersAsync();
			expect(await pending).toBeUndefined();
			expect(calls).toBe(4);
			expect(output.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
				{ error: "SQLITE_BUSY", retriesRemaining: 3 },
				{ error: "SQLITE_BUSY", retriesRemaining: 2 },
				{ error: "SQLITE_BUSY", retriesRemaining: 1 },
				{ error: "SQLITE_BUSY", retriesRemaining: 0 },
			]);
		} finally {
			vi.useRealTimers();
			output.mockRestore();
			holder.exec("ROLLBACK");
			contender.close();
			holder.close();
		}
	});

	it("pauses scheduling when its launcher disappears", async () => {
		const { directory, marker, planPath, hostsPath } = setup();
		invoke(["init", directory, planPath, "--hosts", hostsPath]);
		unpauseFixture(directory);
		const launcher = spawn(
			process.execPath,
			[...nodeArgs, cli, "factory", "serve", directory, "--interval-ms", "50"],
			{
				cwd: packageRoot,
				stdio: "ignore",
			},
		);
		try {
			await waitUntil(() => existsSync(marker));
			launcher.kill("SIGKILL");
			await new Promise<void>((resolveExit) => launcher.once("exit", () => resolveExit()));
			await waitUntil(() => (JSON.parse(invoke(["status", directory])) as FactoryStatus).paused);
			expect(readFileSync(marker, "utf8")).toBe("x");
			await new Promise((resolveWait) => setTimeout(resolveWait, 800));
		} finally {
			launcher.kill("SIGKILL");
		}
	}, 15_000);

	it("honors an external owner pause even after local resume", () => {
		const { root, directory, marker, planPath, hostsPath } = setup();
		const pauseFile = join(root, "OWNER-TRUST-PAUSE.json");
		invoke(["init", directory, planPath, "--hosts", hostsPath, "--pause-file", pauseFile]);
		unpauseFixture(directory);
		writeFileSync(pauseFile, "{}");
		expect(JSON.parse(invoke(["tick", directory])).paused).toBe(true);
		expect(existsSync(marker)).toBe(false);
		expect(() => invoke(["resume", directory])).toThrow();
		expect(existsSync(pauseFile)).toBe(true);
	});
});
