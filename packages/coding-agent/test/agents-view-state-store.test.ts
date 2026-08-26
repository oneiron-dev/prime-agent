import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockSync } from "proper-lockfile";
import { describe, expect, test } from "vitest";
import { type AgentsViewStateCoordination, AgentsViewStateStore } from "../src/core/agents-view-state-store.js";

function statePath(): string {
	return join(mkdtempSync(join(tmpdir(), "agents-view-state-")), "agents-view-state.json");
}

function place(group: string, sessionId: string, neighborSessionId: string, before: boolean, baseOrder: string[]) {
	return { type: "placePeer" as const, group, sessionId, neighborSessionId, before, baseOrder };
}

describe("AgentsViewStateStore", () => {
	test("placePeer has an empty-base no-op, is idempotent, composes stale moves, and preserves hidden ids", () => {
		const path = statePath(),
			left = new AgentsViewStateStore(path),
			right = new AgentsViewStateStore(path);
		expect(left.apply(place("roots", "missing", "also-missing", true, [])).state.manualOrder.roots).toBeUndefined();
		left.apply(place("roots", "a", "b", false, ["a", "b", "c", "d", "hidden"]));
		right.apply(place("roots", "c", "d", false, ["a", "b", "c", "d"]));
		expect(left.load().state.manualOrder.roots).toEqual(["b", "a", "d", "c", "hidden"]);
		expect(right.apply(place("roots", "c", "d", false, ["a", "b", "c", "d"])).state.manualOrder.roots).toEqual([
			"b",
			"a",
			"d",
			"c",
			"hidden",
		]);
	});

	test("does not fabricate a pair absent from both stored and base orders", () => {
		const store = new AgentsViewStateStore(statePath());
		store.apply(place("roots", "a", "b", false, ["a", "b", "trail"]));
		store.apply(place("roots", "ghost", "void", true, []));
		expect(store.load().state.manualOrder.roots).toEqual(["b", "a", "trail"]);
	});

	test("preserves malformed, future, and non-object bytes fail-closed", () => {
		for (const bytes of ["{ malformed", '{"version":2,"future":true}', "null"]) {
			const path = statePath(),
				store = new AgentsViewStateStore(path);
			writeFileSync(path, bytes);
			expect(store.load().persistenceError).toBeInstanceOf(Error);
			expect(store.apply({ type: "setPin", sessionId: "x", pinned: true }).persistenceError).toBeInstanceOf(Error);
			expect(readFileSync(path, "utf8")).toBe(bytes);
		}
	});

	test("normalizes supported v1 shapes and retains __proto__ as a null-prototype own key", () => {
		const path = statePath(),
			store = new AgentsViewStateStore(path);
		writeFileSync(
			path,
			'{"version":1,"pinnedRootSessionIds":"wrong","manualOrder":{"__proto__":["x", "x", 1],"bad":"wrong"},"future":true}',
		);
		const loaded = store.load().state;
		expect(Object.getPrototypeOf(loaded.manualOrder)).toBeNull();
		expect(Object.getOwnPropertyDescriptor(loaded.manualOrder, "__proto__")?.value).toEqual(["x"]);
		store.apply({ type: "setPin", sessionId: "y", pinned: true });
		expect(
			Object.getOwnPropertyDescriptor(JSON.parse(readFileSync(path, "utf8")).manualOrder, "__proto__")?.value,
		).toEqual(["x"]);
	});

	test("returns success after an action commits even when lock release throws", () => {
		const coordination: AgentsViewStateCoordination = {
			acquire: () => () => {
				throw new Error("release failed");
			},
		};
		const path = statePath(),
			store = new AgentsViewStateStore(path, coordination);
		const result = store.apply({ type: "setPin", sessionId: "committed", pinned: true });
		expect(result.persistenceError).toBeUndefined();
		expect(JSON.parse(readFileSync(path, "utf8")).pinnedRootSessionIds).toEqual(["committed"]);
	});

	test("returns bounded contention failure without changing target", () => {
		const path = statePath(),
			store = new AgentsViewStateStore(path);
		store.apply({ type: "setPin", sessionId: "before", pinned: true });
		const release = lockSync(path, { realpath: false, lockfilePath: `${path}.lock`, stale: 30_000 });
		const start = Date.now(),
			result = store.apply({ type: "setPin", sessionId: "blocked", pinned: true });
		release();
		expect(result.persistenceError).toBeInstanceOf(Error);
		expect(Date.now() - start).toBeLessThan(1_500);
		expect(store.load().state.pinnedRootSessionIds).toEqual(["before"]);
	});

	test("round-trips collapsed sections additively and drops unknown section names", () => {
		const path = statePath(),
			store = new AgentsViewStateStore(path);
		expect(store.load().state.collapsedSections).toEqual([]);
		store.apply({ type: "setSectionCollapsed", section: "inactive", collapsed: true });
		store.apply({ type: "setSectionCollapsed", section: "pinned", collapsed: true });
		// Canonical section order, not insertion order.
		expect(store.load().state.collapsedSections).toEqual(["pinned", "inactive"]);
		store.apply({ type: "setSectionCollapsed", section: "pinned", collapsed: false });
		expect(store.load().state.collapsedSections).toEqual(["inactive"]);
		// Pins and manual order are untouched by a collapse change.
		store.apply({ type: "setPin", sessionId: "kept", pinned: true });
		expect(store.load().state.pinnedRootSessionIds).toEqual(["kept"]);
		expect(store.load().state.collapsedSections).toEqual(["inactive"]);
	});

	test("reads a v1 file without collapsedSections as fully expanded and ignores invalid entries", () => {
		const path = statePath(),
			store = new AgentsViewStateStore(path);
		writeFileSync(path, '{"version":1,"pinnedRootSessionIds":["a"],"manualOrder":{}}');
		expect(store.load().state.collapsedSections).toEqual([]);
		expect(store.load().state.pinnedRootSessionIds).toEqual(["a"]);
		writeFileSync(
			path,
			'{"version":1,"pinnedRootSessionIds":[],"manualOrder":{},"collapsedSections":["idle","bogus","idle",7]}',
		);
		expect(store.load().state.collapsedSections).toEqual(["idle"]);
	});

	test("writes parsable private state, creates a private parent, and leaves no lock or temp", () => {
		const path = join(mkdtempSync(join(tmpdir(), "agents-view-state-")), "nested", "state.json"),
			store = new AgentsViewStateStore(path);
		store.apply({ type: "setPin", sessionId: "x", pinned: true });
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
		expect(existsSync(`${path}.lock`)).toBe(false);
		expect(existsSync(`${path}.tmp`)).toBe(false);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
		}
	});
});
