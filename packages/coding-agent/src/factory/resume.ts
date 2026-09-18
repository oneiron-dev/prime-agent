import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rehydrateOneironContinuation } from "./adapters/oneiron-continuation.js";
import { save } from "./decision-receipt.js";
import type { FactoryEngine } from "./engine.js";
import { factoryRuntimeProcess, recordFactoryRuntime, verifyFactoryRuntimeAdmission } from "./runtime.js";
import type { FactoryStore } from "./store.js";
import { sumFactoryCosts } from "./usage.js";

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
	const requests = store.pendingResumeRequests();
	return {
		afterSequence,
		throughSequence: events.at(-1)?.sequence ?? afterSequence,
		tickets: store.tickets().map(({ id: ticket }) => {
			const ids = new Set(actions.filter((a) => a.ticketId === ticket).map((a) => a.id));
			const history = events.filter((e) => e.actionId !== null && ids.has(e.actionId));
			return {
				ticket,
				accepted: history.filter(
					(e) =>
						(e.kind === "attempt_terminal" && e.detail.state === "ACCEPTED") ||
						(e.kind === "action_decided" && e.detail.outcome === "accept"),
				),
				rejected: history.filter(
					(e) =>
						(e.kind === "attempt_terminal" && e.detail.state === "REJECTED") ||
						(e.kind === "action_decided" && e.detail.outcome === "reject"),
				),
				uncertain: history.filter((e) => ["attempt_uncertain", "runtime_mismatch"].includes(e.kind)),
				openWakes: wakes.filter((w) => ids.has(w.actionId)),
				managementRequests: requests.filter((r) => ids.has(r.actionId)),
			};
		}),
	};
}

export async function resumeFactory(engine: FactoryEngine, acceptRuntimeChange?: string) {
	engine.requireOwnerUnpaused();
	const store = engine.store;
	if (acceptRuntimeChange !== undefined && !acceptRuntimeChange.trim())
		throw new Error("Runtime change reason must be nonempty");
	let runtime_pin = store.runtimePin();
	try {
		if (!runtime_pin) throw new Error("Missing ledger runtime pin");
		verifyFactoryRuntimeAdmission(runtime_pin, factoryRuntimeProcess());
	} catch (error) {
		if (!acceptRuntimeChange)
			throw new Error(`Runtime mismatch: ${String(error)}; use --accept-runtime-change <reason>`);
		runtime_pin = recordFactoryRuntime(store.directory, `runtime-${randomUUID()}.json`);
		store.repinRuntime(runtime_pin, acceptRuntimeChange);
	}
	const catchUp = resumeCatchUp(store);
	const catchUpPath = saveTimestampedReceipt(store.directory, "catch-up", catchUp);
	const catch_up_sha = createHash("sha256").update(readFileSync(catchUpPath)).digest("hex");
	console.log("TICKET\tACCEPTED\tREJECTED\tUNCERTAIN\tOPEN_WAKES\tMANAGEMENT_REQUESTS");
	for (const row of catchUp.tickets)
		console.log(
			[
				row.ticket,
				row.accepted.length,
				row.rejected.length,
				row.uncertain.length,
				row.openWakes.length,
				row.managementRequests.length,
			].join("\t"),
		);
	const frontier = resumeFrontier(store);
	console.log(JSON.stringify({ frontier }));
	const continuation = rehydrateOneironContinuation(join(store.directory, "factory.db"));
	const path = saveTimestampedReceipt(store.directory, "resume", null);
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
	const detail = {
		counts,
		runtime_pin,
		catch_up_sha,
		catch_up_through: catchUp.throughSequence,
		accounting: sumFactoryCosts([]),
	};
	store.recordResumed(detail, incident ? actions.find((a) => a.state === "READY")!.id : undefined);
	const report = {
		...detail,
		catchUpPath,
		frontier,
		continuation,
		tick,
		incident: incident ? "idle_with_backlog" : null,
	};
	try {
		writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "r+", flush: true });
	} catch (error) {
		throw new Error(`Factory is unpaused and scheduled; only the report file failed: ${path}`, { cause: error });
	}
	console.log(JSON.stringify({ ...report, path }));
	if (incident) throw new Error(`idle_with_backlog: ${JSON.stringify(counts)}`);
	return report;
}
