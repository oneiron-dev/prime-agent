import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	AttachCancelledError,
	AttachLeaseRegistry,
	AttachWaitRegistry,
	attachWaiterCount,
} from "../src/modes/daemon/attach-wait.js";
import {
	createDaemonCommandEnvelope,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonResponse,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";
import { SnapshotTranscriptCache } from "../src/modes/daemon/snapshot-transcript-cache.js";
import { createDeferred } from "./suite/scheduling.js";

function client(id: string): DaemonSocketClient {
	return {
		id,
		socket: new PassThrough() as unknown as Socket,
		attachedActiveSessionIds: new Set(),
		capabilities: new Set(),
		supportsExtensionUi: false,
		catchupActiveSessionIds: new Set(),
	} as DaemonSocketClient;
}
interface Harness {
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleConnection(socket: Socket): void;
	attachWaits: AttachWaitRegistry;
	clients: Set<DaemonSocketClient>;
	write: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	findWorkerForClient: ReturnType<typeof vi.fn>;
}
function harness(ready: Promise<void> = Promise.resolve()): Harness {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		ready,
		ownership: {
			assertCurrent: async () => {},
			record: { token: "test-owner", processStartId: "test-process", socketPath: "/tmp/test.sock" },
		},
		workers: new Map(),
		clients: new Set(),
		connectionIds: new WeakMap(),
		sessionInputPauseEpochs: new WeakMap(),
		detachingInputPauseSessions: new WeakMap(),
		protocolClientIds: new WeakMap(),
		promptAdmissions: new Map(),
		sessionInputPauses: new Map(),
		mutationDrain: new MutationDrainLatch(),
		commandJournal: {
			lookup: vi.fn(),
			begin: vi.fn(() => ({ status: "new" })),
			recordResult: vi.fn(),
			acknowledge: vi.fn(),
		},
		findWorkerForClient: vi.fn(),
		write: vi.fn(() => true),
		log: vi.fn(),
		scheduleOwnedWorkerCleanupForClient: vi.fn(),
		releaseClientSessionInputPauses: vi.fn(async () => {}),
		syncWorkerExtensionUi: vi.fn(async () => {}),
		evictEmptySessionOnLastDetach: vi.fn(async () => {}),
		streamReconstructor: { seed: vi.fn() },
		publicSummary: (_worker: unknown, summary: unknown) => summary,
		requireAvailableWorkerClient: (worker: { client: unknown }) => worker.client,
	}) as Harness;
}
function line(command: DaemonCommand & { id: string }): string {
	return JSON.stringify(createDaemonCommandEnvelope(command, command.id, "viewer"));
}
async function flush(): Promise<void> {
	for (let n = 0; n < 15; n++) await Promise.resolve();
}
afterEach(() => vi.useRealTimers());

