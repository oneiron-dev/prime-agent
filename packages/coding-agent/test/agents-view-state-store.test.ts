import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockSync } from "proper-lockfile";
import { describe, expect, test } from "vitest";
import { AgentsViewStateStore } from "../src/core/agents-view-state-store.js";

function statePath(): string {
	return join(mkdtempSync(join(tmpdir(), "agents-view-state-")), "agents-view-state.json");
}

describe("AgentsViewStateStore", () => {
	test("roundtrips setGroupOrder, preserves trailing ids, and is idempotent", () => {
		const store = new AgentsViewStateStore(statePath());
		store.apply({ type: "setGroupOrder", group: "roots", orderedIds: ["a", "b", "c"] });
		expect(
			store.apply({ type: "setGroupOrder", group: "roots", orderedIds: ["c", "a", "a"] }).state.manualOrder.roots,
		).toEqual(["c", "a", "b"]);
		expect(
			store.apply({ type: "setGroupOrder", group: "roots", orderedIds: ["c", "a"] }).state.manualOrder.roots,
		).toEqual(["c", "a", "b"]);
	});

	test("preserves malformed and future schema bytes on load and mutate", () => {
		for (const bytes of ["{ malformed", '{"version":2,"future":true}']) {
			const path = statePath();
			writeFileSync(path, bytes);
			const store = new AgentsViewStateStore(path);
			expect(store.load().persistenceError).toBeInstanceOf(Error);
			expect(store.apply({ type: "togglePin", sessionId: "x" }).persistenceError).toBeInstanceOf(Error);
			expect(readFileSync(path, "utf8")).toBe(bytes);
		}
	});

	test("returns bounded contention failure without changing the target", () => {
		const path = statePath();
		const store = new AgentsViewStateStore(path);
		store.apply({ type: "togglePin", sessionId: "before" });
		const release = lockSync(path, { realpath: false, lockfilePath: `${path}.lock`, stale: 30_000 });
		const start = Date.now();
		const result = store.apply({ type: "togglePin", sessionId: "blocked" });
		const elapsed = Date.now() - start;
		release();
		expect(result.persistenceError).toBeInstanceOf(Error);
		expect(elapsed).toBeLessThan(1_500);
		expect(store.load().state.pinnedRootSessionIds).toEqual(["before"]);
		expect(store.apply({ type: "togglePin", sessionId: "blocked" }).state.pinnedRootSessionIds).toEqual([
			"before",
			"blocked",
		]);
	});

	test("merges interleaved independent instances without lost updates", () => {
		const path = statePath(),
			left = new AgentsViewStateStore(path),
			right = new AgentsViewStateStore(path);
		left.apply({ type: "togglePin", sessionId: "a" });
		right.apply({ type: "setGroupOrder", group: "roots", orderedIds: ["one"] });
		left.apply({ type: "togglePin", sessionId: "b" });
		right.apply({ type: "removeSession", sessionId: "one" });
		expect(left.load().state).toEqual({ version: 1, pinnedRootSessionIds: ["a", "b"], manualOrder: {} });
	});

	test("writes parsable private state with no temporary residue", () => {
		const path = statePath(),
			store = new AgentsViewStateStore(path);
		store.apply({ type: "togglePin", sessionId: "x" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
		expect(existsSync(`${path}.lock`)).toBe(false);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});
