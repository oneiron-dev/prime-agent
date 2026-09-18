import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { factoryCost, formatFactoryCost } from "../src/factory/cost.js";
import { FactoryStore } from "../src/factory/store.js";
import type { ActionSpec, FactoryCapsuleReceipt } from "../src/factory/types.js";
import type { FactoryCallCost } from "../src/factory/usage.js";

const directories: string[] = [];
const stores: FactoryStore[] = [];
const head = "a".repeat(40);
const seat = "cpa-r/muse-spark-1.3-contributor";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const evidence = { actor: "operator", reason: "Prior execution custody stopped", ref: "file:///proof.json" };
function accounting(cost_usd = 0.25): FactoryCallCost {
	return {
		calls: 1,
		usage: { input: 10, output: 5, cache_read: 2, cache_write: 1, total: 18 },
		cost_usd,
		priced: true,
	};
}
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "factory-capsule-ledger-"));
	directories.push(directory);
	const path = join(directory, "factory.db");
	const store = new FactoryStore(path);
	stores.push(store);
	const actions: ActionSpec[] = ["writer-a", "writer-b", "gate", "debug"].map((id) => {
		const ticketId = id === "debug" ? "T2" : "T1";
		const outputDirectory = join(directory, `${id}-output`);
		mkdirSync(outputDirectory);
		const manifestPath = join(directory, `${id}-manifest.json`);
		const manifest = JSON.stringify({
			version: 1,
			ticketId,
			outputDirectory,
			stage: { kind: id === "gate" ? "gate" : "writer" },
		});
		writeFileSync(manifestPath, manifest);
		writeFileSync(
			join(outputDirectory, "receipt.json"),
			JSON.stringify({
				ticketId,
				manifestSha256: sha(manifest),
				result: { writerProvenance: accounting(id === "writer-a" ? 2 : 3) },
			}),
		);
		return {
			id,
			ticketId,
			dependencies: [],
			kind: "decision",
			sourceFingerprint: `source-${id}`,
			command: {
				argv: ["adapter", "execute", manifestPath, join(directory, "permit.json"), sha(manifest), "--execute"],
				cwd: directory,
			},
			requirements: {},
		};
	});
	store.applyPlan({
		version: 1,
		tickets: [
			{ id: "T1", owner: "owner" },
			{ id: "T2", owner: "owner" },
		],
		slots: [{ id: "slot", host: "host" }],
		actions,
	});
	const capsule = (name = "capsule", cost = accounting()): FactoryCapsuleReceipt => {
		const packet = { path: join(directory, "packet.json"), sha256: sha("packet") };
		writeFileSync(packet.path, "packet");
		const bytes = JSON.stringify({
			version: 1,
			head,
			packet,
			capsule_seat: seat,
			files: [],
			tests: [],
			commands: {},
			hotspots: [],
			notes: [],
		});
		const pin = { path: join(directory, `${name}.json`), sha256: sha(bytes) };
		writeFileSync(pin.path, bytes);
		return {
			pin,
			head,
			packet,
			capsule_seat: seat,
			bytes: Buffer.byteLength(bytes),
			accounting: cost,
			wall_clock_ms: 12,
		};
	};
	const claim = (actionId = "writer-a", submit = true) => {
		const context = store.claim(actionId, "slot");
		if (!context) throw new Error("Missing fixture claim");
		if (submit) expect(store.markSubmitted(context.attempt.id)).toBe(true);
		return context.attempt.id;
	};
	const finish = (attemptId: string) =>
		store.complete({
			attemptId,
			sourceFingerprint: store.context(attemptId).action.sourceFingerprint,
			exitCode: 0,
			finishedAt: new Date().toISOString(),
		});
	return { directory, path, store, capsule, claim, finish };
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("factory capsule ledger", () => {
	it.each(["SUBMITTED", "RUNNING"])(
		"binds a capsule to a live %s attempt and derives the pin without a schema migration",
		(state) => {
			const { path, store, capsule, claim } = fixture();
			const attemptId = claim();
			if (state === "RUNNING") store.markRunning(attemptId, "boot:pid:start");
			const receipt = capsule();
			store.recordCapsule("writer-a", attemptId, receipt);
			expect(store.eventsOfKind("capsule_built")).toEqual([
				expect.objectContaining({
					actionId: "writer-a",
					attemptId,
					detail: { ...receipt, capsule_sha256: receipt.pin.sha256 },
				}),
			]);
			expect(store.context(attemptId).attempt.capsule_sha256).toBe(receipt.pin.sha256);
			const reopened = new FactoryStore(path);
			stores.push(reopened);
			expect(reopened.attempts()[0].capsule_sha256).toBe(receipt.pin.sha256);
			expect(reopened.status().schemaVersion).toBe(2);
			expect(() => reopened.recordCapsule("writer-a", attemptId, receipt)).toThrow("already bound");
			expect(() => store.recordCapsule("writer-a", attemptId, capsule("other"))).toThrow("already bound");
			expect(store.eventsOfKind("capsule_built")).toHaveLength(1);
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				expect(
					db
						.prepare("PRAGMA table_info(attempts)")
						.all()
						.map((row) => row.name),
				).not.toContain("capsule_sha256");
			} finally {
				db.close();
			}
		},
	);

	it("rejects unknown actions, attempts and cross-action bindings", () => {
		const { store, capsule, claim } = fixture();
		const receipt = capsule();
		const attemptId = claim();
		expect(() => store.recordCapsule("unknown", null, receipt)).toThrow("Unknown action");
		expect(() => store.recordCapsule("writer-a", "unknown", receipt)).toThrow("Unknown attempt");
		expect(() => store.recordCapsule("writer-b", attemptId, receipt)).toThrow("current live claimed attempt");
		expect(store.eventsOfKind("capsule_built")).toEqual([]);
	});

	it.each(["PREPARED", "UNCERTAIN", "TERMINAL", "ABANDONED"])("rejects %s attempts", (state) => {
		const { store, capsule, claim, finish } = fixture();
		const attemptId = claim("writer-a", state !== "PREPARED" && state !== "ABANDONED");
		if (state === "UNCERTAIN") store.markUncertain(attemptId, "Custody unknown");
		if (state === "TERMINAL") finish(attemptId);
		if (state === "ABANDONED") store.abandonPrepared(attemptId);
		expect(() => store.recordCapsule("writer-a", attemptId, capsule())).toThrow("current live claimed attempt");
		expect(store.eventsOfKind("capsule_built")).toEqual([]);
	});

	it("rejects a released prior attempt after retry and leaves debug events unbound", () => {
		const { store, capsule, claim } = fixture();
		const old = claim();
		store.markUncertain(old, "Custody unknown");
		store.resolveForRetry(old, evidence);
		const current = claim();
		expect(() => store.recordCapsule("writer-a", old, capsule("old"))).toThrow("current live claimed attempt");
		const debug = capsule("debug");
		store.recordCapsule("writer-a", null, debug);
		expect(store.eventsOfKind("capsule_built")[0].attemptId).toBeNull();
		expect(store.attempts().every((attempt) => attempt.capsule_sha256 === undefined)).toBe(true);
		const bound = capsule("bound");
		store.recordCapsule("writer-a", current, bound);
		expect(store.context(current).attempt.capsule_sha256).toBe(bound.pin.sha256);
		expect(store.context(old).attempt.capsule_sha256).toBeUndefined();
	});

	it.each<[string, (receipt: FactoryCapsuleReceipt) => FactoryCapsuleReceipt]>([
		[
			"packet bytes (PR #7 G2)",
			(r) => {
				writeFileSync(r.packet.path, "changed packet");
				return r;
			},
		],
		["pin hash", (r) => ({ ...r, pin: { ...r.pin, sha256: "f".repeat(64) } })],
		["relative path", (r) => ({ ...r, pin: { ...r.pin, path: "capsule.json" } })],
		["pin format", (r) => ({ ...r, pin: { ...r.pin, sha256: "bad" } })],
		["bytes", (r) => ({ ...r, bytes: r.bytes + 1 })],
		["head", (r) => ({ ...r, head: "b".repeat(40) })],
		["packet path", (r) => ({ ...r, packet: { ...r.packet, path: `${r.packet.path}.other` } })],
		["packet hash", (r) => ({ ...r, packet: { ...r.packet, sha256: "f".repeat(64) } })],
		["seat", (r) => ({ ...r, capsule_seat: "different-seat" })],
		["cost", (r) => ({ ...r, accounting: { ...r.accounting, cost_usd: -1 } })],
		["clock", (r) => ({ ...r, wall_clock_ms: -1 })],
	])("rejects mismatched %s without appending an event", (_name, alter) => {
		const { store, capsule, claim } = fixture();
		const attemptId = claim();
		const before = store.ledgerSequence();
		expect(() => store.recordCapsule("writer-a", attemptId, alter(capsule()))).toThrow();
		expect(store.ledgerSequence()).toBe(before);
		expect(store.context(attemptId).attempt.capsule_sha256).toBeUndefined();
	});

	it("bounds the disk file, accepts exactly 64 KiB, and uses UTF-8 byte counts", () => {
		const { store, capsule, claim } = fixture();
		const receipt = capsule();
		const original = readFileSync(receipt.pin.path, "utf8").replace('"notes":[]', '"notes":["日本語"]');
		const bounded = original + " ".repeat(64 * 1024 - Buffer.byteLength(original));
		writeFileSync(receipt.pin.path, `${bounded} `);
		expect(() => store.recordCapsule("writer-a", null, receipt)).toThrow("at most 65536 bytes");
		writeFileSync(receipt.pin.path, bounded);
		receipt.pin.sha256 = sha(bounded);
		receipt.bytes = Buffer.byteLength(bounded);
		const attemptId = claim();
		store.recordCapsule("writer-a", attemptId, receipt);
		expect(store.context(attemptId).attempt.capsule_sha256).toBe(receipt.pin.sha256);
	});

	it.each(["directory", "malformed", "version"])("rejects a %s capsule", (kind) => {
		const { directory, store, capsule } = fixture();
		const receipt = capsule();
		if (kind === "directory") receipt.pin.path = directory;
		else {
			const bytes =
				kind === "malformed" ? "{" : readFileSync(receipt.pin.path, "utf8").replace('"version":1', '"version":2');
			writeFileSync(receipt.pin.path, bytes);
			receipt.pin.sha256 = sha(bytes);
			receipt.bytes = Buffer.byteLength(bytes);
		}
		expect(() => store.recordCapsule("writer-a", null, receipt)).toThrow();
		expect(store.eventsOfKind("capsule_built")).toEqual([]);
	});
});