describe("attach wait ownership", () => {
	it("removes only a cancelled viewer callback from shared work", async () => {
		const work = createDeferred<number>();
		const registry = new AttachWaitRegistry();
		const a = registry.start({}, "same-id", { activeSessionId: "s", timeoutMs: 1000 });
		const b = registry.start({}, "same-id", { activeSessionId: "s", timeoutMs: 1000 });
		const first = a.wait("snapshot", () => work.promise).catch((error: unknown) => error);
		const second = b.wait("snapshot", () => work.promise);
		expect(attachWaiterCount(work.promise)).toBe(2);
		a.cancel();
		expect(await first).toBeInstanceOf(AttachCancelledError);
		expect(attachWaiterCount(work.promise)).toBe(1);
		work.resolve(7);
		expect(await second).toBe(7);
		b.finish();
		expect(attachWaiterCount(work.promise)).toBe(0);
	});

	it("keeps legacy no-deadline waits beyond 30 seconds while negotiated waits expire", async () => {
		vi.useFakeTimers();
		const registry = new AttachWaitRegistry();
		const legacy = registry.start({}, "old", { activeSessionId: "s" });
		const current = registry.start({}, "new", { activeSessionId: "s", timeoutMs: 30_000 });
		await vi.advanceTimersByTimeAsync(30_001);
		expect(legacy.signal.aborted).toBe(false);
		expect(current.signal.aborted).toBe(true);
		legacy.finish();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps successful and preexisting same-socket memberships when another viewer cancels", () => {
		const registry = new AttachLeaseRegistry();
		const owner = {};
		const members = new Set<string>();
		const target = {
			has: () => members.has("s"),
			add: () => members.add("s"),
			delete: () => {
				members.delete("s");
			},
		};
		const a = registry.acquire(owner, "s", target);
		const b = registry.acquire(owner, "s", target);
		b.commit();
		a.release();
		expect(members.has("s")).toBe(true);
		const old = registry.acquire(owner, "s", target);
		members.delete("s");
		const fresh = registry.acquire(owner, "s", target);
		old.release();
		expect(members.has("s")).toBe(true);
		fresh.release();
		expect(members.has("s")).toBe(false);
	});

	it("cancels an actual chunk waiter without poisoning another transcript reader", async () => {
		const cache = new SnapshotTranscriptCache({
			activeSessionId: "s",
			snapshotId: "snapshot",
			cacheRoot: "/tmp",
			messageCount: 1,
		});
		const abort = new AbortController();
		const first = cache.waitForChunk(0, abort.signal).catch((error: unknown) => error);
		const second = cache.waitForChunk(0);
		abort.abort(new AttachCancelledError("cancelled"));
		expect(await first).toBeInstanceOf(AttachCancelledError);
		const waiters = (cache as unknown as { chunkWaiters: Map<number, unknown[]> }).chunkWaiters;
		expect(waiters.get(0)).toHaveLength(1);
		const bytes = Buffer.from("chunk");
		cache.appendEncodedChunk(bytes);
		expect(await second).toEqual(bytes);
		cache.markComplete();
		expect(cache.complete).toBe(true);
		expect(waiters.size).toBe(0);
		cache.dispose();
	});

	it("bounds and sanitizes timing records without allowing logging errors to break observation", async () => {
		const logs: string[] = [];
		const scope = new AttachWaitRegistry().start({}, "request", {
			activeSessionId: "/private/sensitive/path",
			log: (entry) => logs.push(entry),
		});
		for (let i = 0; i < 30; i++) await scope.wait("snapshot", async () => 1);
		scope.finish();
		expect(logs.length).toBeLessThanOrEqual(41);
		expect(logs.join("")).not.toContain("/private/sensitive");
		expect(JSON.parse(logs.at(-1)!)).toMatchObject({ event: "finished", outcome: "completed" });
		const throwing = new AttachWaitRegistry().start({}, "throw", {
			activeSessionId: "s",
			log: () => {
				throw new Error("sink down");
			},
		});
		expect(await throwing.wait("admission", async () => 1)).toBe(1);
		throwing.finish();
	});
});

