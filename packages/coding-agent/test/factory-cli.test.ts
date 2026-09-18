import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { factoryArguments, supportsFactoryRuntime } from "../src/cli/factory-launch.js";
import type { FactoryCostReport } from "../src/factory/cost.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { FACTORY_EVIDENCE_LIMITS } from "../src/factory/evidence.js";
import type { ManagementPacket } from "../src/factory/management.js";
import { manageFactoryWake } from "../src/factory/management-dispatch.js";
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
	it("reports two tickets and two seats from ledger and receipts without writes or double counting", async () => {
		const f = setup("decision");
		const plan = JSON.parse(readFileSync(f.planPath, "utf8")) as FactoryPlan;
		plan.tickets.push({ id: "other-ticket", owner: "owner" });
		plan.roles = { ticketOwner: { provider: "openai", model: "openai/gpt-4o" } };
		const usage = { input: 10, output: 5, cache_read: 2, cache_write: 1, total: 18 };
		const receiptPaths: string[] = [];
		for (const [index, ticket] of plan.tickets.entries()) {
			const outputDirectory = join(f.root, `output-${index}`);
			mkdirSync(outputDirectory);
			const manifestPath = join(f.root, `manifest-${index}.json`);
			const manifest = JSON.stringify({ ticketId: ticket.id, stage: { kind: "writer" }, outputDirectory });
			const sha = createHash("sha256").update(manifest).digest("hex");
			writeFileSync(manifestPath, manifest);
			const action = {
				...plan.actions[0],
				id: `action-${index}`,
				ticketId: ticket.id,
				command: { cwd: f.root, argv: ["execute", manifestPath, "permit", sha, "--execute"] },
			};
			if (index === 0) plan.actions[0] = action;
			else plan.actions.push(action);
			const path = join(outputDirectory, "receipt.json");
			receiptPaths.push(path);
			writeFileSync(
				path,
				JSON.stringify({
					ticketId: ticket.id,
					manifestSha256: sha,
					result: { writerProvenance: { calls: 2, usage, cost_usd: 0.25, priced: true } },
				}),
			);
		}
		plan.actions.push({ ...plan.actions[0], id: "duplicate-receipt" });
		writeFileSync(f.planPath, JSON.stringify(plan));
		invoke(["init", f.directory, f.planPath, "--hosts", f.hostsPath]);
		invoke(["resume", f.directory]);
		const store = new FactoryStore(join(f.directory, "factory.db"));
		const noProcess = async (): Promise<never> => {
			throw new Error("Cost must not execute work");
		};
		const engine = new FactoryEngine(store, { launch: noProcess, inspect: noProcess });
		try {
			for (const [index, action] of plan.actions.slice(0, 2).entries()) {
				const context = store.claim(action.id, "local-slot")!;
				store.markSubmitted(context.attempt.id);
				store.complete({
					attemptId: context.attempt.id,
					sourceFingerprint: action.sourceFingerprint,
					exitCode: 0,
					finishedAt: new Date().toISOString(),
				});
				const result = await manageFactoryWake(
					engine,
					{ directory: f.directory, actionId: action.id },
					() => async (_system, serialized) => {
						const packet = JSON.parse(serialized) as ManagementPacket;
						return {
							model: "openai/gpt-4o",
							responseModel: "openai/gpt-4o",
							responseModelSource: "provider-response",
							usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
							text:
								index === 1
									? "invalid decision"
									: JSON.stringify({
											version: 1,
											actionId: action.id,
											planRevision: packet.planRevision,
											attemptId: packet.attempt!.id,
											decision: "defer",
											reason: "fixture",
											evidenceRefs: [],
										}),
						};
					},
				);
				expect(result.kind).toBe(index === 0 ? "deferred" : "error");
				const path = join(
					f.directory,
					"decisions",
					result.requestId!,
					index === 0 ? "proposal.json" : "response.json",
				);
				const saved = JSON.parse(readFileSync(path, "utf8"));
				expect(saved.accounting).toMatchObject({ calls: 1, priced: true, cost_usd: 2.5 });
				expect(saved.wall_clock_ms).toBeGreaterThanOrEqual(0);
				receiptPaths.push(path);
			}
			const duplicate = store.claim("duplicate-receipt", "local-slot")!;
			expect(duplicate.attempt.id).toBeTruthy();
		} finally {
			store.close();
		}
		const database = join(f.directory, "factory.db");
		const before = [database, ...receiptPaths].map((path) => readFileSync(path));
		const report = JSON.parse(invoke(["cost", f.directory, "--json"])) as FactoryCostReport;
		expect(report.rows).toHaveLength(4);
		expect(report.missing).toEqual([]);
		expect(report.total).toEqual({
			calls: 6,
			cost_usd: 5.5,
			priced: true,
			usage: { input: 2_000_020, output: 10, cache_read: 4, cache_write: 2, total: 2_000_036 },
		});
		expect(report.rows.filter((row) => row.seat === "writer")).toHaveLength(2);
		expect(report.rows.filter((row) => row.seat === "ticketOwner")).toHaveLength(2);
		const filtered = JSON.parse(invoke(["cost", f.directory, "--ticket", "ticket", "--json"])) as FactoryCostReport;
		expect(filtered.rows).toHaveLength(2);
		expect(filtered.rows.every((row) => row.ticket === "ticket")).toBe(true);
		expect(filtered.total).toMatchObject({ calls: 3, cost_usd: 2.75, priced: true });
		const table = invoke(["cost", f.directory]);
		expect(table).toContain("TICKET\tSEAT\tCALLS");
		expect(table).toContain("CACHE_READ\tCACHE_WRITE");
		expect(table).toContain("TOTAL\t*\t6");
		expect(table).toContain("5.50000000");
		expect([database, ...receiptPaths].map((path) => readFileSync(path))).toEqual(before);
		expect(existsSync(f.marker)).toBe(false);
		expect(JSON.parse(invoke(["cost", f.directory, "--ticket", "absent", "--json"])).rows).toEqual([]);
		const unknown = JSON.parse(readFileSync(receiptPaths[0], "utf8"));
		unknown.result.writerProvenance.cost_usd = null;
		unknown.result.writerProvenance.priced = false;
		writeFileSync(receiptPaths[0], JSON.stringify(unknown));
		expect(JSON.parse(invoke(["cost", f.directory, "--json"])).total).toMatchObject({
			cost_usd: null,
			priced: false,
		});
		expect(invoke(["cost", f.directory])).toContain("unknown");
		rmSync(receiptPaths[0]);
		const missing = JSON.parse(invoke(["cost", f.directory, "--json"])) as FactoryCostReport;
		expect(missing.missing).toContain(receiptPaths[0]);
		expect(missing.total).toMatchObject({ cost_usd: null, usage: null, priced: false });
		expect(() => invoke(["cost", f.directory, "--ticket"])).toThrow();
		expect(() => invoke(["cost", f.directory, "--json", "--json"])).toThrow();
		expect(() => invoke(["status", f.directory, "--json"])).toThrow();
		expect(() => invoke(["cost", f.directory, "--actor", "owner"])).toThrow();
	}, 15_000);

	it.each(["missing", "directory"])(
		"reports a %s manifest without losing the other ticket's totals",
		(failure) => {
			const f = setup();
			const plan = JSON.parse(readFileSync(f.planPath, "utf8")) as FactoryPlan;
			plan.tickets.push({ id: "other-ticket", owner: "owner" });
			const usage = { input: 10, output: 5, cache_read: 2, cache_write: 1, total: 18 };
			const cost = { calls: 2, usage, cost_usd: 0.25, priced: true };
			const paths: string[] = [];
			plan.actions = plan.tickets.map((ticket, index) => {
				const outputDirectory = join(f.root, `output-${index}`);
				mkdirSync(outputDirectory);
				const path = join(f.root, `manifest-${index}.json`);
				paths.push(path);
				const manifest = JSON.stringify({ stage: { kind: "writer" }, outputDirectory });
				const sha = createHash("sha256").update(manifest).digest("hex");
				writeFileSync(path, manifest);
				writeFileSync(
					join(outputDirectory, "receipt.json"),
					JSON.stringify({ ticketId: ticket.id, manifestSha256: sha, result: { writerProvenance: cost } }),
				);
				return {
					...plan.actions[0],
					id: `action-${index}`,
					ticketId: ticket.id,
					command: { cwd: f.root, argv: ["execute", path, "permit", sha, "--execute"] },
				};
			});
			writeFileSync(f.planPath, JSON.stringify(plan));
			invoke(["init", f.directory, f.planPath, "--hosts", f.hostsPath]);
			invoke(["resume", f.directory]);
			const store = new FactoryStore(join(f.directory, "factory.db"));
			try {
				for (const action of plan.actions) {
					const context = store.claim(action.id, "local-slot")!;
					store.markSubmitted(context.attempt.id);
					store.complete({
						attemptId: context.attempt.id,
						sourceFingerprint: action.sourceFingerprint,
						exitCode: 0,
						finishedAt: new Date().toISOString(),
					});
				}
			} finally {
				store.close();
			}
			rmSync(paths[0]);
			if (failure === "directory") mkdirSync(paths[0]);
			const report = JSON.parse(invoke(["cost", f.directory, "--json"])) as FactoryCostReport;
			expect(report.rows).toEqual([{ ticket: "other-ticket", seat: "writer", ...cost }]);
			expect(report.unreadable).toHaveLength(1);
			expect(report.unreadable[0]).toMatchObject({
				status: "unreadable",
				ticket: "ticket",
				seat: "writer",
				actionId: "action-0",
				path: paths[0],
			});
			expect(report.unreadable[0].reason.length).toBeGreaterThan(0);
			expect(report.total).toEqual({ calls: 2, usage: null, cost_usd: null, priced: false });
			expect(report.missing).toEqual([]);
			const table = invoke(["cost", f.directory]);
			expect(table).toContain("other-ticket\twriter\t2\t10\t5\t2\t1\t18\t0.25000000\ttrue");
			expect(table).toContain(`unreadable\t${paths[0]}\t${report.unreadable[0].reason}`);
			expect(table).toContain("Unreadable rows: 1");
			const filtered = JSON.parse(
				invoke(["cost", f.directory, "--ticket", "other-ticket", "--json"]),
			) as FactoryCostReport;
			expect(filtered.total).toEqual(cost);
			expect(filtered.unreadable).toEqual([]);
			expect(existsSync(f.marker)).toBe(false);
		},
		15_000,
	);

	it("keeps help independent of SQLite, sessions and daemon startup", () => {
		const { root } = setup();
		const help = invoke(["help"], root);
		expect(help).toContain("Factory mode is optional");
		expect(help).toContain("prime factory settle-no-retry");
		expect(help).toContain("prime factory withdraw");
		expect(help).toContain("NOT_EXECUTED");
		expect(existsSync(join(root, ".prime"))).toBe(false);
		expect(factoryArguments(["factory", "status", "/tmp/test"])).toEqual(["status", "/tmp/test"]);
		expect(factoryArguments(["help", "factory"])).toEqual(["help"]);
		expect(factoryArguments(["-p", "factory"])).toBeUndefined();
		expect(supportsFactoryRuntime({ node: "22.8.0" })).toBe(false);
		expect(supportsFactoryRuntime({ node: "22.13.0" })).toBe(true);
		expect(supportsFactoryRuntime({ node: "26.2.0" })).toBe(true);
		expect(supportsFactoryRuntime({ node: "24.0.0", bun: "1.2.0" })).toBe(false);
	});

	it("runs a bounded paused management watch without inference and validates its opt-in options", () => {
		const { root, directory, planPath, hostsPath } = setup();
		invoke(["init", directory, planPath, "--hosts", hostsPath], root);
		const output = invoke(
			["manage", directory, "--watch", "--apply", "--max-requests", "1", "--max-passes", "1"],
			root,
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(output).toEqual([
			{ kind: "paused", admitted: false },
			{ kind: "watch-finished", admitted: 0, passes: 1 },
		]);
		expect(JSON.parse(invoke(["status", directory])).managementRequests).toEqual([]);
		expect(existsSync(join(directory, "decisions"))).toBe(false);
		expect(() => invoke(["manage", directory, "--watch", "--max-requests", "0"], root)).toThrow();
		expect(() => invoke(["manage", directory, "--watch", "--evidence", planPath], root)).toThrow();
		expect(invoke(["manage", "--help"], root)).toContain("--max-passes");
	});

	it("accepts the full UTF-8 manual evidence file budget and diagnoses excess bytes without inference", () => {
		const { root, directory, planPath, hostsPath } = setup();
		invoke(["init", directory, planPath, "--hosts", hostsPath], root);
		const path = join(root, "proof.txt");
		writeFileSync(path, "é".repeat(FACTORY_EVIDENCE_LIMITS.contentBytes / 2));
		expect(JSON.parse(invoke(["manage", directory, "--evidence", path], root))).toEqual({
			kind: "paused",
			admitted: false,
		});
		writeFileSync(path, "é".repeat(FACTORY_EVIDENCE_LIMITS.contentBytes / 2 + 1));
		expect(() => invoke(["manage", directory, "--evidence", path], root)).toThrow(
			"evidence[0].content: actual 65538 UTF-8 bytes exceeds limit 65536",
		);
		expect(() => invoke(["manage", directory, "--evidence", root], root)).toThrow(
			`evidence[0].content: expected a regular file: ${root}`,
		);
		expect(JSON.parse(invoke(["status", directory], root)).managementRequests).toEqual([]);
		expect(existsSync(join(directory, "decisions"))).toBe(false);
	});

	it("validates 32 manual evidence records and aggregate bytes before factory lookup", () => {
		const { root, directory, planPath, hostsPath } = setup();
		invoke(["init", directory, planPath, "--hosts", hostsPath], root);
		const paths = Array.from({ length: 32 }, (_, index) => {
			const path = join(root, `proof-${index}.txt`);
			writeFileSync(path, "é".repeat(1024));
			return path;
		});
		const options = paths.flatMap((path) => ["--evidence", path]);
		expect(JSON.parse(invoke(["manage", directory, ...options], root))).toEqual({ kind: "paused", admitted: false });
		const missingFactory = join(root, "not-initialized");
		writeFileSync(paths[31], "é".repeat(1025));
		expect(() => invoke(["manage", missingFactory, ...options], root)).toThrow(
			"evidence.content aggregate: actual 65538 UTF-8 bytes exceeds limit 65536",
		);
		const extra = join(root, "extra.txt");
		writeFileSync(extra, "proof");
		expect(() => invoke(["manage", missingFactory, ...options, "--evidence", extra], root)).toThrow(
			"evidence.length: actual 33; limit 0..32",
		);
		expect(JSON.parse(invoke(["status", directory], root)).managementRequests).toEqual([]);
		expect(existsSync(join(directory, "decisions"))).toBe(false);
	});

	it("requires explicit revision for imports and replays an import token without another revision", () => {
		const { directory, planPath, hostsPath } = setup();
		invoke(["init", directory, planPath, "--hosts", hostsPath]);
		invoke(["resume", directory]);
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

	it("reconciles a proven unsubmitted management request through the CLI without inference or process retry", () => {
		const { root, directory, marker, planPath, hostsPath } = setup("decision");
		invoke(["init", directory, planPath, "--hosts", hostsPath]);
		invoke(["resume", directory]);
		const store = new FactoryStore(join(directory, "factory.db"));
		let attemptId: string;
		let wakeId: number;
		try {
			const context = store.claim("a", "local-slot")!;
			attemptId = context.attempt.id;
			store.markSubmitted(attemptId);
			store.complete({
				attemptId,
				sourceFingerprint: context.action.sourceFingerprint,
				exitCode: 0,
				finishedAt: "2026-09-05T00:00:00Z",
			});
			wakeId = store.wakes()[0].id;
			store.claimManagement({
				id: "fixture-request",
				wakeId,
				actionId: "a",
				attemptId,
				planRevision: 1,
				evidenceSha256: "0".repeat(64),
			});
		} finally {
			store.close();
		}
		const writeProof = (name: string, data: unknown) => {
			const ref = join(root, name);
			const content = JSON.stringify(data);
			writeFileSync(ref, content);
			return { ref, sha256: createHash("sha256").update(content).digest("hex") };
		};
		const actor = writeProof("actor.json", {
			version: 1,
			requestId: "fixture-request",
			actorIdentity: "fixture-process",
			stopped: true,
			authorityRevoked: true,
		});
		const provider = writeProof("provider.json", {
			version: 1,
			requestId: "fixture-request",
			disposition: "not-submitted",
		});
		const bundle = writeProof("reconciliation.json", {
			version: 1,
			requestId: "fixture-request",
			wakeId,
			attemptId,
			planRevision: 1,
			priorActor: { identity: "fixture-process", stopped: true, authorityRevoked: true, ...actor },
			providerRequest: { disposition: "not-submitted", ...provider },
			artifacts: [],
		});
		const output = JSON.parse(
			invoke([
				"reconcile-management",
				directory,
				"fixture-request",
				"--expected-revision",
				"1",
				"--actor",
				"owner",
				"--reason",
				"Reconciled exact process and request",
				"--ref",
				bundle.ref,
			]),
		);
		expect(output.managementRequests[0].state).toBe("RECONCILED");
		expect(output.actions[0].state).toBe("AWAITING_DECISION");
		expect(output.attempts).toHaveLength(1);
		expect(existsSync(marker)).toBe(false);
		const decide = [
			"decide",
			directory,
			"a",
			"accept",
			"--actor",
			"owner",
			"--reason",
			"Reviewed preserved output",
			"--ref",
			bundle.ref,
			"--expected-revision",
			"1",
			"--expected-attempt",
			attemptId,
			"--expected-wake",
			String(wakeId),
		];
		expect(JSON.parse(invoke(decide)).actions[0].state).toBe("ACCEPTED");
		expect(() => invoke(decide)).toThrow();
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
