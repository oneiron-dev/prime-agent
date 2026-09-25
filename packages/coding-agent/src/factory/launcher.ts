import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listSplitFiles, type OneironLauncherSettings, type OneironTicketRun } from "./adapters/oneiron-ticket.js";
import type { FactoryStore } from "./store.js";
import type { ActionSpec, FactoryPlan } from "./types.js";

/** One ticket of the DAG: the wave manifest row plus its contract from the mint plan. */
export interface LauncherTicket {
	key: string;
	title: string;
	contract: string;
	acceptance: string;
	row?: string;
	tier?: string;
	blockedBy: string[];
}

function bare(identifier: string): string {
	return identifier.trim().replace(/^\(|\)$/g, "");
}
function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Read `w7-manifest.json` (tickets with blocked_by) and `mint-plan.json` (contracts). Tickets without a contract are
 * skipped. Every blocker is kept as written; `launchTickets` refuses one it cannot resolve.
 */
export function readLauncherTickets(
	manifestPath: string,
	planPath: string,
): { tickets: LauncherTicket[]; skipped: string[] } {
	const manifest = record(JSON.parse(readFileSync(manifestPath, "utf8")));
	const plan = record(JSON.parse(readFileSync(planPath, "utf8")));
	const contracts = new Map<string, Record<string, unknown>>();
	for (const entry of Array.isArray(plan.creates) ? plan.creates.map(record) : [])
		if (typeof entry.key === "string") contracts.set(entry.key, entry);
	const tickets: LauncherTicket[] = [];
	const skipped: string[] = [];
	const rows = Array.isArray(manifest.tickets) ? manifest.tickets.map(record) : [];
	for (const row of rows) {
		const key = bare(String(row.key ?? row.identifier ?? ""));
		const contract = contracts.get(key);
		if (!key || !contract || typeof contract.contract !== "string") {
			if (key) skipped.push(key);
			continue;
		}
		tickets.push({
			key,
			title: String(row.title ?? contract.title ?? key),
			contract: contract.contract,
			acceptance: typeof contract.acceptance === "string" ? contract.acceptance : "",
			row: typeof row.row === "string" ? row.row : undefined,
			tier:
				typeof row.tier === "string"
					? row.tier
					: typeof contract.review_tier === "string"
						? contract.review_tier
						: undefined,
			blockedBy: (Array.isArray(row.blocked_by) ? row.blocked_by : []).map((b: unknown) => bare(String(b))),
		});
	}
	return { tickets, skipped };
}

export function readLauncherSettings(path: string): OneironLauncherSettings {
	const value = record(JSON.parse(readFileSync(path, "utf8"))) as unknown as OneironLauncherSettings;
	for (const field of ["repo", "work"] as const)
		if (typeof value[field] !== "string" || !isAbsolute(value[field]))
			throw new Error(`launcher.${field} must be an absolute path`);
	if (value.docs !== undefined && (typeof value.docs !== "string" || !isAbsolute(value.docs)))
		throw new Error("launcher.docs must be an absolute path");
	if (typeof value.host !== "string" || !value.host.trim())
		throw new Error("launcher.host must name a configured host");
	if (value.idleMs !== undefined && (!Number.isSafeInteger(value.idleMs) || value.idleMs < 60_000))
		throw new Error("launcher.idleMs must be at least 60000; it is silence detection, never a work limit");
	const mergePolicy: unknown = value.mergePolicy;
	switch (mergePolicy) {
		case undefined:
		case "github":
		case "current-base":
			break;
		default:
			throw new Error("launcher.mergePolicy must be github or current-base");
	}
	const timeouts: unknown = value.timeouts;
	if (timeouts !== undefined) {
		if (!timeouts || typeof timeouts !== "object" || Array.isArray(timeouts))
			throw new Error("launcher.timeouts must be an object");
		for (const field of ["mergePollMs", "propagationPollMs"] as const) {
			const timeout = (timeouts as Record<string, unknown>)[field];
			if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0))
				throw new Error(`launcher.timeouts.${field} must be a positive integer`);
		}
	}
	const flags = value as unknown as Record<string, unknown>;
	for (const field of ["noStacks", "skipFactoryTests", "skipBots", "preMergeReview"])
		if (flags[field] !== undefined && typeof flags[field] !== "boolean")
			throw new Error(`launcher.${field} must be true or false`);
	// Only a lone pull request's merge waits for its required checks; a stack merge would go untested.
	if (value.skipFactoryTests && !value.noStacks)
		throw new Error(
			"launcher.skipFactoryTests needs launcher.noStacks: the required-check gate covers lone pull requests",
		);
	// Every build host without its own `jobs` takes cargoJobs, so it carries the same bounds.
	if (
		value.cargoJobs !== undefined &&
		(!Number.isSafeInteger(value.cargoJobs) || value.cargoJobs < 1 || value.cargoJobs > 64)
	)
		throw new Error("launcher.cargoJobs must be an integer from 1 to 64");
	if (value.buildHosts !== undefined) {
		if (!Array.isArray(value.buildHosts)) throw new Error("launcher.buildHosts must be an array");
		for (const host of value.buildHosts) {
			if (!host || typeof host.sshHost !== "string" || !host.sshHost.trim() || /[:;\s]/.test(host.sshHost))
				throw new Error("launcher.buildHosts[].sshHost must be `local` or an ssh destination without a colon");
			if (typeof host.root !== "string" || !isAbsolute(host.root) || host.root.includes(";"))
				throw new Error("launcher.buildHosts[].root must be an absolute path");
			for (const field of ["slots", "jobs"] as const)
				if (
					host[field] !== undefined &&
					(!Number.isSafeInteger(host[field]) || host[field]! < 1 || host[field]! > 64)
				)
					throw new Error(`launcher.buildHosts[].${field} must be an integer from 1 to 64`);
		}
	}
	return value;
}

