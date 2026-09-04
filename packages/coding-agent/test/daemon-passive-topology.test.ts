import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionInfo } from "../src/core/session-manager.js";
import * as displayMetadata from "../src/modes/daemon/rlm-subagent-display.js";
import { cleanupTopologyFixtures, topologyFixture, topologyState } from "./helpers/passive-topology-fixture.js";

const originalDisplayRead = displayMetadata.readRlmSubagentDisplayEntry;
const scenario = { name: "memo", children: 3, depth: 0 };
function display(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(dirname(path), "rlm-subagent.json"), "utf8")) as Record<string, unknown>;
}
function rewriteDisplay(path: string, changes: Record<string, unknown>): void {
	writeFileSync(join(dirname(path), "rlm-subagent.json"), JSON.stringify({ ...display(path), ...changes }));
}
function message(id: string): string {
	return `${JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-09-05T01:00:00.000Z", message: { role: "user", content: id, timestamp: 2 } })}\n`;
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(() => {
	vi.restoreAllMocks();
	cleanupTopologyFixtures();
});

describe("validated passive topology memo", () => {
	it("reuses unchanged metadata while preserving independent caller arrays", async () => {
		const { internals } = topologyFixture(scenario);
		const walk = vi.spyOn(internals, "walkPassiveRlmSubagents");
		const first = await internals.listPassiveRlmSubagents();
		const second = await internals.listPassiveRlmSubagents();
		expect(walk).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
		expect(second).not.toBe(first);
		first.pop();
		expect(await internals.listPassiveRlmSubagents()).toHaveLength(3);
		expect(walk).toHaveBeenCalledTimes(1);
	});
	it("invalidates append, deletion, reappearance and ledger tombstones", async () => {
		const { internals, files, ledger } = topologyFixture(scenario);
		const file = files.get("target-child-0")!;
		await internals.listPassiveRlmSubagents();
		appendFileSync(file, message("second-message"));
		expect(
			(await internals.listPassiveRlmSubagents()).find((row) => row.entry.childId === "target-child-0")?.info
				.messageCount,
		).toBe(2);
		renameSync(file, `${file}.aside`);
		expect(await internals.listPassiveRlmSubagents()).toHaveLength(2);
		expect(await internals.listPassiveRlmSubagents()).toHaveLength(2);
		renameSync(`${file}.aside`, file);
		expect(await internals.listPassiveRlmSubagents()).toHaveLength(3);
		await ledger.appendDelete({ childId: "target-child-0", child: file, reason: "user" });
		expect((await internals.listPassiveRlmSubagents()).map((row) => row.entry.childId)).not.toContain(
			"target-child-0",
		);
	});
	it("invalidates display and legacy metadata without ledger changes", async () => {
		const { internals, files, root } = topologyFixture(scenario);
		const file = files.get("target-child-0")!;
		await internals.listPassiveRlmSubagents();
		rewriteDisplay(file, { status: "running", prompt: "new display prompt" });
		expect(
			(await internals.listPassiveRlmSubagents()).find((row) => row.entry.childId === "target-child-0")?.entry,
		).toMatchObject({ status: "running", prompt: "new display prompt" });
		const row = display(file);
		rmSync(join(dirname(file), "rlm-subagent.json"));
		const legacy = internals.legacyRlmSubagentRegistryPath(
			root.runtime.session.sessionFile!,
			root.runtime.session.sessionId,
		);
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(
			legacy,
			`${JSON.stringify({ ...row, parentSessionId: root.runtime.session.sessionId, status: "running", prompt: "legacy one" })}\n`,
		);
		expect(
			(await internals.listPassiveRlmSubagents()).find((item) => item.entry.childId === "target-child-0")?.entry
				.prompt,
		).toBe("legacy one");
		writeFileSync(
			legacy,
			`${JSON.stringify({ ...row, parentSessionId: root.runtime.session.sessionId, status: "completed", prompt: "legacy two" })}\n`,
		);
		expect(
			(await internals.listPassiveRlmSubagents()).find((item) => item.entry.childId === "target-child-0")?.entry,
		).toMatchObject({ status: "completed", prompt: "legacy two" });
	});
	it("keeps streamed resident transcripts out of the passive memo identity", async () => {
		const { internals, files } = topologyFixture({ ...scenario, children: 8, depth: 3, residentIndices: [0] });
		const walk = vi.spyOn(internals, "walkPassiveRlmSubagents");
		const first = await internals.listPassiveRlmSubagents();
		expect(first.map((row) => row.entry.childId)).not.toContain("target-child-0");
		expect(first.map((row) => row.entry.childId)).toContain("target-child-1");
		appendFileSync(files.get("target-child-0")!, message("resident-stream"));
		expect(await internals.listPassiveRlmSubagents()).toEqual(first);
		expect(walk).toHaveBeenCalledTimes(1);
		expect(
			new Set((await internals.listPassiveRlmSubagents(undefined, true)).map((row) => row.entry.childId)),
		).toHaveLength(8);
		expect(walk).toHaveBeenCalledTimes(2);
	});
	it("does not memoize a transient unreadable display as ledger-only defaults", async () => {
		const { internals, files } = topologyFixture({ ...scenario, children: 1 });
		const file = files.get("target-child-0")!;
		rewriteDisplay(file, { status: "running", prompt: "recoverable" });
		const walk = vi.spyOn(internals, "walkPassiveRlmSubagents");
		vi.spyOn(displayMetadata, "readRlmSubagentDisplayEntry").mockResolvedValueOnce(undefined);
		expect((await internals.listPassiveRlmSubagents())[0].entry.status).toBe("completed");
		expect((await internals.listPassiveRlmSubagents())[0].entry).toMatchObject({
			status: "running",
			prompt: "recoverable",
		});
		expect(walk).toHaveBeenCalledTimes(2);
	});
	it("does not memoize unavailable stat inputs", async () => {
		const { internals, files } = topologyFixture({ ...scenario, children: 1 });
		const path = join(dirname(files.get("target-child-0")!), "rlm-subagent.json");
		const original = internals.passiveRlmStatString.bind(internals);
		let failed = false;
		vi.spyOn(internals, "passiveRlmStatString").mockImplementation(async (file) => {
			if (file === path && !failed) {
				failed = true;
				return "unavailable";
			}
			return original(file);
		});
		const walk = vi.spyOn(internals, "walkPassiveRlmSubagents");
		await internals.listPassiveRlmSubagents();
		await internals.listPassiveRlmSubagents();
		expect(walk).toHaveBeenCalledTimes(2);
	});
	it("does not cache across ledger changes when ledger stat remains unavailable", async () => {
		const { internals, files, ledger } = topologyFixture(scenario);
		const original = internals.passiveRlmStatString.bind(internals);
		vi.spyOn(internals, "passiveRlmStatString").mockImplementation(async (file) =>
			file === ledger.ledgerPath ? "unavailable" : original(file),
		);
		const walk = vi.spyOn(internals, "walkPassiveRlmSubagents");
		expect(await internals.listPassiveRlmSubagents()).toHaveLength(3);
		await ledger.appendDelete({ childId: "target-child-0", child: files.get("target-child-0")!, reason: "user" });
		expect(await internals.listPassiveRlmSubagents()).toHaveLength(2);
		expect(walk).toHaveBeenCalledTimes(2);
	});
	it("does not publish a memo whose display changed after it was read", async () => {
		const { internals, files } = topologyFixture({ ...scenario, children: 1 });
		const file = files.get("target-child-0")!;
		let changed = false;
		const walk = vi.spyOn(internals, "walkPassiveRlmSubagents");
		vi.spyOn(displayMetadata, "readRlmSubagentDisplayEntry").mockImplementation(async (path) => {
			const result = await originalDisplayRead(path);
			if (!changed) {
				changed = true;
				rewriteDisplay(file, { status: "running", prompt: "after read" });
			}
			return result;
		});
		expect((await internals.listPassiveRlmSubagents())[0].entry.status).toBe("completed");
		expect((await internals.listPassiveRlmSubagents())[0].entry).toMatchObject({
			status: "running",
			prompt: "after read",
		});
		await internals.listPassiveRlmSubagents();
		expect(walk).toHaveBeenCalledTimes(2);
	});
	it("rechecks resident identities after asynchronous cache validation", async () => {
		const { internals, root, directory } = topologyFixture(scenario);
		await internals.listPassiveRlmSubagents();
		const replacement = topologyState(root.runtime.session.sessionId, root.runtime.session.sessionFile!, directory);
		const original = internals.passiveRlmInputStatsUnchanged.bind(internals);
		let changed = false;
		vi.spyOn(internals, "passiveRlmInputStatsUnchanged").mockImplementation(async (stats) => {
			const result = await original(stats);
			if (!changed) {
				changed = true;
				internals.sessions.set(root.activeSessionId, replacement);
			}
			return result;
		});
		expect((await internals.listPassiveRlmSubagents()).every((row) => row.rootParentState === replacement)).toBe(
			true,
		);
	});
	it("rechecks the ledger after asynchronous cache validation", async () => {
		const { internals, files, ledger } = topologyFixture(scenario);
		await internals.listPassiveRlmSubagents();
		const original = internals.passiveRlmInputStatsUnchanged.bind(internals);
		let changed = false;
		vi.spyOn(internals, "passiveRlmInputStatsUnchanged").mockImplementation(async (stats) => {
			const result = await original(stats);
			if (!changed) {
				changed = true;
				await ledger.appendDelete({
					childId: "target-child-0",
					child: files.get("target-child-0")!,
					reason: "user",
				});
			}
			return result;
		});
		expect((await internals.listPassiveRlmSubagents()).map((row) => row.entry.childId)).not.toContain(
			"target-child-0",
		);
	});
	it("refreshes saved-root identity and caller metadata for the same path", async () => {
		const { internals, root } = topologyFixture(scenario);
		const info = await readSessionInfo(root.runtime.session.sessionFile!);
		if (!info) throw new Error("Missing root metadata");
		internals.sessions.clear();
		const initial = await internals.listPassiveRlmSubagents([info]);
		expect(initial[0].entry.parentSessionId).toBe(info.id);
		const renamed = { ...info, name: "current caller name" };
		expect((await internals.listPassiveRlmSubagents([renamed]))[0].rootInfo).toBe(renamed);
		const replaced = { ...renamed, id: "new-persisted-root-id" };
		expect((await internals.listPassiveRlmSubagents([replaced]))[0].entry.parentSessionId).toBe(replaced.id);
	});
	it("tracks resident root alias retargets without watching root transcript size", async () => {
		const { internals, root, directory } = topologyFixture({ ...scenario, children: 2, unrelated: 2 });
		const sibling = [...internals.sessions.values()].find((resident) => resident !== root)!;
		const alias = join(directory, "selected-root.jsonl");
		symlinkSync(root.runtime.session.sessionFile!, alias);
		const selected = topologyState("selected", alias, directory);
		internals.sessions.clear();
		internals.sessions.set(selected.activeSessionId, selected);
		expect((await internals.listPassiveRlmSubagents()).every((row) => row.entry.childId.startsWith("target"))).toBe(
			true,
		);
		rmSync(alias);
		symlinkSync(sibling.runtime.session.sessionFile!, alias);
		expect(
			(await internals.listPassiveRlmSubagents()).every((row) => row.entry.childId.startsWith("unrelated")),
		).toBe(true);
	});
	it("tracks a writer alias even while canonical validation rejects it", async () => {
		const { internals, files, directory } = topologyFixture({ ...scenario, children: 2 });
		const file = files.get("target-child-0")!;
		const alias = join(directory, "writer-alias.jsonl");
		symlinkSync(files.get("target-child-1")!, alias);
		rewriteDisplay(file, { sessionFile: alias, sessionDir: dirname(alias) });
		expect(
			(await internals.listPassiveRlmSubagents()).find((row) => row.entry.childId === "target-child-0")?.entry
				.sessionFile,
		).toBe(file);
		rmSync(alias);
		symlinkSync(file, alias);
		expect(
			(await internals.listPassiveRlmSubagents()).find((row) => row.entry.childId === "target-child-0")?.entry
				.sessionFile,
		).toBe(alias);
	});
	it("keeps rejecting walks request scoped and recovers after repair", async () => {
		const { internals, ledger } = topologyFixture(scenario);
		await internals.listPassiveRlmSubagents();
		const intact = readFileSync(ledger.ledgerPath, "utf8");
		appendFileSync(ledger.ledgerPath, "invalid ledger row\n");
		await expect(internals.listPassiveRlmSubagents()).rejects.toThrow();
		writeFileSync(ledger.ledgerPath, intact);
		expect(await internals.listPassiveRlmSubagents()).toHaveLength(3);
	});
	it("isolates selected-subtree snapshots from an in-flight sibling scan in one worker", async () => {
		const { internals, root, childIds, files, ledger } = topologyFixture({
			name: "single-worker",
			children: 8,
			depth: 3,
			residentIndices: [0],
			unrelated: 1000,
			workerSibling: true,
		});
		const blocked = deferred();
		const release = deferred();
		const original = internals.passiveRlmSubagentEntryForEdge.bind(internals);
		let siblingReads = 0;
		vi.spyOn(internals, "passiveRlmSubagentEntryForEdge").mockImplementation(async (...args) => {
			if (args[0].childId.startsWith("unrelated")) {
				siblingReads++;
				blocked.resolve();
				await release.promise;
			}
			return original(...args);
		});
		const background = internals.listPassiveRlmSubagents();
		await blocked.promise;
		try {
			const start = performance.now();
			const snapshot = await Promise.race([
				internals.createSessionSnapshotOnce(root),
				delay(2000).then(() => {
					throw new Error("Target snapshot waited for blocked sibling scan");
				}),
			]);
			expect(snapshot.children).toHaveLength(8);
			expect(new Set(snapshot.children?.map((child) => child.id))).toEqual(new Set(childIds));
			expect(siblingReads).toBe(1);
			expect(snapshot.children?.find((child) => child.id === "target-child-1")?.parentId).toBe("target-child-0");
			const firstMs = performance.now() - start;
			const warmStart = performance.now();
			const warm = await internals.createSessionSnapshotOnce(root);
			expect(warm.children).toEqual(snapshot.children);
			expect(siblingReads).toBe(1);
			console.log(
				`PASSIVE_TOPOLOGY selected cold=${firstMs.toFixed(2)}ms warm=${(performance.now() - warmStart).toFixed(2)}ms children=8 sibling=1000`,
			);
			await ledger.appendDelete({ childId: "target-child-7", child: files.get("target-child-7")!, reason: "user" });
			expect((await internals.createSessionSnapshotOnce(root)).children?.map((child) => child.id)).not.toContain(
				"target-child-7",
			);
		} finally {
			release.resolve();
			await background;
		}
	}, 10000);
	it("preserves a 300-child deep family across resident boundaries and repeated snapshots", async () => {
		const { internals, root, childIds } = topologyFixture({
			name: "deep",
			children: 300,
			depth: 40,
			residentIndices: [9, 19, 29],
		});
		const walk = vi.spyOn(internals, "walkPassiveRlmSubagents");
		const first = await internals.createSessionSnapshotOnce(root);
		const second = await internals.createSessionSnapshotOnce(root);
		expect(new Set(first.children?.map((child) => child.id))).toEqual(new Set(childIds));
		expect(second.children).toEqual(first.children);
		expect(walk).toHaveBeenCalledTimes(1);
	});
	it("reuses a 1000-child topology without re-reading display or transcript metadata", async () => {
		const { internals } = topologyFixture({ ...scenario, children: 1000 });
		const reads = vi.spyOn(displayMetadata, "readRlmSubagentDisplayEntry");
		const start = performance.now();
		await internals.listPassiveRlmSubagents();
		const firstMs = performance.now() - start;
		expect(reads).toHaveBeenCalledTimes(1000);
		const warmStart = performance.now();
		expect(await internals.listPassiveRlmSubagents()).toHaveLength(1000);
		expect(reads).toHaveBeenCalledTimes(1000);
		console.log(
			`PASSIVE_TOPOLOGY root cold=${firstMs.toFixed(2)}ms warm=${(performance.now() - warmStart).toFixed(2)}ms children=1000`,
		);
	}, 10000);
});
