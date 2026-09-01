import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelClient } from "../src/core/kernel/shared.js";
import { SessionAlreadyActiveError } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import { deserializeDaemonError, serializeDaemonError } from "../src/modes/daemon/daemon-errors.js";
import { failure } from "../src/modes/daemon/daemon-protocol.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A kernel client that can be driven from running to shut down. */
function fakeKernel(label: string): KernelClient & { shutDown: boolean } {
	const kernel = {
		label,
		shutDown: false,
		ownerSessionId: undefined,
		get isRunning() {
			return !kernel.shutDown;
		},
		get isShutDown() {
			return kernel.shutDown;
		},
	};
	return kernel as unknown as KernelClient & { shutDown: boolean };
}

describe("kernel shutdown reprovisioning", () => {
	it("discards a shut-down kernel manager and provisions a fresh one on the next ensure()", async () => {
		const provisioner = new IpythonKernelProvisioner("/tmp");
		const first = fakeKernel("first");
		const second = fakeKernel("second");
		let starts = 0;
		const startKernel = vi.fn(async (): Promise<KernelClient> => (starts++ === 0 ? first : second));
		// Shadow the real startup so no python kernel is launched by this test.
		Object.assign(provisioner, { startKernel });

		await expect(provisioner.ensure()).resolves.toBe(first);
		// A live kernel is memoized: no second startup.
		await expect(provisioner.ensure()).resolves.toBe(first);
		expect(startKernel).toHaveBeenCalledTimes(1);
		expect(provisioner.manager).toBe(first);

		// The kernel shuts down underneath the tool (the Mac failure: every later
		// ensure() kept handing back the dead manager forever).
		first.shutDown = true;
		expect(first.isRunning).toBe(false);
		expect(first.isShutDown).toBe(true);

		await expect(provisioner.ensure()).resolves.toBe(second);
		expect(startKernel).toHaveBeenCalledTimes(2);
		expect(provisioner.manager).toBe(second);
		expect(provisioner.hasRunningKernel).toBe(true);
	});
});

describe("typed daemon error propagation", () => {
	it("round-trips SessionAlreadyActiveError with the active id an open cycle adopts", () => {
		// Agents View resumes a saved file and, on an already-resident conflict,
		// adopts the returned active runtime instead of resuming the file twice.
		// That adoption is only possible if the active id survives the wire.
		const original = new SessionAlreadyActiveError("/tmp/project/session.jsonl", "active-42");
		const response = failure("req-1", "create", original.message, serializeDaemonError(original));
		expect(response.success).toBe(false);
		if (response.success) throw new Error("expected a failure response");

		const restored = deserializeDaemonError(response);
		expect(restored).toBeInstanceOf(SessionAlreadyActiveError);
		expect(restored).toMatchObject({
			code: "session_already_active",
			sessionPath: "/tmp/project/session.jsonl",
			activeSessionId: "active-42",
		});
	});

	it("leaves an untyped daemon failure as a plain error", () => {
		const response = failure("req-2", "create", "something else went wrong", undefined);
		if (response.success) throw new Error("expected a failure response");
		const restored = deserializeDaemonError(response);
		expect(restored).not.toBeInstanceOf(SessionAlreadyActiveError);
		expect(restored.message).toBe("something else went wrong");
	});
});

describe("rlm ledger replay cache", () => {
	function ledgerRoot() {
		const root = mkdtempSync(join(tmpdir(), "prime-mac-ledger-"));
		tempDirs.push(root);
		const sessionsDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionsDir);
		parent.newSession();
		parent.appendSessionInfo("parent");
		parent.flushNow();
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("Missing parent session file");
		return { root, sessionsDir, parentFile };
	}

	it("reuses parsed state while file identity is unchanged and re-reads after an append", async () => {
		const { root, sessionsDir, parentFile } = ledgerRoot();
		const ledger = new RlmSpawnLedger(root, sessionsDir);
		await ledger.appendSpawn({
			childId: "sub-11111111",
			parent: parentFile,
			child: join(sessionsDir, "child-1.jsonl"),
			depth: 1,
			name: "child-1",
		});

		const first = await ledger.edges();
		const second = await ledger.edges();
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		// Defensive copies: a cached replay never hands out shared, mutable edges.
		expect(second[0]).not.toBe(first[0]);
		expect(second[0]).toEqual(first[0]);
		first[0]!.child = "/tmp/mutated-by-caller.jsonl";
		expect((await ledger.edges())[0]?.child).toBe(join(sessionsDir, "child-1.jsonl"));

		// The cache is keyed on file identity, so this writer's own append invalidates it.
		await ledger.appendSpawn({
			childId: "sub-22222222",
			parent: parentFile,
			child: join(sessionsDir, "child-2.jsonl"),
			depth: 1,
			name: "child-2",
		});
		expect(await ledger.edges()).toHaveLength(2);
	});

	it("re-reads when another process appends to the same ledger file", async () => {
		const { root, sessionsDir, parentFile } = ledgerRoot();
		const writer = new RlmSpawnLedger(root, sessionsDir);
		await writer.appendSpawn({
			childId: "sub-11111111",
			parent: parentFile,
			child: join(sessionsDir, "child-1.jsonl"),
			depth: 1,
			name: "child-1",
		});

		// A separate instance stands in for the other process holding the same file.
		const reader = new RlmSpawnLedger(root, sessionsDir);
		expect(await reader.edges()).toHaveLength(1);

		await writer.appendSpawn({
			childId: "sub-22222222",
			parent: parentFile,
			child: join(sessionsDir, "child-2.jsonl"),
			depth: 1,
			name: "child-2",
		});
		// Cross-process staleness stays bounded to in-flight appends: size/mtime
		// changed, so the cached replay is not reused.
		expect(await reader.edges()).toHaveLength(2);
	});

	it("does not serve a cached replay after the ledger file is replaced", async () => {
		const { root, sessionsDir, parentFile } = ledgerRoot();
		const ledger = new RlmSpawnLedger(root, sessionsDir);
		await ledger.appendSpawn({
			childId: "sub-11111111",
			parent: parentFile,
			child: join(sessionsDir, "child-1.jsonl"),
			depth: 1,
			name: "child-1",
		});
		const path = (ledger as unknown as { path: string }).path;
		expect(await ledger.edges()).toHaveLength(1);

		// Truncate to an empty ledger and force a distinct mtime.
		writeFileSync(path, "");
		const past = new Date(Date.now() - 60_000);
		utimesSync(path, past, past);
		expect(await ledger.edges()).toHaveLength(0);
	});
});