/** The runner entry beside this module: dist/factory/adapters/oneiron-ticket-entry.js, or the .ts source under tsx. */
export function ticketEntryArgv(): string[] {
	const base = join(dirname(fileURLToPath(import.meta.url)), "adapters");
	const entry = ["oneiron-ticket-entry.js", "oneiron-ticket-entry.ts"]
		.map((name) => join(base, name))
		.find((p) => existsSync(p));
	if (!entry) throw new Error("Oneiron ticket runner entry is unavailable");
	return [process.execPath, ...process.execArgv, entry];
}

/**
 * A backstop far beyond any real ticket, never a work limit. A ticket ends because its writer finished, its tests
 * settled or a seat went silent (the runner's own idle detector), never because a clock ran out while it worked.
 */
export const SUBMIT_TIMEOUT_MS = 72 * 3_600_000;
export const MERGE_TIMEOUT_MS = 72 * 3_600_000;

/**
 * Two actions per ticket: submit (writer through bots) and merge. A blocker's merge gates the merge; its submit gates
 * the submit, or its merge under `noStacks`, so no child starts on an unmerged parent.
 */
export function launcherPlan(
	tickets: LauncherTicket[],
	settings: OneironLauncherSettings,
	entryArgv: string[],
	known: Set<string> = new Set(),
): FactoryPlan {
	const actions: ActionSpec[] = [];
	const slots: FactoryPlan["slots"] = [];
	for (const ticket of tickets) {
		const directory = join(settings.work, "tickets", ticket.key);
		mkdirSync(directory, { recursive: true });
		const run: OneironTicketRun = {
			version: 1,
			key: ticket.key,
			title: ticket.title,
			contract: ticket.contract,
			acceptance: ticket.acceptance,
			row: ticket.row,
			tier: ticket.tier,
			blockedBy: ticket.blockedBy,
			launcher: settings,
		};
		const path = join(directory, "ticket.json");
		writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
		const parents = ticket.blockedBy.filter((b) => known.has(b) || tickets.some((t) => t.key === b));
		for (const stage of ["submit", "merge"] as const) {
			const id = `${ticket.key}:${stage}`;
			slots.push({ id: `slot:${id}`, host: settings.host });
			actions.push({
				id,
				ticketId: ticket.key,
				description: `${stage} ${ticket.key}: ${ticket.title}`,
				dependencies:
					stage === "submit"
						? parents.map((p) => `${p}:${settings.noStacks ? "merge" : "submit"}`)
						: [`${ticket.key}:submit`, ...parents.map((p) => `${p}:merge`)],
				sourceFingerprint: `ticket:${ticket.key}:${stage}`,
				command: {
					argv: [...entryArgv, stage, path],
					cwd: directory,
					timeoutMs: stage === "submit" ? SUBMIT_TIMEOUT_MS : MERGE_TIMEOUT_MS,
				},
				requirements: { host: settings.host, slotId: `slot:${id}` },
			});
		}
	}
	return { version: 1, tickets: tickets.map((t) => ({ id: t.key, owner: "launcher" })), slots, actions };
}

