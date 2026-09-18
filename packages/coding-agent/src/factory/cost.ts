import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OneironManifest, OneironReceipt } from "./adapters/oneiron.js";
import { verifyOneironArtifact } from "./adapters/oneiron-transport.js";
import type { OneironWriterProvenance } from "./adapters/oneiron-writer.js";
import type { ManagementResult } from "./management.js";
import type { ActionSpec, FactoryCapsuleRecord } from "./types.js";
import { type FactoryCallCost, readFactoryUsage, sumFactoryCosts } from "./usage.js";

export interface FactoryCostRow extends FactoryCallCost {
	ticket: string;
	seat: string;
}
export interface FactoryUnreadableCostRow {
	status: "unreadable";
	ticket: string;
	seat: string;
	actionId: string;
	path: string;
	reason: string;
}
export interface FactoryCostAttempt {
	attemptId: string;
	actionId: string;
	ticket: string;
	writer: FactoryCallCost | null;
	capsule_sha256: string | null;
	capsule: { bytes: number; seat: string; cost_usd: number | null } | null;
}
export interface FactoryCostReport {
	attempts: FactoryCostAttempt[];
	rows: FactoryCostRow[];
	total: FactoryCallCost;
	missing: string[];
	unreadable: FactoryUnreadableCostRow[];
}
function receipt<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	if (!statSync(path).isFile() || statSync(path).size > 1_000_000) throw new Error(`Invalid cost receipt: ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function factoryCost(directory: string, ticket?: string): FactoryCostReport {
	const db = new DatabaseSync(join(directory, "factory.db"), { readOnly: true });
	const groups = new Map<string, FactoryCostRow[]>();
	const attempts: FactoryCostAttempt[] = [];
	const capsules = new Map<string, Pick<FactoryCostAttempt, "capsule_sha256" | "capsule">>();
	const missing: string[] = [];
	const unreadable: FactoryUnreadableCostRow[] = [];
	const seen = new Set<string>();
	const add = (ticketId: string, seat: string, cost: FactoryCallCost | undefined, ref: string) => {
		if (cost === undefined || cost === null) {
			missing.push(ref);
			return;
		}
		let usage: FactoryCallCost["usage"];
		try {
			if (
				!Number.isSafeInteger(cost.calls) ||
				cost.calls < 0 ||
				typeof cost.priced !== "boolean" ||
				(cost.cost_usd !== null &&
					(typeof cost.cost_usd !== "number" || !Number.isFinite(cost.cost_usd) || cost.cost_usd < 0)) ||
				(cost.priced && cost.cost_usd === null)
			)
				throw new Error("Invalid calls, price or priced flag");
			usage = cost.usage === null ? null : (readFactoryUsage(cost.usage) ?? null);
			if (cost.usage !== null && usage === null) throw new Error("Missing token usage");
		} catch (error) {
			throw new Error(`Invalid cost accounting: ${ref}`, { cause: error });
		}
		const key = JSON.stringify([ticketId, seat]);
		groups.set(key, [...(groups.get(key) ?? []), { ...cost, usage, ticket: ticketId, seat }]);
	};
	const recordUnreadable = (ticketId: string, seat: string, actionId: string, path: string, error: unknown) => {
		unreadable.push({
			status: "unreadable",
			ticket: ticketId,
			seat,
			actionId,
			path,
			reason: error instanceof Error ? error.message : String(error),
		});
	};
	try {
		db.exec("BEGIN");
		const capsuleEvents = db
			.prepare(
				"SELECT e.sequence,e.action_id,e.attempt_id,e.detail,a.ticket_id FROM events e JOIN actions a ON a.id=e.action_id WHERE e.kind='capsule_built' AND (? IS NULL OR a.ticket_id=?) ORDER BY e.sequence",
			)
			.all(ticket ?? null, ticket ?? null);
		for (const row of capsuleEvents) {
			const path = `factory:event:${String(row.sequence)}`;
			let seat = "capsule";
			try {
				const detail = JSON.parse(String(row.detail)) as FactoryCapsuleRecord & { capsule_sha256?: string };
				seat = detail.capsule_seat;
				add(String(row.ticket_id), seat, detail.accounting, path);
				if (row.attempt_id !== null)
					capsules.set(JSON.stringify([row.action_id, row.attempt_id]), {
						capsule_sha256: detail.capsule_sha256 ?? null,
						capsule: {
							bytes: detail.bytes,
							seat,
							cost_usd: detail.accounting?.priced ? detail.accounting.cost_usd : null,
						},
					});
			} catch (error) {
				recordUnreadable(String(row.ticket_id), seat, String(row.action_id), path, error);
			}
		}
		const actions = db
			.prepare(
				"SELECT * FROM actions WHERE (? IS NULL OR ticket_id=?) AND EXISTS (SELECT 1 FROM attempts WHERE action_id=actions.id)",
			)
			.all(ticket ?? null, ticket ?? null);
		for (const row of actions) {
			let path = `factory:action:${String(row.id)}`;
			try {
				const action = JSON.parse(String(row.spec)) as ActionSpec;
				const argv = action.command.argv;
				if (argv.at(-5) !== "execute" || argv.at(-1) !== "--execute") continue;
				path = argv.at(-4)!;
				verifyOneironArtifact(path, argv.at(-2));
				const manifest = receipt<OneironManifest>(path)!;
				if (manifest.stage.kind !== "writer") continue;
				const writerAttempts = db.prepare("SELECT id FROM attempts WHERE action_id=? ORDER BY rowid").all(row.id);
				for (const attempt of writerAttempts)
					attempts.push({
						attemptId: String(attempt.id),
						actionId: action.id,
						ticket: action.ticketId,
						writer: null,
						...(capsules.get(JSON.stringify([row.id, attempt.id])) ?? { capsule_sha256: null, capsule: null }),
					});
				path = join(manifest.outputDirectory, "receipt.json");
				const saved = receipt<OneironReceipt>(path);
				if (saved && (saved.ticketId !== action.ticketId || saved.manifestSha256 !== argv.at(-2)))
					throw new Error(`Cost receipt binding mismatch: ${path}`);
				if (seen.has(path)) continue;
				const cost = saved?.result.writerProvenance as OneironWriterProvenance | undefined;
				add(action.ticketId, "writer", cost, path);
				for (const attempt of attempts.filter((item) => item.actionId === action.id)) {
					if (
						writerAttempts.length === 1 ||
						(attempt.capsule_sha256 !== null && saved?.result.capsule_sha256 === attempt.capsule_sha256)
					)
						attempt.writer = cost ?? null;
				}
				seen.add(path);
			} catch (error) {
				recordUnreadable(String(row.ticket_id), "writer", String(row.id), path, error);
			}
		}
		const requests = db
			.prepare(
				"SELECT m.id,m.result,m.action_id,a.ticket_id FROM management_requests m JOIN actions a ON a.id=m.action_id WHERE m.wake_id IS NOT NULL AND (? IS NULL OR a.ticket_id=?) ORDER BY m.rowid",
			)
			.all(ticket ?? null, ticket ?? null);
		for (const row of requests) {
			const directoryPath = join(directory, "decisions", String(row.id));
			let path = join(directoryPath, "request.json");
			let seat = "management";
			try {
				seat = receipt<{ role: string }>(path)?.role ?? seat;
				let result: Pick<ManagementResult, "accounting"> | undefined;
				if (row.result === null) {
					path = join(directoryPath, "proposal.json");
					result = receipt<ManagementResult>(path);
					if (!result) {
						path = join(directoryPath, "response.json");
						result = receipt<Pick<ManagementResult, "accounting">>(path);
					}
				} else {
					path = `factory:management:${String(row.id)}`;
					result = JSON.parse(String(row.result)) as ManagementResult;
				}
				add(String(row.ticket_id), seat, result?.accounting, path);
			} catch (error) {
				recordUnreadable(String(row.ticket_id), seat, String(row.action_id), path, error);
			}
		}
		const rows = [...groups.values()]
			.map((items) => ({ ticket: items[0].ticket, seat: items[0].seat, ...sumFactoryCosts(items) }))
			.sort((a, b) => a.ticket.localeCompare(b.ticket) || a.seat.localeCompare(b.seat));
		const total = sumFactoryCosts(rows);
		if (missing.length || unreadable.length) {
			total.priced = false;
			total.cost_usd = null;
			total.usage = null;
		}
		return { rows, total, missing, unreadable, attempts };
	} finally {
		db.close();
	}
}

export function formatFactoryCost(report: FactoryCostReport): string {
	const rows = [...report.rows, { ticket: "TOTAL", seat: "*", ...report.total }];
	return [
		"TICKET\tSEAT\tCALLS\tINPUT\tOUTPUT\tCACHE_READ\tCACHE_WRITE\tTOTAL\tCOST_USD\tPRICED\tSTATUS\tPATH\tREASON",
		...rows.map((row) =>
			[
				row.ticket,
				row.seat,
				row.calls,
				row.usage?.input ?? "unknown",
				row.usage?.output ?? "unknown",
				row.usage?.cache_read ?? "unknown",
				row.usage?.cache_write ?? "unknown",
				row.usage?.total ?? "unknown",
				row.cost_usd?.toFixed(8) ?? "unknown",
				row.priced,
				"",
				"",
				"",
			].join("\t"),
		),
		...report.unreadable.map((row) =>
			[row.ticket, row.seat, ...Array<string>(7).fill("unknown"), false, row.status, row.path, row.reason]
				.map((value) => String(value).replace(/[\t\r\n]/g, " "))
				.join("\t"),
		),
		...report.missing.map((ref) => `Missing cost receipt: ${ref}`),
		`Unreadable rows: ${report.unreadable.length}`,
		"",
		"ATTEMPT\tACTION\tTICKET\tCAPSULE_SHA256\tCAPSULE\tWRITER_INPUT\tWRITER_CACHE_READ\tWRITER_COST_USD",
		...report.attempts.map((attempt) =>
			[
				attempt.attemptId,
				attempt.actionId,
				attempt.ticket,
				attempt.capsule_sha256 ?? "none",
				attempt.capsule
					? `${attempt.capsule.bytes} bytes; ${attempt.capsule.seat}; $${attempt.capsule.cost_usd?.toFixed(8) ?? "unknown"}`
					: "none",
				String(attempt.writer?.usage?.input ?? "unknown"),
				String(attempt.writer?.usage?.cache_read ?? "unknown"),
				attempt.writer?.cost_usd?.toFixed(8) ?? "unknown",
			]
				.map((value) => value.replace(/[\t\r\n]/g, " "))
				.join("\t"),
		),
	].join("\n");
}
