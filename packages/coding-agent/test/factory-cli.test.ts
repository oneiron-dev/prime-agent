import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { factoryArguments, supportsFactoryRuntime } from "../src/cli/factory-launch.js";
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
