import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentFamilyCatalogEntry, agentFamilyRelationship } from "../src/core/agent-messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import { type RlmLedgerEdge, RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { planSupervisionAdoption, type RlmSupervisionMove } from "../src/modes/daemon/rlm-supervision.js";

const publicationFailure = vi.hoisted(() => ({ failRename: false }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		renameSync: (oldPath: fs.PathLike, newPath: fs.PathLike) => {
			if (publicationFailure.failRename && String(oldPath).includes(".adopt-"))
				throw new Error("publication failed");
			return actual.renameSync(oldPath, newPath);
		},
	};
});

const roots: string[] = [];
afterEach(() => {
	publicationFailure.failRename = false;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "prime-supervision-"));
	roots.push(root);
	const sessionsDir = join(root, "sessions");
	const session = (name: string, parent?: string, depth = 0) => {
		const manager = SessionManager.create(root, parent ? join(root, "artifacts", name) : sessionsDir);
		manager.newSession(parent ? { parentSession: parent, rlmDepth: depth } : undefined);
		manager.appendSessionInfo(name);
		manager.flushNow();
		return manager.getSessionFile()!;
	};
	const board = session("board");
	const ceo = session("ceo", board, 1);
	const lane = session("lane", board, 1);
	const ticket = session("ticket", ceo, 2);
	const writer = session("writer", ticket, 3);
	const ledger = new RlmSpawnLedger(root, sessionsDir);
	for (const [child, parent, depth, name] of [
		[ceo, board, 1, "ceo"],
		[lane, board, 1, "lane"],
		[ticket, ceo, 2, "ticket"],
		[writer, ticket, 3, "writer"],
	] as const)
		await ledger.appendSpawn({ childId: `sub-${name}`, child, parent, depth, name });
	const request = {
		operationId: "owner-request-1",
		expectedRevision: (await ledger.supervisionSnapshot()).revision,
		ownerRoot: board,
		moves: [
			{ childId: "sub-lane", child: lane, expectedParent: board, parent: ceo },
			{ childId: "sub-ticket", child: ticket, expectedParent: ceo, parent: lane },
		],
	};
	const authorize = vi.fn(() => true);
	const options = { authorize, maxDepthBySession: new Map([ceo, lane, ticket, writer].map((path) => [path, 6])) };
	return { root, sessionsDir, board, ceo, lane, ticket, writer, ledger, request, options };
}

function familyEntry(row: {
	id: string;
	path: string;
	parentSessionPath?: string;
	rlmDepth?: number;
}): AgentFamilyCatalogEntry {
	return {
		id: row.id,
		sessionPath: row.path,
		parentSessionPath: row.parentSessionPath,
		depth: row.rlmDepth ?? 0,
		status: "running",
	};
}