describe("factory capsule cost joins", () => {
	it("joins every writer attempt to its capsule, keeps grouped costs, and reads only the ledger", () => {
		const { directory, path, store, capsule, claim, finish } = fixture();
		const first = claim();
		const firstCapsule = capsule("first");
		store.recordCapsule("writer-a", first, firstCapsule);
		store.markUncertain(first, "Custody unknown");
		store.resolveForRetry(first, evidence);
		const second = claim();
		const secondCapsule = capsule("second", accounting(0.5));
		store.recordCapsule("writer-a", second, secondCapsule);
		const debug = capsule("debug", accounting(4));
		store.recordCapsule("debug", null, debug);
		finish(second);
		const withoutCapsule = claim("writer-b");
		finish(withoutCapsule);
		claim("gate");
		const sequence = store.ledgerSequence();
		const status = store.status();
		const events = store.allEvents();
		const before = readFileSync(path);
		const walBefore = readFileSync(`${path}-wal`);
		for (const item of [firstCapsule, secondCapsule, debug]) rmSync(item.pin.path);
		const report = factoryCost(directory);
		expect(report.attempts).toEqual([
			{
				attemptId: first,
				actionId: "writer-a",
				ticket: "T1",
				writer: null,
				capsule_sha256: firstCapsule.pin.sha256,
				capsule: { bytes: firstCapsule.bytes, seat, cost_usd: 0.25 },
			},
			{
				attemptId: second,
				actionId: "writer-a",
				ticket: "T1",
				writer: null,
				capsule_sha256: secondCapsule.pin.sha256,
				capsule: { bytes: secondCapsule.bytes, seat, cost_usd: 0.5 },
			},
			{
				attemptId: withoutCapsule,
				actionId: "writer-b",
				ticket: "T1",
				writer: accounting(3),
				capsule_sha256: null,
				capsule: null,
			},
		]);
		expect(report.rows).toEqual([
			expect.objectContaining({ ticket: "T1", seat, calls: 2, cost_usd: 0.75 }),
			expect.objectContaining({ ticket: "T1", seat: "writer", calls: 2, cost_usd: 5 }),
			expect.objectContaining({ ticket: "T2", seat, calls: 1, cost_usd: 4 }),
		]);
		expect(report.total).toEqual({
			calls: 5,
			usage: { input: 50, output: 25, cache_read: 10, cache_write: 5, total: 90 },
			cost_usd: 9.75,
			priced: true,
		});
		expect(report.missing).toEqual([]);
		expect(report.unreadable).toEqual([]);
		const text = formatFactoryCost(report);
		expect(text).toContain("TICKET\tSEAT\tCALLS");
		expect(text).toContain("ATTEMPT\tACTION\tTICKET\tCAPSULE_SHA256\tCAPSULE");
		expect(text).toContain(
			`${first}\twriter-a\tT1\t${firstCapsule.pin.sha256}\t${firstCapsule.bytes} bytes; ${seat}; $0.25000000`,
		);
		expect(text).toContain(`${withoutCapsule}\twriter-b\tT1\tnone\tnone`);
		expect(factoryCost(directory, "T1").total.cost_usd).toBe(5.75);
		expect(factoryCost(directory, "T2").attempts).toEqual([]);
		expect(factoryCost(directory, "T2").total.cost_usd).toBe(4);
		expect(factoryCost(directory, "missing").rows).toEqual([]);
		expect(store.ledgerSequence()).toBe(sequence);
		expect(store.status()).toEqual(status);
		expect(store.allEvents()).toEqual(events);
		expect(readFileSync(path)).toEqual(before);
		expect(readFileSync(`${path}-wal`)).toEqual(walBefore);
	});

	it("does not attach a debug capsule to an existing writer attempt", () => {
		const { directory, store, capsule, claim } = fixture();
		const attemptId = claim();
		store.recordCapsule("writer-a", null, capsule());
		const report = factoryCost(directory);
		expect(report.attempts).toEqual([
			{ attemptId, actionId: "writer-a", ticket: "T1", writer: accounting(2), capsule_sha256: null, capsule: null },
		]);
		expect(report.total.cost_usd).toBe(2.25);
		expect(formatFactoryCost(report)).toContain("WRITER_INPUT\tWRITER_CACHE_READ\tWRITER_COST_USD");
	});

	it("preserves unknown capsule cost rather than claiming it was free", () => {
		const { directory, store, capsule, claim } = fixture();
		const attemptId = claim();
		store.recordCapsule(
			"writer-a",
			attemptId,
			capsule("unpriced", { calls: 1, usage: null, cost_usd: null, priced: false }),
		);
		const report = factoryCost(directory);
		expect(report.attempts[0].capsule?.cost_usd).toBeNull();
		expect(report.total).toMatchObject({ calls: 2, usage: null, cost_usd: null, priced: false });
		expect(formatFactoryCost(report)).toContain(`${seat}; $unknown`);
	});
});

