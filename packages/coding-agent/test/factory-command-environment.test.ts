import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CommandAdapter, type CommandContext } from "../src/factory/adapters/command.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { FactoryStore } from "../src/factory/store.js";
import type { FactoryPlan } from "../src/factory/types.js";

const roots: string[] = [];
const stores: FactoryStore[] = [];
function setup() {
	const root = mkdtempSync(join(tmpdir(), "factory-environment-"));
	roots.push(root);
	const runnerRoot = join(root, "attempts");
	const store = new FactoryStore(join(root, "factory.db"));
	stores.push(store);
	const adapter = new CommandAdapter({ local: { type: "local", runnerRoot } });
	const engine = new FactoryEngine(store, adapter, { enabled: true });
	const plan: FactoryPlan = {
		version: 1,
		tickets: [{ id: "ticket", owner: "owner" }],
		slots: [{ id: "slot", host: "local" }],
		actions: [
			{
				id: "action",
				ticketId: "ticket",
				dependencies: [],
				kind: "process",
				sourceFingerprint: "opaque:input",
				requirements: {},
				command: {
					argv: [
						process.execPath,
						"-e",
						"console.log(JSON.stringify({custom:process.env.FACTORY_ENV_TEST,empty:process.env.EMPTY_TEST,attempt:process.env.PRIME_FACTORY_ATTEMPT_ID,source:process.env.PRIME_FACTORY_SOURCE_FINGERPRINT}))",
					],
					cwd: root,
				},
			},
		],
	};
	return { root, runnerRoot, store, adapter, engine, plan };
}
async function terminal(adapter: CommandAdapter, context: CommandContext) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const result = await adapter.inspect(context);
		if (result.kind === "terminal") return result.receipt;
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	throw new Error("No terminal fixture receipt");
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("persists explicit environment through journal and host manifest into the actual child without overriding runner custody", async () => {
	const f = setup();
	const literal = "literal $(not-a-shell) ' \" \n value";
	f.plan.actions[0].command.env = {
		FACTORY_ENV_TEST: literal,
		EMPTY_TEST: "",
		PRIME_FACTORY_ATTEMPT_ID: "spoof-attempt",
		PRIME_FACTORY_SOURCE_FINGERPRINT: "spoof-source",
	};
	f.engine.applyPlan(f.plan, 0);
	f.plan.actions[0].command.env.FACTORY_ENV_TEST = "mutated-after-import";
	expect(f.store.actions()[0].command.env?.FACTORY_ENV_TEST).toBe(literal);
	await f.engine.tick();
	const context = f.store.context(f.store.attempts()[0].id);
	expect((await terminal(f.adapter, context)).exitCode).toBe(0);
	const output = JSON.parse(readFileSync(join(f.runnerRoot, context.attempt.id, "stdout.log"), "utf8"));
	expect(output).toEqual({
		custom: literal,
		empty: "",
		attempt: context.attempt.id,
		source: context.action.sourceFingerprint,
	});
	const manifest = JSON.parse(readFileSync(join(f.runnerRoot, context.attempt.id, "manifest.json"), "utf8"));
	expect(manifest.command.env.FACTORY_ENV_TEST).toBe(literal);
	expect(() => f.engine.applyPlan(f.plan, 1)).toThrow("Started action is immutable");
	const changed = structuredClone(context);
	changed.action.command.env!.FACTORY_ENV_TEST = "different";
	expect((await f.adapter.launch(changed)).kind).toBe("uncertain");
});

test.each([null, [], { "BAD-NAME": "value" }, { GOOD: 1 }, { GOOD: "bad\0value" }])(
	"rejects invalid journal environment %j",
	(invalid) => {
		const f = setup();
		f.plan.actions[0].command.env = invalid as unknown as Record<string, string>;
		expect(() => f.engine.applyPlan(f.plan, 0)).toThrow("Invalid command env");
		expect(f.store.actions()).toHaveLength(0);
	},
);

test("the host validates environment even when called without the journal", async () => {
	const f = setup();
	f.engine.applyPlan(f.plan, 0);
	const claimed = f.store.claim("action", "slot")!;
	f.store.markSubmitted(claimed.attempt.id);
	const context = f.store.context(claimed.attempt.id);
	context.action.command.env = { "BAD=NAME": "value" };
	const result = await f.adapter.launch(context);
	expect(result.kind).toBe("uncertain");
	if (result.kind === "uncertain") expect(result.reason).toContain("Invalid command environment");
});