describe("atomic native supervision ledger adoption", () => {
	it("plans all 16 existing lane coordinators and 38 ticket owners without changing identities", () => {
		const board = "/sessions/board.jsonl";
		const ceo = "/artifacts/ceo.jsonl";
		const edges: RlmLedgerEdge[] = [{ childId: "ceo", child: ceo, parent: board, depth: 1, name: "ceo" }];
		const moves: RlmSupervisionMove[] = [];
		for (let index = 0; index < 16; index++) {
			const child = `/artifacts/lane-${index}.jsonl`;
			const parent = index < 7 ? board : ceo;
			edges.push({ childId: `lane-${index}`, child, parent, depth: index < 7 ? 1 : 2, name: `lane-${index}` });
			moves.push({ childId: `lane-${index}`, child, expectedParent: parent, parent: ceo });
		}
		for (let index = 0; index < 38; index++) {
			const child = `/artifacts/ticket-${index}.jsonl`;
			const parent = index % 2 ? board : ceo;
			edges.push({ childId: `ticket-${index}`, child, parent, depth: index % 2 ? 1 : 2, name: `ticket-${index}` });
			moves.push({
				childId: `ticket-${index}`,
				child,
				expectedParent: parent,
				parent: `/artifacts/lane-${index % 16}.jsonl`,
			});
		}
		const before = structuredClone(edges);
		const changes = planSupervisionAdoption(
			{ operationId: "complete-tree", expectedRevision: "snapshot", ownerRoot: board, moves },
			edges,
			new Set([board]),
			new Map(edges.map((edge) => [edge.child, 6])),
		);
		expect(changes).toHaveLength(45);
		expect(
			changes
				.filter((change) => change.after.childId.startsWith("ticket-"))
				.every((change) => change.after.depth === 3),
		).toBe(true);
		expect(
			changes.every(
				(change) => change.before.child === change.after.child && change.before.childId === change.after.childId,
			),
		).toBe(true);
		expect(edges).toEqual(before);
	});
	it("moves existing edges and descendant depths in one durable record, preserving immutable transcripts", async () => {
		const f = await fixture();
		const before = [f.board, f.ceo, f.lane, f.ticket, f.writer].map((path) => readFileSync(path, "utf8"));
		const lineCount = readFileSync(f.ledger.ledgerPath, "utf8").trim().split("\n").length;
		const receipt = await f.ledger.adoptBatch(f.request, f.options);
		expect(receipt.previousRevision).toBe(f.request.expectedRevision);
		expect(receipt.revision).not.toBe(receipt.previousRevision);
		expect(receipt.changes).toHaveLength(3);
		expect(f.options.authorize).toHaveBeenCalledOnce();
		expect(readFileSync(f.ledger.ledgerPath, "utf8").trim().split("\n")).toHaveLength(lineCount + 1);
		expect([f.board, f.ceo, f.lane, f.ticket, f.writer].map((path) => readFileSync(path, "utf8"))).toEqual(before);
		const restored = new RlmSpawnLedger(f.root, f.sessionsDir);
		expect(await restored.edges()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ child: f.lane, parent: f.ceo, depth: 2, childId: "sub-lane" }),
				expect.objectContaining({ child: f.ticket, parent: f.lane, depth: 3, childId: "sub-ticket" }),
				expect.objectContaining({ child: f.writer, parent: f.ticket, depth: 4, childId: "sub-writer" }),
			]),
		);
		for (const reader of [f.ledger, restored]) {
			const family = (await reader.family()).map(familyEntry);
			const entry = (path: string) => family.find((row) => row.sessionPath === path)!;
			expect(agentFamilyRelationship(entry(f.ticket), entry(f.lane))).toBe("parent");
			expect(agentFamilyRelationship(entry(f.ticket), entry(f.ceo))).toBeUndefined();
			expect(agentFamilyRelationship(entry(f.lane), entry(f.board))).toBeUndefined();
		}
	});

	it("replays exact retries after restore, but rejects operation ID reuse with another payload", async () => {
		const f = await fixture();
		const first = await f.ledger.adoptBatch(f.request, f.options);
		const bytes = readFileSync(f.ledger.ledgerPath, "utf8");
		const restored = new RlmSpawnLedger(f.root, f.sessionsDir);
		expect(await restored.adoptBatch(f.request, f.options)).toEqual(first);
		expect(readFileSync(f.ledger.ledgerPath, "utf8")).toBe(bytes);
		await expect(
			restored.adoptBatch({ ...f.request, moves: f.request.moves.slice(0, 1) }, f.options),
		).rejects.toThrow("operation ID");
	});

	it("rejects stale revision and old-parent CAS without a partial change", async () => {
		const f = await fixture();
		const before = readFileSync(f.ledger.ledgerPath, "utf8");
		await expect(f.ledger.adoptBatch({ ...f.request, expectedRevision: "stale" }, f.options)).rejects.toThrow(
			"revision",
		);
		await expect(
			f.ledger.adoptBatch(
				{ ...f.request, moves: [f.request.moves[0]!, { ...f.request.moves[1]!, expectedParent: f.board }] },
				f.options,
			),
		).rejects.toThrow("parent CAS");
		expect(readFileSync(f.ledger.ledgerPath, "utf8")).toBe(before);
	});

	it("requires trusted owner authorization, including for an idempotent retry", async () => {
		const f = await fixture();
		const reject = {
			...f.options,
			authorize: () => {
				throw new Error("owner denied");
			},
		};
		await expect(f.ledger.adoptBatch(f.request, reject)).rejects.toThrow("owner denied");
		await f.ledger.adoptBatch(f.request, f.options);
		await expect(f.ledger.adoptBatch(f.request, reject)).rejects.toThrow("owner denied");
	});

	it.each(["self", "cycle", "root", "cross-root", "duplicate", "depth", "unknown-depth", "name"])(
		"rejects %s before publication",
		async (kind) => {
			const f = await fixture();
			const request = { ...f.request, moves: f.request.moves.map((move) => ({ ...move })) };
			if (kind === "self") request.moves[0]!.parent = f.lane;
			if (kind === "cycle") request.moves[0]!.parent = f.writer;
			if (kind === "root") request.moves[0]!.child = f.board;
			if (kind === "cross-root") request.ownerRoot = f.lane;
			if (kind === "duplicate") request.moves.push({ ...request.moves[0]! });
			if (kind === "depth") f.options.maxDepthBySession.set(f.writer, 3);
			if (kind === "unknown-depth") f.options.maxDepthBySession.delete(f.writer);
			if (kind === "name") await f.ledger.appendRename({ childId: "sub-lane", child: f.lane, name: "ticket" });
			if (kind === "name") {
				request.expectedRevision = (await f.ledger.supervisionSnapshot()).revision;
				request.moves = request.moves.slice(0, 1);
			}
			const before = readFileSync(f.ledger.ledgerPath, "utf8");
			await expect(f.ledger.adoptBatch(request, f.options)).rejects.toThrow();
			expect(readFileSync(f.ledger.ledgerPath, "utf8")).toBe(before);
		},
	);

	it("supports a CAS-protected inverse batch instead of rewriting history", async () => {
		const f = await fixture();
		const before = await f.ledger.edges();
		const receipt = await f.ledger.adoptBatch(f.request, f.options);
		await f.ledger.adoptBatch(
			{
				...f.request,
				operationId: "rollback-1",
				expectedRevision: receipt.revision,
				moves: f.request.moves.map((move) => ({
					...move,
					expectedParent: move.parent,
					parent: move.expectedParent,
				})),
			},
			f.options,
		);
		expect(await f.ledger.edges()).toEqual(before);
	});

	it("serializes competing writers from different ledger instances with one CAS winner", async () => {
		const f = await fixture();
		const other = new RlmSpawnLedger(f.root, f.sessionsDir);
		const results = await Promise.allSettled([
			f.ledger.adoptBatch(f.request, f.options),
			other.adoptBatch({ ...f.request, operationId: "competing" }, f.options),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});

	it("invalidates CAS for ordinary spawn, rename, and delete writers", async () => {
		const f = await fixture();
		const other = new RlmSpawnLedger(f.root, f.sessionsDir);
		await other.appendRename({ childId: "sub-writer", child: f.writer, name: "renamed" });
		await expect(f.ledger.adoptBatch(f.request, f.options)).rejects.toThrow("revision");
	});

	it("does not require unrelated missing agents to become ready", async () => {
		const f = await fixture();
		await f.ledger.appendSpawn({
			childId: "sub-unrelated",
			child: join(f.root, "missing-child.jsonl"),
			parent: join(f.sessionsDir, "missing-root.jsonl"),
			depth: 1,
			name: "unrelated",
		});
		f.request.expectedRevision = (await f.ledger.supervisionSnapshot()).revision;
		await expect(f.ledger.adoptBatch(f.request, f.options)).resolves.toMatchObject({
			operationId: f.request.operationId,
		});
	});

	it("rejects a denied authorization result without publication", async () => {
		const f = await fixture();
		await expect(f.ledger.adoptBatch(f.request, { ...f.options, authorize: () => false })).rejects.toThrow(
			"authorization",
		);
	});

	it("rolls back a failed atomic publication and permits an exact retry", async () => {
		const f = await fixture();
		const before = readFileSync(f.ledger.ledgerPath, "utf8");
		publicationFailure.failRename = true;
		await expect(f.ledger.adoptBatch(f.request, f.options)).rejects.toThrow("publication failed");
		expect(readFileSync(f.ledger.ledgerPath, "utf8")).toBe(before);
		expect(fs.readdirSync(join(f.root, "rlm-ledger")).some((name) => name.includes(".adopt-"))).toBe(false);
		publicationFailure.failRename = false;
		await expect(f.ledger.adoptBatch(f.request, f.options)).resolves.toMatchObject({
			operationId: f.request.operationId,
		});
	});

	it("rejects a stale spawn replay that would undo an adopted parent or descendant depth", async () => {
		const f = await fixture();
		const before = await f.ledger.edges();
		await f.ledger.adoptBatch(f.request, f.options);
		for (const child of [f.lane, f.writer]) {
			await expect(f.ledger.appendSpawn(before.find((edge) => edge.child === child)!)).rejects.toThrow(
				"adopted topology",
			);
		}
	});

	it("ignores a torn final batch, without applying a subset", async () => {
		const f = await fixture();
		const before = await f.ledger.edges();
		const original = readFileSync(f.ledger.ledgerPath, "utf8");
		await f.ledger.adoptBatch(f.request, f.options);
		const batch = readFileSync(f.ledger.ledgerPath, "utf8").slice(original.length);
		writeFileSync(f.ledger.ledgerPath, original + batch.slice(0, batch.length / 2));
		expect(await new RlmSpawnLedger(f.root, f.sessionsDir).edges()).toEqual(before);
	});
});