it("joins a failed capsule event with a null attempt hash and zero capsule bytes", () => {
	const { directory, store, claim } = fixture();
	const attemptId = claim();
	store.recordCapsule("writer-a", attemptId, {
		capsule_seat: "none",
		bytes: 0,
		failure: "Capsule does not follow symlinks",
		wall_clock_ms: 1,
		accounting: { calls: 0, usage: null, cost_usd: null, priced: false },
	});
	expect(store.context(attemptId).attempt.capsule_sha256).toBeNull();
	expect(store.eventsOfKind("capsule_built")[0].detail).not.toHaveProperty("capsule_sha256");
	expect(factoryCost(directory).attempts[0]).toMatchObject({
		attemptId,
		capsule_sha256: null,
		capsule: { bytes: 0, seat: "none", cost_usd: null },
	});
	expect(formatFactoryCost(factoryCost(directory))).toContain("0 bytes; none; $unknown");
});

it.each(
	["capsule", "writer", "management"].flatMap((source) =>
		[
			'{"calls":-1}',
			'{"calls":1.5}',
			'{"priced":"true"}',
			'{"cost_usd":1e400}',
			'{"priced":true,"cost_usd":null}',
			'{"cost_usd":"missing"}',
			'{"usage":{}}',
			'{"usage":"bad"}',
		].map((patch) => ({ source, patch })),
	),
)("PR #7: invalid $source accounting $patch is unreadable without changing totals", ({ source, patch }) => {
	const f = fixture();
	f.store.recordCapsule("debug", null, f.capsule("valid"));
	const db = new DatabaseSync(f.path);
	try {
		if (source === "capsule") f.store.recordCapsule("writer-a", null, f.capsule("invalid"));
		else {
			f.finish(f.claim());
			if (source === "management")
				f.store.claimManagement({
					id: "invalid",
					wakeId: f.store.wakes()[0].id,
					actionId: "writer-a",
					attemptId: f.store.attempts()[0].id,
					planRevision: 1,
					evidenceSha256: "proof",
				});
		}
		const persist = (cost: string) => {
			if (source === "capsule")
				db.prepare("UPDATE events SET detail=? WHERE kind='capsule_built' AND action_id='writer-a'").run(
					`{"capsule_seat":"${seat}","accounting":${cost}}`,
				);
			else if (source === "management")
				db.prepare("UPDATE management_requests SET result=? WHERE id='invalid'").run(`{"accounting":${cost}}`);
			else {
				const path = join(f.directory, "writer-a-output/receipt.json");
				const saved = JSON.parse(readFileSync(path, "utf8"));
				writeFileSync(
					path,
					JSON.stringify({ ...saved, result: {} }).replace('"result":{}', `"result":{"writerProvenance":${cost}}`),
				);
			}
		};
		persist("null");
		const before = factoryCost(f.directory);
		const invalid = { ...accounting(), ...JSON.parse(patch) };
		const encoded = JSON.stringify(invalid)
			.replace('"cost_usd":"missing",', "")
			.replace('"cost_usd":null', patch.includes("1e400") ? '"cost_usd":1e400' : '"cost_usd":null');
		persist(encoded);
		const report = factoryCost(f.directory);
		expect(report.unreadable).toHaveLength(1);
		expect(report.unreadable[0].reason).toContain(report.unreadable[0].path);
		expect(report.rows).toEqual(before.rows);
		expect(report.total).toEqual(before.total);
		expect(report.missing).toEqual([]);
	} finally {
		db.close();
	}
});

it.each([
	null,
	{ calls: -1 },
	{ calls: 1.5 },
	{ calls: Number.MAX_SAFE_INTEGER + 1 },
	{ priced: "true" },
	{ cost_usd: -1 },
	{ cost_usd: Number.POSITIVE_INFINITY },
	{ cost_usd: "bad" },
	{ priced: true, cost_usd: null },
	{ usage: {} },
	{ usage: { input: -1, output: 0, cache_read: 0, cache_write: 0, total: 0 } },
])("PR #7 Q6: refuses failed-capsule accounting %j without changing cost totals", (patch) => {
	const f = fixture();
	f.store.recordCapsule("debug", null, f.capsule("valid"));
	const attemptId = f.claim(),
		before = factoryCost(f.directory),
		sequence = f.store.ledgerSequence();
	expect(() =>
		f.store.recordCapsule("writer-a", attemptId, {
			capsule_seat: "none",
			bytes: 0,
			failure: "Capsule unavailable",
			wall_clock_ms: 1,
			accounting: (patch === null ? null : { ...accounting(), ...patch }) as FactoryCallCost,
		}),
	).toThrow();
	expect(f.store.ledgerSequence()).toBe(sequence);
	expect(factoryCost(f.directory).total).toEqual(before.total);
});
