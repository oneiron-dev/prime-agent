import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { factoryArguments, supportsFactoryRuntime } from "../src/cli/factory-launch.js";
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
function setup(kind: "process" | "decision" = "process") {
	const root = mkdtempSync(join(tmpdir(), "prime-factory-cli-"));
	roots.push(root);
	const directory = join(root, "factory");
	const runnerRoot = join(root, "attempts");
	const marker = join(root, "marker");
	const plan: FactoryPlan = {
		version: 1,
		tickets: [{ id: "ticket", owner: "astra-low" }],
		slots: [{ id: "local-slot", host: "local" }],
		actions: [
			{
				id: "a",
				ticketId: "ticket",
				dependencies: [],
				sourceFingerprint: "opaque:fixture",
				kind,
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
		roles: { ticketOwner: { provider: "cpa-r", model: "gpt-6-astra", effort: "low" } },
	};
	const planPath = join(root, "plan.json");
	const hostsPath = join(root, "hosts.json");
	writeFileSync(planPath, JSON.stringify(plan));
	writeFileSync(hostsPath, JSON.stringify({ local: { type: "local", runnerRoot } }));
	return { root, directory, runnerRoot, marker, planPath, hostsPath };
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
		expect(invoke(["help"], root)).toContain("Factory mode is optional");
		expect(existsSync(join(root, ".prime"))).toBe(false);
		expect(factoryArguments(["factory", "status", "/tmp/test"])).toEqual(["status", "/tmp/test"]);
		expect(factoryArguments(["help", "factory"])).toEqual(["help"]);
		expect(factoryArguments(["-p", "factory"])).toBeUndefined();
		expect(supportsFactoryRuntime({ node: "22.8.0" })).toBe(false);
		expect(supportsFactoryRuntime({ node: "22.13.0" })).toBe(true);
		expect(supportsFactoryRuntime({ node: "26.2.0" })).toBe(true);
		expect(supportsFactoryRuntime({ node: "24.0.0", bun: "1.2.0" })).toBe(false);
	});

	it("starts paused and reconciles a detached job after the scheduling process is killed", async () => {
		const { root, directory, runnerRoot, marker, planPath, hostsPath } = setup();
		const initialized = JSON.parse(
			invoke(["init", directory, planPath, "--hosts", hostsPath], root),
		) as FactoryStatus;
		expect(initialized.paused).toBe(true);
		expect(JSON.parse(invoke(["tick", directory])).launched).toEqual([]);
		expect(existsSync(runnerRoot)).toBe(false);
		invoke(["resume", directory]);
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
			expect(recovered.roles?.ticketOwner?.effort).toBe("low");
		} finally {
			server.kill("SIGKILL");
		}
	}, 15_000);

	it("pauses scheduling when its launcher disappears", async () => {
		const { directory, marker, planPath, hostsPath } = setup();
		invoke(["init", directory, planPath, "--hosts", hostsPath]);
		invoke(["resume", directory]);
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
		invoke(["resume", directory]);
		writeFileSync(pauseFile, "{}");
		expect(JSON.parse(invoke(["tick", directory])).paused).toBe(true);
		expect(existsSync(marker)).toBe(false);
		expect(() => invoke(["resume", directory])).toThrow();
		expect(existsSync(pauseFile)).toBe(true);
	});

	it("leaves semantic acceptance for an explicit evidence-backed decision", async () => {
		const { directory, runnerRoot, planPath, hostsPath } = setup("decision");
		invoke(["init", directory, planPath, "--hosts", hostsPath]);
		invoke(["resume", directory]);
		invoke(["tick", directory]);
		const state = JSON.parse(invoke(["status", directory])) as FactoryStatus;
		await waitUntil(() => existsSync(join(runnerRoot, state.attempts[0]!.id, "terminal.json")));
		invoke(["tick", directory]);
		expect((JSON.parse(invoke(["status", directory])) as FactoryStatus).actions[0]?.state).toBe("AWAITING_DECISION");
		const accepted = JSON.parse(
			invoke([
				"decide",
				directory,
				"a",
				"accept",
				"--actor",
				"operator",
				"--reason",
				"Reviewed evidence",
				"--ref",
				"artifact:fixture",
			]),
		) as FactoryStatus;
		expect(accepted.actions[0]?.state).toBe("ACCEPTED");
		expect(JSON.parse(invoke(["events", directory])).length).toBeGreaterThan(0);
	}, 15_000);
});
