import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

interface PassiveRow {
	entry: { childId: string };
}

type PassiveScan = (savedRoots: SessionInfo[], includeResident: boolean) => Promise<PassiveRow[]>;

interface DaemonInternals {
	listPassiveRlmSubagents(savedRoots?: SessionInfo[], includeResident?: boolean): Promise<PassiveRow[]>;
	scanPassiveRlmSubagents: PassiveScan;
}

describe("AgentDaemon passive RLM scan coalescing", () => {
	it("shares 100+ concurrent default traversals by includeResident and re-scans changed registry state", async () => {
		const internals = createDaemonInternals();
		const scansStarted = deferred();
		const releaseScans = deferred();
		let registryRows: PassiveRow[] = [{ entry: { childId: "child-1" } }];
		let scanCount = 0;
		internals.scanPassiveRlmSubagents = vi.fn(async () => {
			scanCount++;
			if (scanCount === 2) scansStarted.resolve();
			await releaseScans.promise;
			return registryRows;
		});

		const defaultCalls = Array.from({ length: 128 }, () => internals.listPassiveRlmSubagents());
		const includeResidentCalls = Array.from({ length: 128 }, () =>
			internals.listPassiveRlmSubagents(undefined, true),
		);
		await scansStarted.promise;
		const scansBeforeRelease = scanCount;
		releaseScans.resolve();
		const results = await Promise.all([...defaultCalls, ...includeResidentCalls]);

		expect(scansBeforeRelease).toBe(2);
		expect(results.every((rows) => rows.map(({ entry }) => entry.childId).join() === "child-1")).toBe(true);
		expect(results[0]).not.toBe(results[1]);

		registryRows = [...registryRows, { entry: { childId: "child-2" } }];
		await expect(internals.listPassiveRlmSubagents()).resolves.toEqual(registryRows);
		expect(scanCount).toBe(3);
	});

	it("keeps concurrent calls with explicit saved roots independent", async () => {
		const internals = createDaemonInternals();
		const scansStarted = deferred();
		const releaseScans = deferred();
		let scanCount = 0;
		internals.scanPassiveRlmSubagents = vi.fn(async () => {
			scanCount++;
			if (scanCount === 2) scansStarted.resolve();
			await releaseScans.promise;
			return [];
		});

		// A *non-empty* saved-root list is explicit caller input: it names the
		// roots to walk, so it is never answered from the whole-daemon scan.
		const first = internals.listPassiveRlmSubagents(savedRoots("root-1"));
		const second = internals.listPassiveRlmSubagents(savedRoots("root-2"));
		await scansStarted.promise;
		const scansBeforeRelease = scanCount;
		releaseScans.resolve();
		await Promise.all([first, second]);

		expect(scansBeforeRelease).toBe(2);
	});

	it("treats an empty saved-root list as no input and joins the background scan", async () => {
		const internals = createDaemonInternals();
		const releaseScan = deferred();
		let scanCount = 0;
		let observedRoots: SessionInfo[] | undefined;
		internals.scanPassiveRlmSubagents = vi.fn(async (roots: SessionInfo[]) => {
			scanCount++;
			observedRoots = roots;
			await releaseScan.promise;
			return [{ entry: { childId: "child-1" } }];
		});

		// An empty list carries no roots to scan. Scanning it literally would walk
		// nothing and report an empty result, which reads downstream as "this child
		// does not exist" — so it must coalesce onto the whole-daemon scan instead.
		const explicitEmpty = internals.listPassiveRlmSubagents([]);
		const defaultScan = internals.listPassiveRlmSubagents();
		const alsoEmpty = internals.listPassiveRlmSubagents([]);
		releaseScan.resolve();
		const results = await Promise.all([explicitEmpty, defaultScan, alsoEmpty]);

		expect(scanCount).toBe(1);
		expect(observedRoots).toEqual([]);
		for (const rows of results) {
			expect(rows.map(({ entry }) => entry.childId)).toEqual(["child-1"]);
		}
		// Each caller still gets its own array, so one caller cannot mutate another's.
		expect(results[0]).not.toBe(results[1]);
	});

	it("clears a failed default traversal before the next call", async () => {
		const internals = createDaemonInternals();
		const scanStarted = deferred();
		const releaseScan = deferred();
		let scanCount = 0;
		internals.scanPassiveRlmSubagents = vi.fn(async () => {
			scanCount++;
			if (scanCount === 1) {
				scanStarted.resolve();
				await releaseScan.promise;
				throw new Error("passive scan failed");
			}
			return [{ entry: { childId: "recovered-child" } }];
		});

		const concurrent = Array.from({ length: 128 }, () => internals.listPassiveRlmSubagents());
		await scanStarted.promise;
		const scansBeforeRelease = scanCount;
		releaseScan.resolve();
		const settled = await Promise.allSettled(concurrent);

		expect(scansBeforeRelease).toBe(1);
		expect(
			settled.every(
				(result) =>
					result.status === "rejected" &&
					result.reason instanceof Error &&
					result.reason.message === "passive scan failed",
			),
		).toBe(true);
		await expect(internals.listPassiveRlmSubagents()).resolves.toEqual([{ entry: { childId: "recovered-child" } }]);
		expect(scanCount).toBe(2);
	});
});

/** Minimal saved-root rows; the scan itself is stubbed in these tests. */
function savedRoots(...ids: string[]): SessionInfo[] {
	return ids.map((id) => ({ id, path: `/tmp/${id}.jsonl` }) as unknown as SessionInfo);
}

function createDaemonInternals(): DaemonInternals {
	return new AgentDaemon("/tmp/unused-passive-scan-coalescing.sock", {
		defaultSessionConfig: { agentDir: "/tmp/unused-passive-scan-coalescing", cwd: "/tmp" },
		createRuntime: vi.fn(),
	}) as unknown as DaemonInternals;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
