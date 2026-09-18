import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OneironLauncherSettings } from "../src/factory/adapters/oneiron-ticket.js";
import { importSplits, launchTickets, readLauncherTickets } from "../src/factory/launcher.js";
import { FactoryStore } from "../src/factory/store.js";

const roots: string[] = [];
const stores: FactoryStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("turns the ticket DAG into submit and merge actions, then stacks a writer's SPLIT leftover behind its parent", () => {
	const root = mkdtempSync(join(tmpdir(), "factory-launcher-"));
	roots.push(root);
	const manifest = join(root, "w7-manifest.json");
	const plan = join(root, "mint-plan.json");
	writeFileSync(
		manifest,
		JSON.stringify({
			tickets: [
				{ identifier: "(OF-1-a)", key: "OF-1-a", row: "OF-1", title: "A", tier: "two", blocked_by: [] },
				{
					identifier: "(OF-1-b)",
					key: "OF-1-b",
					row: "OF-1",
					title: "B",
					tier: "three",
					blocked_by: ["(OF-1-a)", "(OF-9-missing)"],
				},
				{ identifier: "(OF-2-c)", key: "OF-2-c", row: "OF-2", title: "C", blocked_by: [] },
			],
		}),
	);
	writeFileSync(
		plan,
		JSON.stringify({
			creates: [
				{ key: "OF-1-a", contract: "Do a.", acceptance: "a passes" },
				{ key: "OF-1-b", contract: "Do b.", acceptance: "b passes" },
			],
		}),
	);
	const { tickets, skipped } = readLauncherTickets(manifest, plan);
	expect(skipped).toEqual(["OF-2-c"]);
	expect(tickets.map((t) => [t.key, t.tier, t.blockedBy])).toEqual([
		["OF-1-a", "two", []],
		["OF-1-b", "three", ["OF-1-a"]],
	]);
	const settings: OneironLauncherSettings = { host: "arch", repo: join(root, "repo"), work: join(root, "work") };
	const store = new FactoryStore(join(root, "factory.db"));
	stores.push(store);
	store.pause("initialized");
	const entry = [process.execPath, "/entry.js"];
	const launched = launchTickets(store, settings, tickets, entry);
	expect(launched).toEqual({ imported: ["OF-1-a", "OF-1-b"], existing: [], revision: 1 });
	const actions = Object.fromEntries(store.actions().map((a) => [a.id, a]));
	expect(Object.keys(actions)).toEqual(["OF-1-a:submit", "OF-1-a:merge", "OF-1-b:submit", "OF-1-b:merge"]);
	expect(actions["OF-1-b:submit"]).toMatchObject({
		state: "QUEUED",
		dependencies: ["OF-1-a:submit"],
		requirements: { host: "arch", slotId: "slot:OF-1-b:submit" },
		command: { argv: [...entry, "submit", join(root, "work", "tickets", "OF-1-b", "ticket.json")] },
	});
	expect(actions["OF-1-b:merge"]?.dependencies).toEqual(["OF-1-b:submit", "OF-1-a:merge"]);
	expect(actions["OF-1-a:submit"]?.state).toBe("READY");
	expect(store.slots().map((s) => s.id)).toContain("slot:OF-1-a:merge");
	const run = JSON.parse(readFileSync(join(root, "work", "tickets", "OF-1-a", "ticket.json"), "utf8"));
	expect(run).toMatchObject({
		version: 1,
		key: "OF-1-a",
		contract: "Do a.",
		tier: "two",
		blockedBy: [],
		launcher: settings,
	});
	expect(launchTickets(store, settings, tickets, entry)).toEqual({
		imported: [],
		existing: ["OF-1-a", "OF-1-b"],
		revision: 1,
	});

	mkdirSync(join(root, "work", "tickets", "OF-1-a"), { recursive: true });
	writeFileSync(
		join(root, "work", "tickets", "OF-1-a", "split.json"),
		JSON.stringify({ key: "OF-1-a", remains: "the rest of a" }),
	);
	expect(importSplits(store, settings, entry)).toEqual(["OF-1-a-split"]);
	expect(importSplits(store, settings, entry)).toEqual([]);
	const split = store.actions().find((a) => a.id === "OF-1-a-split:submit");
	expect(split).toMatchObject({ ticketId: "OF-1-a-split", dependencies: ["OF-1-a:submit"] });
	expect(store.actions().find((a) => a.id === "OF-1-a-split:merge")?.dependencies).toEqual([
		"OF-1-a-split:submit",
		"OF-1-a:merge",
	]);
	const follow = JSON.parse(readFileSync(join(root, "work", "tickets", "OF-1-a-split", "ticket.json"), "utf8"));
	expect(follow.contract).toContain("the rest of a");
	expect(follow.blockedBy).toEqual(["OF-1-a"]);
	expect(existsSync(join(root, "work", "tickets", "OF-1-a-split"))).toBe(true);
	expect(store.allEvents().some((e) => e.kind === "split_imported")).toBe(true);
});
