import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { tickWithBusyRetry } from "../src/cli.js";
import { supportsFactoryRuntime } from "../src/runtime.js";
import { FactoryStore } from "../src/store.js";
import type { FactoryPlan, FactoryStatus } from "../src/types.js";
import { fileReady, gatedJob } from "./helpers.js";

const entry = () => join(inject("factoryDist"), "cli-entry.js");
const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
function invoke(args: string[], root?: string): string {
	return execFileSync(process.execPath, [entry(), ...args], {
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
	const pidFile = join(root, "job.pid");
	const hold = join(root, "hold");
	mkdirSync(hold);
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
				command: { argv: [process.execPath, "-e", gatedJob(marker, pidFile, hold)], cwd: root },
				requirements: {},
			},
		],
		roles: { writer: { provider: "cpa-r", model: "gpt-6-astra", effort: "xhigh" } },
	};
	const planPath = join(root, "plan.json");
	const hostsPath = join(root, "hosts.json");
	writeFileSync(planPath, JSON.stringify(plan));
	writeFileSync(hostsPath, JSON.stringify({ local: { type: "local", runnerRoot } }));
	/** Let the held job finish: it exits 0 once released. */
	const release = () => process.kill(Number(readFileSync(pidFile, "utf8")), "SIGUSR1");
	return { root, directory, runnerRoot, marker, pidFile, planPath, hostsPath, release };
}
function unpauseFixture(directory: string): void {
	const store = new FactoryStore(join(directory, "factory.db"));
	try {
		store.resume();
	} finally {
		store.close();
	}
}
afterEach(() => {
	for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prime-agent-factory CLI", () => {
	it("keeps help independent of SQLite, sessions and daemon startup", () => {
		const { root } = setup();
		const help = invoke(["help"], root);
		expect(help).toContain("Factory mode is optional");
		expect(help).toContain("The factory is a DAG launcher");
		expect(help).toContain("A changed installed runtime is journaled at resume and never refused");
		expect(help).not.toContain("decide");
		expect(invoke([], root)).toBe(help);
		expect(existsSync(join(root, ".prime"))).toBe(false);
		expect([
			supportsFactoryRuntime({ node: "22.8.0" }),
			supportsFactoryRuntime({ node: "22.13.0" }),
			supportsFactoryRuntime({ node: "26.2.0" }),
			supportsFactoryRuntime({ node: "24.0.0", bun: "1.2.0" }),
		]).toEqual([false, true, true, false]);
	});

	it("requires explicit revision for imports and replays an import token without another revision", () => {
		const { directory, planPath, hostsPath } = setup();
		invoke(["init", directory, planPath, "--hosts", hostsPath]);
		unpauseFixture(directory);
		expect(() => invoke(["import", directory, planPath])).toThrow();
		expect(JSON.parse(invoke(["import", directory, planPath, "--expected-revision", "1"])).planRevision).toBe(1);
		const plan = JSON.parse(readFileSync(planPath, "utf8")) as FactoryPlan;
		plan.tickets[0]!.owner = "coordinator";
		writeFileSync(planPath, JSON.stringify(plan));
		const command = ["import", directory, planPath, "--expected-revision", "1", "--mutation-id", "outbox-1"];
		expect(JSON.parse(invoke(command)).planRevision).toBe(2);
		expect(JSON.parse(invoke(command)).planRevision).toBe(2);
		expect(() => invoke(["import", directory, planPath, "--expected-revision", "1"])).toThrow();
		expect(() => invoke(["status", directory, "--prime-agent-bin", "/bin/true"])).toThrow(
			"--prime-agent-bin is only supported for launch",
		);
	});

	it("starts paused and reconciles a detached job after the scheduling process is killed", async () => {
		const f = setup();
		const initialized = JSON.parse(invoke(["init", f.directory, f.planPath, "--hosts", f.hostsPath], f.root));
		expect((initialized as FactoryStatus).paused).toBe(true);
		expect(JSON.parse(invoke(["tick", f.directory])).launched).toEqual([]);
		expect(existsSync(f.runnerRoot)).toBe(false);
		expect(invoke(["resume", f.directory])).toContain("TICKET\tACCEPTED");
		// resume launched the job; serve reconciles it and is then killed while the job still holds.
		await fileReady(f.pidFile);
		const server = spawn(process.execPath, [entry(), "serve", f.directory, "--interval-ms", "50"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		children.push(server);
		const lines = createInterface({ input: server.stdout! });
		const reconciled = new Promise<void>((resolveReconciled) =>
			lines.on("line", (line) => {
				if ((JSON.parse(line) as { reconciled?: string[] }).reconciled?.length) resolveReconciled();
			}),
		);
		await reconciled;
		lines.close();
		server.kill("SIGKILL");
		await once(server, "exit");
		const running = JSON.parse(invoke(["status", f.directory])) as FactoryStatus;
		const attempt = running.attempts[0]!;
		expect([running.paused, attempt.state]).toEqual([false, "RUNNING"]);
		f.release();
		await fileReady(join(f.runnerRoot, attempt.id, "terminal.json"));
		invoke(["tick", f.directory]);
		const recovered = JSON.parse(invoke(["status", f.directory])) as FactoryStatus;
		expect(recovered.actions[0]?.state).toBe("ACCEPTED");
		expect(recovered.attempts[0]?.receipt?.exitCode).toBe(0);
		expect(readFileSync(f.marker, "utf8")).toBe("x");
		expect(recovered.roles?.writer?.effort).toBe("xhigh");
	});

	it("imports a SPLIT follow-up in a running serve with the launcher the latest launch recorded", async () => {
		const f = setup();
		invoke(["init", f.directory, f.planPath, "--hosts", f.hostsPath]);
		// The relaunch also moves the work directory, and the leftover exists only under the new one: this serve can
		// import it only through the launcher the relaunch wrote, never through the one it started with.
		const launcher = (agent: string, work: string) => ({
			host: "local",
			repo: join(f.root, "repo"),
			work: join(f.root, work),
			primeAgentBin: agent,
		});
		const configPath = join(f.directory, "config.json");
		// What `launch` leaves in config.json, replaced whole the way launch replaces it.
		const relaunch = (recorded: ReturnType<typeof launcher>) => {
			const config = { ...JSON.parse(readFileSync(configPath, "utf8")), launcher: recorded };
			writeFileSync(`${configPath}.tmp`, JSON.stringify(config));
			renameSync(`${configPath}.tmp`, configPath);
		};
		relaunch(launcher("/opt/agent-a", "work-a"));
		// The parent's submit and merge wait on the held job, so this serve never starts them.
		const store = new FactoryStore(join(f.directory, "factory.db"));
		try {
			const plan = JSON.parse(readFileSync(f.planPath, "utf8")) as FactoryPlan;
			const parent = (stage: string, dependencies: string[]) => ({
				id: `parent:${stage}`,
				ticketId: "parent",
				dependencies,
				sourceFingerprint: `ticket:parent:${stage}`,
				command: { argv: ["false"], cwd: f.root },
				requirements: {},
			});
			const actions = [...plan.actions, parent("submit", ["a"]), parent("merge", ["parent:submit"])];
			const tickets = [...plan.tickets, { id: "parent", owner: "launcher" }];
			store.applyPlan({ ...plan, tickets, actions }, store.planRevision());
			store.resume();
		} finally {
			store.close();
		}
		const server = spawn(process.execPath, [entry(), "serve", f.directory, "--interval-ms", "50"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		children.push(server);
		const lines = createInterface({ input: server.stdout! });
		const output = (key: "launched" | "splitsImported") =>
			new Promise<string[]>((resolveLine) =>
				lines.on("line", (line) => {
					const value = (JSON.parse(line) as Record<string, string[] | undefined>)[key];
					if (value?.length) resolveLine(value);
				}),
			);
		const [attemptId] = await output("launched");
		try {
			// The writer's leftover, then a relaunch with another agent binary, while this serve runs.
			const relaunched = launcher("/opt/agent-b", "work-b");
			const parentDirectory = join(relaunched.work, "tickets", "parent");
			mkdirSync(parentDirectory, { recursive: true });
			const parentRun = { version: 1, key: "parent", title: "P", contract: "Do p.", acceptance: "p", row: "OF-1" };
			writeFileSync(
				join(parentDirectory, "ticket.json"),
				JSON.stringify({ ...parentRun, blockedBy: [], launcher: relaunched }),
			);
			writeFileSync(join(parentDirectory, "split.json"), JSON.stringify({ key: "parent", remains: "the rest" }));
			const imported = output("splitsImported");
			relaunch(relaunched);
			expect(await imported).toEqual(["parent-split"]);
			const followUp = JSON.parse(readFileSync(join(relaunched.work, "tickets", "parent-split", "ticket.json"), "utf8"));
			expect(followUp.launcher).toEqual(relaunched);
		} finally {
			lines.close();
			server.kill("SIGKILL");
			await once(server, "exit");
			await fileReady(f.pidFile);
			f.release();
			await fileReady(join(f.runnerRoot, attemptId!, "terminal.json"));
		}
	});

	it("keeps serve alive through a SQLite write lock and reconciles after the lock clears", async () => {
		const { directory, runnerRoot, marker, pidFile, planPath, hostsPath, release } = setup();
		invoke(["init", directory, planPath, "--hosts", hostsPath]);
		unpauseFixture(directory);
		const server = spawn(process.execPath, [entry(), "serve", directory, "--interval-ms", "50"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(server);
		let holder: ReturnType<typeof spawn> | undefined;
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
			const attemptId = await launchedEvent;
			await fileReady(pidFile);
			const terminalReady = fileReady(join(runnerRoot, attemptId, "terminal.json"));
			const script = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(${JSON.stringify(join(directory, "factory.db"))}); db.exec('BEGIN IMMEDIATE'); console.log('LOCKED'); process.stdin.once('data',()=>{ db.exec('ROLLBACK'); db.close(); });`;
			holder = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
			children.push(holder);
			expect(String((await once(holder.stdout!, "data"))[0])).toContain("LOCKED");
			release();
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
			expect(readFileSync(marker, "utf8")).toBe("x");
		} finally {
			lines.close();
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

	it("pauses scheduling when the launcher that owns it disappears, leaving the detached job running", async () => {
		const f = setup();
		invoke(["init", f.directory, f.planPath, "--hosts", f.hostsPath]);
		unpauseFixture(f.directory);
		// A launcher that owns the factory over Node IPC, the contract a wrapper such as `prime-agent factory` keeps:
		// PRIME_FACTORY_PARENT=1 plus an IPC channel. The factory's stdout is the test's pipe, so its end is the exit.
		const launcherSource = `const {spawn}=require('node:child_process'); spawn(process.execPath, ${JSON.stringify([entry(), "serve", f.directory, "--interval-ms", "50"])}, {stdio:['ignore','inherit','ignore','ipc'], env:{...process.env, PRIME_FACTORY_PARENT:'1'}});`;
		const launcher = spawn(process.execPath, ["-e", launcherSource], { stdio: ["ignore", "pipe", "ignore"] });
		children.push(launcher);
		const factoryOutput = launcher.stdout!;
		const closed = once(factoryOutput, "close");
		const lines = createInterface({ input: factoryOutput });
		const attemptId = await new Promise<string>((resolveLaunch) =>
			lines.on("line", (line) => {
				const launched = (JSON.parse(line) as { launched?: string[] }).launched;
				if (launched?.length) resolveLaunch(launched[0]!);
			}),
		);
		await fileReady(f.pidFile);
		launcher.kill("SIGKILL");
		await once(launcher, "exit");
		await closed;
		lines.close();
		const status = JSON.parse(invoke(["status", f.directory])) as FactoryStatus;
		expect([status.paused, status.pauseReason]).toEqual([
			true,
			"Scheduling service stopped by signal; resume explicitly to dispatch",
		]);
		// Nothing was launched again and the detached job outlived both processes.
		expect([status.attempts.map((attempt) => attempt.id), readFileSync(f.marker, "utf8")]).toEqual([[attemptId], "x"]);
		f.release();
		await fileReady(join(f.runnerRoot, attemptId, "terminal.json"));
	});

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
