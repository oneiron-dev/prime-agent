import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OneironManifest, OneironReceipt } from "./adapters/oneiron.js";
import { verifyOneironArtifact } from "./adapters/oneiron-transport.js";
import type { OneironWriterProvenance } from "./adapters/oneiron-writer.js";
import type { ManagementResult } from "./management.js";
import type { ActionSpec } from "./types.js";
import { type FactoryCallCost, sumFactoryCosts } from "./usage.js";

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
export interface FactoryCostReport {
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
	const missing: string[] = [];
	const unreadable: FactoryUnreadableCostRow[] = [];
	const seen = new Set<string>();
	const add = (ticketId: string, seat: string, cost: FactoryCallCost | undefined, ref: string) => {
		if (!cost || !Number.isSafeInteger(cost.calls)) {
			missing.push(ref);
			return;
		}
		const key = JSON.stringify([ticketId, seat]);
		const items = [...(groups.get(key) ?? []), { ...cost, ticket: ticketId, seat }];
		sumFactoryCosts(items);
		groups.set(key, items);
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
				path = join(manifest.outputDirectory, "receipt.json");
				const saved = receipt<OneironReceipt>(path);
				if (saved && (saved.ticketId !== action.ticketId || saved.manifestSha256 !== argv.at(-2)))
					throw new Error(`Cost receipt binding mismatch: ${path}`);
				if (seen.has(path)) continue;
				const cost = saved?.result.writerProvenance as OneironWriterProvenance | undefined;
				add(action.ticketId, "writer", cost, path);
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
				add(String(row.ticket_id), seat, result?.accounting, directoryPath);
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
		return { rows, total, missing, unreadable };
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
	].join("\n");
}
