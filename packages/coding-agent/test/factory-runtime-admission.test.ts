import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import {
	CommandAdapter,
	commandTransport,
	type HostRequest,
	type HostTransport,
} from "../src/factory/adapters/command.js";
import { COMMAND_RUNNER_SHA256, COMMAND_RUNNER_SOURCE } from "../src/factory/adapters/command-runner-source.js";
import { runFactoryCli } from "../src/factory/cli.js";
import { FactoryEngine } from "../src/factory/engine.js";
import * as runtime from "../src/factory/runtime.js";
import { FactoryStore } from "../src/factory/store.js";
import type { FactoryPlan } from "../src/factory/types.js";
import { admitRuntimeFixture, createRuntimeFixture } from "./factory-runtime-fixture.js";

const roots: string[] = [];
const stores: FactoryStore[] = [];
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "factory-runtime-admission-"));
	roots.push(directory);
	const pin = createRuntimeFixture(directory);
	const host = { type: "local" as const, runnerRoot: join(directory, "attempts") };
	const marker = join(directory, "executed");
	const plan: FactoryPlan = {
		version: 1,
		tickets: [{ id: "ticket", owner: "owner" }],
		slots: [{ id: "slot", host: "local" }],
		actions: [
			{
				id: "action",
				ticketId: "ticket",
				kind: "process",
				dependencies: [],
				sourceFingerprint: "opaque:fixture",
				requirements: { runtime: pin },
				command: {
					cwd: directory,
					argv: [
						process.execPath,
						"-e",
						`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
					],
				},
			},
		],
	};
	const store = new FactoryStore(join(directory, "factory.db"));
	stores.push(store);
	const manifest: HostRequest["manifest"] = {
		version: 1,
		attemptId: "attempt",
		sourceFingerprint: "opaque:fixture",
		command: plan.actions[0].command,
		runtime: pin,
		daemonStartedAt: Date.now(),
		daemonSharesHost: true,
		runnerSha256: COMMAND_RUNNER_SHA256,
	};
	return {
		directory,
		pin,
		host,
		marker,
		plan,
		store,
		request: { operation: "launch" as const, runnerRoot: host.runnerRoot, manifest },
	};
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function mismatch(store: FactoryStore, reason: RegExp) {
	const attempt = store.attempts()[0];
	expect(attempt).toMatchObject({ state: "UNCERTAIN", receipt: null, claimReleased: false });
	expect(store.allEvents().filter((event) => event.kind === "runtime_mismatch")).toEqual([
		expect.objectContaining({
			actionId: "action",
			attemptId: attempt.id,
			detail: {
				reason: expect.stringMatching(reason),
				runtime: store.actions()[0].requirements.runtime ?? store.runtimePin(),
				runtime_check: expect.stringMatching(/^(runtime_identity|local_start_time|delivery_integrity)$/),
			},
		}),
	]);
	expect(store.status().wakes).toEqual([
		expect.objectContaining({ actionId: "action", attemptId: attempt.id, resolvedAt: null }),
	]);
}

test("init without an action pin records its own runtime and preserves it across reopen and plan updates", async () => {
	const f = fixture();
	const directory = join(f.directory, "initialized");
	const planPath = join(f.directory, "plan.json"),
		hostsPath = join(f.directory, "hosts.json");
	delete f.plan.actions[0].requirements.runtime;
	writeFileSync(planPath, JSON.stringify(f.plan));
	writeFileSync(hostsPath, JSON.stringify({ local: f.host }));
	vi.spyOn(console, "log").mockImplementation(() => {});
	await runFactoryCli(["init", directory, planPath, "--hosts", hostsPath]);
	const store = new FactoryStore(join(directory, "factory.db"));
	stores.push(store);
	const initializedPin = store.runtimePin()!;
	expect(initializedPin.path).toBe(join(directory, "runtime.json"));
	expect(() => runtime.verifyFactoryRuntimeAdmission(initializedPin, runtime.factoryRuntimeProcess())).not.toThrow();
	expect(store.allEvents().filter((event) => event.kind === "runtime_pinned")).toEqual([
		expect.objectContaining({ actionId: null, attemptId: null, detail: { runtime: initializedPin } }),
	]);
	store.resume();
	f.plan.actions[0].requirements.runtime = { ...f.pin, sha256: "f".repeat(64) };
	store.applyPlan(f.plan, 1);
	expect(store.runtimePin()).toEqual(initializedPin);
	expect(store.claim("action", "slot")?.runtime).toEqual(initializedPin);
});

test("a journal failure rolls back runtime metadata and the initial plan", () => {
	const f = fixture();
	const db = new DatabaseSync(join(f.directory, "factory.db"));
	db.exec(
		"CREATE TRIGGER reject_pin BEFORE INSERT ON events WHEN NEW.kind='runtime_pinned' BEGIN SELECT RAISE(ABORT,'journal failed'); END",
	);
	db.close();
	expect(() => f.store.applyPlan(f.plan, 0, undefined, f.pin)).toThrow("journal failed");
	expect(f.store.runtimePin()).toBeUndefined();
	expect(f.store.actions()).toHaveLength(0);
});

test("matching admission carries ledger pin, process start and runner digest to the host", async () => {
	const f = fixture();
	admitRuntimeFixture(f.pin);
	const transport = vi.fn<HostTransport>(async () => ({ kind: "running", processIdentity: "worker" }));
	const engine = new FactoryEngine(f.store, new CommandAdapter({ local: f.host }, { transport }), { enabled: true });
	engine.applyPlan(f.plan);
	await engine.tick();
	expect(transport).toHaveBeenCalledOnce();
	expect(transport.mock.calls[0][1].manifest).toMatchObject({
		runtime: f.pin,
		daemonStartedAt: runtime.factoryRuntimeProcess().startedAt,
		runnerSha256: COMMAND_RUNNER_SHA256,
	});
	expect(f.store.attempts()[0].state).toBe("RUNNING");
	expect(f.store.status().wakes).toHaveLength(0);
});

test.each(["identity hash", "bundle hash", "stale start", "foreign process", "action pin", "missing ledger"])(
	"admission refuses %s before transport and journals an open wake",
	async (fault) => {
		const f = fixture();
		admitRuntimeFixture(f.pin);
		f.store.applyPlan(f.plan);
		if (fault === "identity hash") writeFileSync(f.pin.path, `${readFileSync(f.pin.path, "utf8")}\n`);
		if (fault === "bundle hash") writeFileSync(join(f.directory, "runtime-bundle", "cli.js"), "changed");
		if (fault === "stale start")
			vi.spyOn(runtime, "factoryRuntimeProcess").mockReturnValue({
				...runtime.factoryRuntimeProcess(),
				startedAt: 0,
			});
		if (fault === "foreign process")
			vi.spyOn(runtime, "factoryRuntimeProcess").mockReturnValue({
				...runtime.factoryRuntimeProcess(),
				executable: join(f.directory, "runtime-bundle", "cli.js"),
			});
		if (fault === "action pin") {
			f.plan.actions[0].requirements.runtime = { ...f.pin, sha256: "f".repeat(64) };
			f.store.applyPlan(f.plan, 1);
		}
		if (fault === "missing ledger") {
			delete f.plan.actions[0].requirements.runtime;
			f.store.applyPlan(f.plan, 1);
		}
		const transport = vi.fn<HostTransport>();
		await new FactoryEngine(f.store, new CommandAdapter({ local: f.host }, { transport }), { enabled: true }).tick();
		expect(transport).not.toHaveBeenCalled();
		expect(existsSync(f.marker)).toBe(false);
		mismatch(f.store, /runtime|Runtime|Process/);
		expect(f.store.allEvents().find((event) => event.kind === "runtime_mismatch")?.detail.runtime_check).toBe(
			fault === "stale start" ? "local_start_time" : "runtime_identity",
		);
	},
);

test("an old process start fails but a fresh source process verifies the same installed files", () => {
	const f = fixture();
	expect(() =>
		runtime.verifyFactoryRuntimeAdmission(f.pin, {
			...runtime.factoryRuntimeProcess(),
			startedAt: Date.now() - 60000,
		}),
	).toThrow("local_start_time");
	const script = `import {factoryRuntimeProcess,verifyFactoryRuntimeAdmission} from ${JSON.stringify(resolve("src/factory/runtime.ts"))}; verifyFactoryRuntimeAdmission(${JSON.stringify(f.pin)},factoryRuntimeProcess());`;
	expect(() =>
		execFileSync(
			process.execPath,
			["--import", resolve("../../node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", script],
			{ stdio: "pipe" },
		),
	).not.toThrow();
});

test.each([
	["bundle", "runtime_identity: Runtime bundle hash mismatch"],
	["identity", "runtime_identity: Runtime bundle hash mismatch"],
	["daemon start", "local_start_time: Daemon start time predates the runtime bundle"],
	["future daemon start", "local_start_time: Invalid daemon process start time"],
	["runner source", "delivery_integrity: Runner source delivery hash mismatch"],
])("Python refuses %s with exit 78 and one stderr line", (fault, reason) => {
	const f = fixture();
	if (fault === "bundle") writeFileSync(join(f.directory, "runtime-bundle", "cli.js"), "changed");
	if (fault === "identity") f.request.manifest.runtime = { ...f.pin, sha256: "f".repeat(64) };
	if (fault === "daemon start") f.request.manifest.daemonStartedAt = 1;
	if (fault === "future daemon start") f.request.manifest.daemonStartedAt = Date.now() + 60000;
	if (fault === "runner source") f.request.manifest.runnerSha256 = "f".repeat(64);
	const result = spawnSync("python3", ["-c", COMMAND_RUNNER_SOURCE], {
		input: JSON.stringify(f.request),
		encoding: "utf8",
	});
	expect(result.status).toBe(78);
	expect(result.stdout).toBe("");
	expect(result.stderr.trim().split("\n")).toEqual([expect.stringContaining(`runtime_mismatch: ${reason}`)]);
	expect(existsSync(f.marker)).toBe(false);
	expect(existsSync(f.host.runnerRoot)).toBe(false);
});

test("Python refuses when its own start predates the pin", () => {
	const f = fixture();
	const fixedSeconds = Math.ceil(Date.now() / 1000) + 60;
	const bundle = join(f.directory, "runtime-bundle", "cli.js");
	utimesSync(bundle, fixedSeconds, fixedSeconds);
	f.request.manifest.daemonStartedAt = (fixedSeconds + 30) * 1000;
	const prelude = `import time\nclock = iter([${fixedSeconds - 30}, ${fixedSeconds + 60}])\ntime.time = lambda: next(clock)\n`;
	const result = spawnSync("python3", ["-c", prelude + COMMAND_RUNNER_SOURCE], {
		input: JSON.stringify(f.request),
		encoding: "utf8",
	});
	expect(result.status).toBe(78);
	expect(result.stdout).toBe("");
	expect(result.stderr.trim()).toBe(
		"runtime_mismatch: local_start_time: Runner start time predates the runtime bundle",
	);
	expect(existsSync(f.marker)).toBe(false);
	expect(existsSync(f.host.runnerRoot)).toBe(false);
});

test("runner refusal after local verification reaches the journal and wake", async () => {
	const f = fixture();
	admitRuntimeFixture(f.pin);
	const transport: HostTransport = (host, request) => {
		writeFileSync(join(f.directory, "runtime-bundle", "cli.js"), "changed in transit");
		return commandTransport(host, request);
	};
	const engine = new FactoryEngine(f.store, new CommandAdapter({ local: f.host }, { transport }), { enabled: true });
	engine.applyPlan(f.plan);
	await engine.tick();
	mismatch(f.store, /^runtime_mismatch: runtime_identity: Runtime bundle hash mismatch/);
	expect(existsSync(f.marker)).toBe(false);
});

test("a bundle change after fork refuses child exec and retains a mismatch receipt", async () => {
	const f = fixture();
	admitRuntimeFixture(f.pin);
	const target = join(f.directory, "runtime-bundle", "cli.js");
	const prelude = `import os\noriginal_fork = os.fork\ndef changed_fork():\n pid = original_fork()\n if pid == 0:\n  with open(${JSON.stringify(target)}, "w") as f: f.write("changed after fork")\n return pid\nos.fork = changed_fork\n`;
	const transport: HostTransport = async (host, request) => {
		if (request.operation !== "launch") return commandTransport(host, request);
		const result = spawnSync("python3", ["-c", prelude + COMMAND_RUNNER_SOURCE], {
			input: JSON.stringify(request),
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(result.stdout);
	};
	const engine = new FactoryEngine(f.store, new CommandAdapter({ local: f.host }, { transport }), { enabled: true });
	engine.applyPlan(f.plan);
	await engine.tick();
	await vi.waitFor(async () => {
		await engine.tick();
		mismatch(f.store, /^runtime_mismatch: runtime_identity: Runtime bundle hash mismatch/);
	});
	const attempt = f.store.attempts()[0];
	expect(JSON.parse(readFileSync(join(f.host.runnerRoot, attempt.id, "runtime-mismatch.json"), "utf8"))).toMatchObject(
		{
			check: "runtime_identity",
			runtime_identity_ok: false,
			delivery_intact: null,
			local_start_time_ok: null,
		},
	);
	expect(existsSync(f.marker)).toBe(false);
});

function verifyPython(request: HostRequest, nowSeconds: number): Record<string, unknown> {
	const prelude = `import sys, time\ntime.time = lambda: ${nowSeconds}\nclass VerifyInput:\n def read(self):\n  print(json.dumps(verify_runtime(json.loads(sys.__stdin__.read())["manifest"])), flush=True)\n  raise SystemExit(0)\nsys.stdin = VerifyInput()\n`;
	const result = spawnSync("python3", ["-c", prelude + COMMAND_RUNNER_SOURCE], {
		input: JSON.stringify(request),
		encoding: "utf8",
	});
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

test.each(["no pin", "different pin", "empty plan"])("init ignores plan runtime selection: %s", async (kind) => {
	const f = fixture();
	if (kind === "no pin") delete f.plan.actions[0].requirements.runtime;
	if (kind === "different pin")
		f.plan.actions[0].requirements.runtime = { path: "/operator/override.json", sha256: "f".repeat(64) };
	if (kind === "empty plan") f.plan.actions = [];
	const planPath = join(f.directory, "plan.json"),
		hostsPath = join(f.directory, "hosts.json");
	writeFileSync(planPath, JSON.stringify(f.plan));
	writeFileSync(hostsPath, JSON.stringify({ local: f.host }));
	vi.spyOn(console, "log").mockImplementation(() => {});
	const directory = join(f.directory, "initialized");
	await runFactoryCli(["init", directory, planPath, "--hosts", hostsPath]);
	const store = new FactoryStore(join(directory, "factory.db"));
	stores.push(store);
	const pin = store.runtimePin()!;
	expect(pin.path).toBe(join(directory, "runtime.json"));
	const identity = JSON.parse(readFileSync(pin.path, "utf8")) as runtime.FactoryRuntimeIdentity;
	expect(identity.cliArgv).toEqual([process.execPath, resolve("src/cli.ts")]);
	expect(identity.files).toContainEqual({
		path: resolve("src/factory/runtime.ts"),
		sha256: runtime.hashFactoryRuntimeFile(resolve("src/factory/runtime.ts")),
	});
});

test.each([false, true])(
	"admission uses metadata with an optional independent action override: %s",
	async (override) => {
		const f = fixture();
		admitRuntimeFixture(f.pin);
		const other = { path: join(f.directory, "other-runtime.json"), sha256: f.pin.sha256 };
		writeFileSync(other.path, readFileSync(f.pin.path));
		if (override) f.plan.actions[0].requirements.runtime = other;
		else delete f.plan.actions[0].requirements.runtime;
		f.store.applyPlan(f.plan, 0, undefined, f.pin);
		const transport = vi.fn<HostTransport>(async () => ({ kind: "running", processIdentity: "worker" }));
		await new FactoryEngine(f.store, new CommandAdapter({ local: f.host }, { transport }), { enabled: true }).tick();
		expect(transport).toHaveBeenCalledOnce();
		expect(transport.mock.calls[0][1].manifest.runtime).toEqual(override ? other : f.pin);
		expect(f.store.runtimePin()).toEqual(f.pin);
	},
);

test("SSH admission marks clocks incomparable and verifies worker hashes despite clock drift", async () => {
	const f = fixture();
	admitRuntimeFixture(f.pin);
	f.store.applyPlan(f.plan);
	const remote = { ...f.host, type: "ssh" as const, sshHost: "arch" };
	const transport = vi.fn<HostTransport>(async (_host, request) => {
		expect(request.manifest.daemonSharesHost).toBe(false);
		request.manifest.daemonStartedAt = 1;
		expect(verifyPython(request, 1)).toEqual({
			runtime_identity_ok: true,
			delivery_intact: true,
			local_start_time_ok: null,
		});
		request.manifest.daemonStartedAt = Date.now() + 3600000;
		expect(verifyPython(request, 1)).toEqual({
			runtime_identity_ok: true,
			delivery_intact: true,
			local_start_time_ok: null,
		});
		writeFileSync(join(f.directory, "runtime-bundle", "cli.js"), "changed remote bundle");
		expect(verifyPython(request, 1)).toMatchObject({ runtime_identity_ok: false, check: "runtime_identity" });
		return { kind: "running", processIdentity: "fixture" };
	});
	await new FactoryEngine(f.store, new CommandAdapter({ local: remote }, { transport }), { enabled: true }).tick();
	expect(transport).toHaveBeenCalledOnce();
});

test("same-host timestamps have the exported tolerance and distinct failure reasons", () => {
	const f = fixture();
	const fixedSeconds = Math.ceil(Date.now() / 1000) + 60;
	utimesSync(join(f.directory, "runtime-bundle", "cli.js"), fixedSeconds, fixedSeconds);
	f.request.manifest.daemonStartedAt = (fixedSeconds - runtime.FACTORY_RUNTIME_START_TOLERANCE_SECONDS + 1) * 1000;
	expect(verifyPython(f.request, fixedSeconds)).toEqual({
		runtime_identity_ok: true,
		delivery_intact: true,
		local_start_time_ok: true,
	});
	f.request.manifest.daemonStartedAt -= 10000;
	expect(verifyPython(f.request, fixedSeconds)).toMatchObject({
		check: "local_start_time",
		runtime_identity_ok: true,
		delivery_intact: true,
		local_start_time_ok: false,
		reason: "runtime_mismatch: local_start_time: Daemon start time predates the runtime bundle",
	});
	f.request.manifest.daemonStartedAt = (fixedSeconds + runtime.FACTORY_RUNTIME_START_TOLERANCE_SECONDS - 1) * 1000;
	expect(verifyPython(f.request, fixedSeconds).local_start_time_ok).toBe(true);
	f.request.manifest.daemonStartedAt += 10000;
	expect(verifyPython(f.request, fixedSeconds).reason).toBe(
		"runtime_mismatch: local_start_time: Invalid daemon process start time",
	);
});

test("delivery integrity is separate from runtime identity in receipts and the journal", async () => {
	const f = fixture();
	admitRuntimeFixture(f.pin);
	const transport: HostTransport = (host, request) => {
		request.manifest.runnerSha256 = "f".repeat(64);
		expect(verifyPython(request, Date.now() / 1000)).toMatchObject({
			runtime_identity_ok: true,
			delivery_intact: false,
			local_start_time_ok: null,
			check: "delivery_integrity",
		});
		return commandTransport(host, request);
	};
	const engine = new FactoryEngine(f.store, new CommandAdapter({ local: f.host }, { transport }), { enabled: true });
	engine.applyPlan(f.plan);
	await engine.tick();
	mismatch(f.store, /^runtime_mismatch: delivery_integrity: Runner source delivery hash mismatch/);
	expect(f.store.allEvents().find((event) => event.kind === "runtime_mismatch")?.detail.runtime_check).toBe(
		"delivery_integrity",
	);
	expect(existsSync(f.marker)).toBe(false);
});

test("successful execution retains separate runtime identity and delivery receipts", async () => {
	const f = fixture();
	admitRuntimeFixture(f.pin);
	const engine = new FactoryEngine(f.store, new CommandAdapter({ local: f.host }), { enabled: true });
	engine.applyPlan(f.plan);
	await engine.tick();
	await vi.waitFor(async () => {
		await engine.tick();
		expect(f.store.attempts()[0].state).toBe("TERMINAL");
	});
	const receiptPath = join(f.host.runnerRoot, f.store.attempts()[0].id, "runtime-admission.json");
	expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual({
		runtime_identity_ok: true,
		delivery_intact: true,
		local_start_time_ok: true,
	});
	expect(readFileSync(f.marker, "utf8")).toBe("executed");
});
