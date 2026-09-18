import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FactoryEngine } from "./engine.js";
import { factoryRuntimeChange, recordFactoryRuntime } from "./runtime.js";
import type { FactoryStore } from "./store.js";

function save(path: string, data: unknown): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

function saveTimestampedReceipt(directory: string, prefix: string, data: unknown): string {
	let path = "";
	const started = Date.now();
	for (let attempt = 0; attempt < 1000; attempt++) {
		const timestamp = started + attempt;
		path = join(directory, `${prefix}-${new Date(timestamp).toISOString().replaceAll(":", "-")}.json`);
		try {
			save(path, data);
			return path;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		}
	}
	throw new Error(`Receipt filename exhausted after 1000 attempts: ${path}`);
}

export function resumeFrontier(store: FactoryStore) {
	const actions = store.actions();
	const attempts = store.attempts(true);
	return {
		READY: actions.filter((a) => a.state === "READY"),
		QUEUED: actions.filter((a) => a.state === "QUEUED"),
		PREPARED: attempts.filter((a) => a.state === "PREPARED" && a.submittedAt === null),
		operatorWork: attempts.filter((a) => a.state === "UNCERTAIN"),
		wakes: store.wakes().filter((w) => w.resolvedAt === null),
	};
}

export function resumeCatchUp(store: FactoryStore) {
	const afterSequence = store.lastResumeSequence();
	const events = store.allEvents(afterSequence);
	const actions = store.actions();
	const wakes = store.wakes().filter((w) => w.resolvedAt === null);
	return {
		afterSequence,
		throughSequence: events.at(-1)?.sequence ?? afterSequence,
		tickets: store.tickets().map(({ id: ticket }) => {
			const ids = new Set(actions.filter((a) => a.ticketId === ticket).map((a) => a.id));
			const history = events.filter((e) => e.actionId !== null && ids.has(e.actionId));
			return {
				ticket,
				accepted: history.filter((e) => e.kind === "attempt_terminal" && e.detail.state === "ACCEPTED"),
				rejected: history.filter((e) => e.kind === "attempt_terminal" && e.detail.state === "REJECTED"),
				uncertain: history.filter((e) => e.kind === "attempt_uncertain"),
				openWakes: wakes.filter((w) => ids.has(w.actionId)),
			};
		}),
	};
}

/** The tree is disposable, the ledger is the state: catch up, recompute the frontier, unpause, tick once. */
export async function resumeFactory(engine: FactoryEngine, directory: string) {
	engine.requireOwnerUnpaused();
	const store = engine.store;
	let runtime_pin = store.runtimePin();
	const change = runtime_pin ? factoryRuntimeChange(runtime_pin) : "no runtime pin recorded at init";
	if (change) {
		runtime_pin = recordFactoryRuntime(directory, `runtime-${randomUUID()}.json`);
		store.repinRuntime(runtime_pin, change);
		console.log(`runtime changed since the last pin (${change}); continuing with the installed runtime`);
	}
	const catchUp = resumeCatchUp(store);
	const catchUpPath = saveTimestampedReceipt(directory, "catch-up", catchUp);
	const catch_up_sha = createHash("sha256").update(readFileSync(catchUpPath)).digest("hex");
	console.log("TICKET\tACCEPTED\tREJECTED\tUNCERTAIN\tOPEN_WAKES");
	for (const row of catchUp.tickets)
		console.log(
			[row.ticket, row.accepted.length, row.rejected.length, row.uncertain.length, row.openWakes.length].join("\t"),
		);
	const frontier = resumeFrontier(store);
	console.log(JSON.stringify({ frontier }));
	const path = saveTimestampedReceipt(directory, "resume", null);
	engine.resume();
	const tick = await engine.tick();
	const actions = store.actions();
	const counts = {
		READY: actions.filter((a) => a.state === "READY").length,
		QUEUED: actions.filter((a) => a.state === "QUEUED").length,
		RUNNING: actions.filter((a) => a.state === "RUNNING").length,
		UNCERTAIN: actions.filter((a) => a.state === "UNCERTAIN").length,
		launched: tick.launched.length,
		reconciled: tick.reconciled.length,
	};
	const incident = counts.READY > 0 && counts.RUNNING === 0;
	const detail = { counts, runtime_pin, catch_up_sha, catch_up_through: catchUp.throughSequence };
	store.recordResumed(detail, incident ? actions.find((a) => a.state === "READY")!.id : undefined);
	const report = { ...detail, catchUpPath, frontier, tick, incident: incident ? "idle_with_backlog" : null };
	try {
		writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "r+", flush: true });
	} catch (error) {
		throw new Error(`Factory is unpaused and scheduled; only the report file failed: ${path}`, { cause: error });
	}
	console.log(JSON.stringify({ ...report, path }));
	if (incident) throw new Error(`idle_with_backlog: ${JSON.stringify(counts)}`);
	return report;
}