/** Blockers that are neither a ticket of this launch nor one the factory already knows. Dropping them would start the dependent at once. */
export function missingBlockers(
	tickets: LauncherTicket[],
	known: Set<string>,
): Array<{ key: string; blocker: string }> {
	const launched = new Set(tickets.map((ticket) => ticket.key));
	return tickets.flatMap((ticket) =>
		ticket.blockedBy
			.filter((blocker) => !launched.has(blocker) && !known.has(blocker))
			.map((blocker) => ({ key: ticket.key, blocker })),
	);
}

/**
 * Import the DAG, and re-import it on every later launch. Every ticket's `ticket.json` is rewritten with today's
 * blockers and launcher settings, and every action that has not started is re-imported so a corrected dependency
 * reaches the queue. Actions that already started keep their spec; the store treats it as immutable and their
 * slot is left alone so a claimed slot is never rewritten either.
 */
export function launchTickets(
	store: FactoryStore,
	settings: OneironLauncherSettings,
	tickets: LauncherTicket[],
	entryArgv = ticketEntryArgv(),
): { imported: string[]; existing: string[]; rewritten: string[]; frozen: string[]; revision: number } {
	const known = new Set(store.tickets().map((t) => t.id));
	const missing = missingBlockers(tickets, known);
	if (missing.length)
		throw new Error(
			`launch refused, nothing was imported: ${missing.map(({ key, blocker }) => `ticket ${key} is blocked by ${blocker}, which this launch does not carry (absent from the manifest or without a contract) and the factory does not know`).join("; ")}`,
		);
	const plan = launcherPlan(tickets, settings, entryArgv, known);
	const frozen = plan.actions.filter((action) => store.actionStarted(action.id)).map((action) => action.id);
	const kept = new Set(frozen);
	const next: FactoryPlan = {
		...plan,
		actions: plan.actions.filter((action) => !kept.has(action.id)),
		slots: plan.slots.filter((slot) => !kept.has(slot.id.replace(/^slot:/, ""))),
	};
	const revision = next.actions.length ? store.applyPlan(next, store.planRevision()) : store.planRevision();
	return {
		imported: tickets.filter((t) => !known.has(t.key)).map((t) => t.key),
		existing: tickets.filter((t) => known.has(t.key)).map((t) => t.key),
		rewritten: tickets.map((t) => t.key),
		frozen,
		revision,
	};
}

/** A writer's `SPLIT:` leftover becomes one follow-up ticket blocked by its parent. The machine never judges size. */
export function importSplits(
	store: FactoryStore,
	settings: OneironLauncherSettings,
	entryArgv = ticketEntryArgv(),
): string[] {
	const known = new Set(store.tickets().map((t) => t.id));
	const imported: string[] = [];
	for (const split of listSplitFiles(settings.work)) {
		const parent = store.actions().find((a) => a.id === `${split.key}:submit`);
		if (!parent) continue;
		const key = `${split.key}-split`;
		if (known.has(key)) continue;
		const parentRun = JSON.parse(
			readFileSync(join(settings.work, "tickets", split.key, "ticket.json"), "utf8"),
		) as OneironTicketRun;
		const ticket: LauncherTicket = {
			key,
			title: `${parentRun.title} (follow-up)`,
			contract: `${split.remains}\n\nThis is the leftover the writer of ${split.key} named after finishing its own contract: ${parentRun.contract}`,
			acceptance: parentRun.acceptance,
			row: parentRun.row,
			tier: parentRun.tier,
			blockedBy: [split.key],
		};
		try {
			store.applyPlan(launcherPlan([ticket], settings, entryArgv, known), store.planRevision());
			known.add(key);
			imported.push(key);
			store.note("split_imported", `${key}:submit`, { parent: split.key, remains: split.remains });
		} catch (error) {
			store.note("split_import_failed", `${split.key}:submit`, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return imported;
}