describe("supervisor attach cancellation", () => {
	it("registers before readiness and handles duplicate/invalid requests without unhandled rejection", async () => {
		const ready = createDeferred<void>();
		const supervisor = harness(ready.promise);
		const owner = client("viewer");
		const command = { id: "attach-1", type: "attach", activeSessionId: "s", timeoutMs: 1000 } as const;
		const pending = supervisor.handleLine(owner, line(command));
		const scope = supervisor.attachWaits.get(owner, command.id);
		expect(scope).toBeDefined();
		await expect(supervisor.handleLine(owner, line(command))).resolves.toBeUndefined();
		expect(supervisor.attachWaits.get(owner, command.id)).toBe(scope);
		await expect(
			supervisor.handleLine(owner, line({ ...command, id: "invalid", timeoutMs: 0 })),
		).resolves.toBeUndefined();
		supervisor.attachWaits.cancelClient(owner);
		await pending;
		expect(supervisor.findWorkerForClient).not.toHaveBeenCalled();
		expect(supervisor.attachWaits.get(owner, command.id)).toBeUndefined();
		ready.resolve();
	});

	it("cancels the real socket-close wait before readiness without waiting for shared work", async () => {
		const ready = createDeferred<void>();
		const supervisor = harness(ready.promise);
		const socket = new PassThrough() as unknown as Socket;
		supervisor.handleConnection(socket);
		const owner = [...supervisor.clients][0]!;
		const pending = supervisor.handleLine(owner, line({ id: "closed", type: "attach", activeSessionId: "s" }));
		expect(supervisor.attachWaits.get(owner, "closed")).toBeDefined();
		socket.emit("close");
		await pending;
		expect(supervisor.attachWaits.get(owner, "closed")).toBeUndefined();
		expect(supervisor.clients.has(owner)).toBe(false);
		expect(supervisor.findWorkerForClient).not.toHaveBeenCalled();
		ready.resolve();
	});

	it("cancels a socket's pending lookup and prevents a late worker result from attaching", async () => {
		const lookup = createDeferred<unknown>();
		const supervisor = harness();
		supervisor.findWorkerForClient.mockReturnValue(lookup.promise);
		const owner = client("viewer");
		const pending = supervisor.handleLine(
			owner,
			line({ id: "a", type: "attach", activeSessionId: "s", timeoutMs: 1000 }),
		);
		await flush();
		supervisor.attachWaits.cancelClient(owner);
		await pending;
		lookup.resolve({});
		await flush();
		expect(owner.attachedActiveSessionIds.size).toBe(0);
	});

	it("shares one worker load while cancelling one of two viewer requests", async () => {
		const supervisor = harness();
		const result = {
			activeSessionId: "s",
			lastEventSequence: 0,
			snapshot: {
				summary: { id: "s", activeSessionId: "s", messageCount: 0 },
				messages: [],
				state: {},
			},
			client: { id: "worker", capabilities: [] },
		} as unknown as DaemonAttachResult;
		const response = createDeferred<DaemonResponse>();
		const request = vi.fn(() => response.promise);
		const worker = {
			descriptor: { workerId: "w", lifecycle: "ready" },
			client: { request },
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
		};
		supervisor.findWorkerForClient.mockResolvedValue({ worker, summary: result.snapshot.summary });
		const a = client("a");
		const b = client("b");
		const first = supervisor
			.handleCommand(a, { id: "same", type: "attach", activeSessionId: "s", timeoutMs: 1000 })
			.catch((error: unknown) => error);
		const second = supervisor.handleCommand(b, { id: "same", type: "attach", activeSessionId: "s", timeoutMs: 1000 });
		await flush();
		expect(request).toHaveBeenCalledTimes(1);
		await supervisor.handleCommand(a, {
			type: "cancel_attach",
			id: "cancel",
			requestId: "same",
			activeSessionId: "s",
		});
		expect(await first).toBeInstanceOf(AttachCancelledError);
		expect(worker.snapshotLoads.size).toBe(1);
		response.resolve(success("worker", "attach", result));
		expect((await second)?.success).toBe(true);
		expect(a.attachedActiveSessionIds.size).toBe(0);
		expect(b.attachedActiveSessionIds.has("s")).toBe(true);
		await supervisor.handleCommand(b, {
			type: "cancel_attach",
			id: "late-cancel",
			requestId: "same",
			activeSessionId: "s",
		});
		expect(b.attachedActiveSessionIds.has("s")).toBe(true);
	});

	it("cancels one actual snapshot stream while the shared transcript completes for another viewer", async () => {
		const writeRecord = vi.fn(async () => true);
		const writeBuffer = vi.fn(async () => true);
		const failCache = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			writeSnapshotRecord: writeRecord,
			writeSnapshotBuffer: writeBuffer,
			failWorkerSnapshotCache: failCache,
		}) as {
			streamSnapshot(
				client: DaemonSocketClient,
				worker: unknown,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptCache,
				purpose: "attach",
				retainedRelease: undefined,
				reservationRelease: () => void,
				signal: AbortSignal,
			): Promise<boolean>;
		};
		const cache = new SnapshotTranscriptCache({
			activeSessionId: "s",
			snapshotId: "snapshot",
			cacheRoot: "/tmp",
			messageCount: 1,
		});
		const result = {
			activeSessionId: "s",
			lastEventSequence: 0,
			snapshot: { messages: [] },
			snapshotStream: { id: "snapshot", messageCount: 1, targetChunkBytes: 1024 },
		} as unknown as DaemonAttachResult;
		const a = client("a");
		const b = client("b");
		const abort = new AbortController();
		const releaseA = vi.fn();
		const releaseB = vi.fn();
		const first = supervisor.streamSnapshot(a, {}, result, cache, "attach", undefined, releaseA, abort.signal);
		const second = supervisor.streamSnapshot(
			b,
			{},
			result,
			cache,
			"attach",
			undefined,
			releaseB,
			new AbortController().signal,
		);
		await flush();
		abort.abort(new AttachCancelledError("cancelled"));
		expect(await first).toBe(false);
		cache.appendEncodedChunk(Buffer.from("chunk"));
		cache.markComplete();
		expect(await second).toBe(true);
		expect(failCache).not.toHaveBeenCalled();
		expect(
			writeRecord.mock.calls.some(
				(call) => (call as unknown as [unknown, { type: string }])[1].type === "session_snapshot_failed",
			),
		).toBe(false);
		expect(a.socket.destroyed).toBe(false);
		expect(b.socket.destroyed).toBe(false);
		expect(releaseA).toHaveBeenCalledTimes(1);
		expect(releaseB).toHaveBeenCalledTimes(1);
		cache.dispose();
	});

	it("removes backpressure listeners on viewer cancellation without closing the socket", async () => {
		const owner = client("a");
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), { writeSerialized: () => false }) as {
			writeSnapshotBuffer(client: DaemonSocketClient, bytes: Buffer, signal: AbortSignal): Promise<boolean>;
		};
		const abort = new AbortController();
		const pending = supervisor.writeSnapshotBuffer(owner, Buffer.from("snapshot"), abort.signal);
		expect(owner.socket.listenerCount("drain")).toBe(1);
		abort.abort();
		expect(await pending).toBe(false);
		expect(owner.socket.listenerCount("drain")).toBe(0);
		expect(owner.socket.destroyed).toBe(false);
	});
});
