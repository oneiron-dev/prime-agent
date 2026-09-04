import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AttachCancelledError, type AttachWaitRegistry, attachWaiterCount } from "../src/modes/daemon/attach-wait.js";
import { AgentDaemon, setDaemonClientSessionCapabilities } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand, DaemonResponse, DaemonSessionSnapshot } from "../src/modes/daemon/daemon-protocol.js";
import type { DaemonWorkerPeerGrant } from "../src/modes/daemon/daemon-worker-protocol.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function socket() {
	const result = Object.assign(new EventEmitter(), {
		destroyed: false,
		write: vi.fn(() => true),
		end: vi.fn(),
		destroy: vi.fn(() => {
			result.destroyed = true;
			result.emit("close");
		}),
	});
	return result;
}

function viewer(id: string): DaemonSocketClient {
	return {
		id,
		socket: socket() as unknown as Socket,
		attachedActiveSessionIds: new Set(),
		detachInput: vi.fn(),
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
}

function fixture(worker = false) {
	const daemon = new AgentDaemon("/tmp/unused-attach-test.sock", {
		defaultSessionConfig: { agentDir: "/tmp/unused-attach-test", cwd: "/tmp" },
		createRuntime: vi.fn(async () => {
			throw new Error("No provider may be started");
		}),
		...(worker ? { worker: { authenticationToken: "test-only", workerInstanceId: "worker-test" } } : {}),
	});
	const internals = daemon as unknown as {
		clients: Set<DaemonSocketClient>;
		sessions: Map<string, ActiveSessionState>;
		bindingSessions: Set<string>;
		bindingCompletions: Map<string, Promise<void>>;
		passivatingSessions: Map<string, Promise<void>>;
		closingSessions: Map<string, { promise: Promise<void>; reason: string; descendants: Set<ActiveSessionState> }>;
		peerClaims: Map<DaemonSocketClient, DaemonWorkerPeerGrant>;
		supervisorClaims: Map<DaemonSocketClient, unknown>;
		assertSupervisorClaimCurrent(): Promise<string>;
		viewerAttaches: AttachWaitRegistry;
		sessionSnapshotLoads: Map<ActiveSessionState, Promise<DaemonSessionSnapshot>>;
		createSessionSnapshotOnce(state: ActiveSessionState): Promise<DaemonSessionSnapshot>;
		findPassiveRlmSubagent(id: string): Promise<unknown>;
		hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
		handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse>;
		handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		handleConnection(socket: Socket): void;
		log(line: string): void;
	};
	internals.log = vi.fn();
	const state = {
		activeSessionId: "active",
		clients: new Set(),
		pendingAttaches: 0,
		eventGeneration: "generation",
		lastEventSequence: 0,
		extensionUiRequests: new Map(),
		runtime: {
			metadata: { kind: "subagent", createdAt: 1 },
			session: { sessionId: "session-active", sessionFile: "/tmp/active.jsonl" },
		},
	} as unknown as ActiveSessionState;
	const snapshot = {
		activeSessionId: "active",
		summary: {},
		state: {},
		messages: [],
		lastEventSequence: 0,
	} as unknown as DaemonSessionSnapshot;
	internals.sessions.set(state.activeSessionId, state);
	internals.createSessionSnapshotOnce = vi.fn(async () => snapshot);
	const attach = (client: DaemonSocketClient, id: string, timeoutMs = 30_000, chunked = false) =>
		internals.handleCommand(client, {
			type: "attach",
			id,
			activeSessionId: "active",
			timeoutMs,
			capabilities: ["slim_attach", "extension_ui", ...(chunked ? ["chunked_snapshot" as const] : [])],
		});
	const cancel = (client: DaemonSocketClient, requestId: string) =>
		internals.handleCommand(client, {
			type: "cancel_attach",
			id: `cancel-${requestId}`,
			requestId,
			activeSessionId: "active",
		});
	return { daemon, internals, state, snapshot, attach, cancel };
}

afterEach(() => vi.useRealTimers());

describe("worker viewer attach cancellation", () => {
	it("releases only the cancelled snapshot waiter and preserves a second viewer's shared load", async () => {
		const { internals, state, snapshot, attach, cancel } = fixture();
		const gate = deferred<DaemonSessionSnapshot>();
		internals.createSessionSnapshotOnce = vi.fn(() => gate.promise);
		const gone = viewer("gone");
		const retained = viewer("retained");
		const first = attach(gone, "first");
		const rejected = expect(first).rejects.toBeInstanceOf(AttachCancelledError);
		const second = attach(retained, "second");
		await vi.waitFor(() => expect(state.pendingAttaches).toBe(2));
		const shared = internals.sessionSnapshotLoads.get(state)!;
		expect(attachWaiterCount(shared)).toBe(2);
		await expect(cancel(viewer("other-socket"), "first")).resolves.toMatchObject({ data: { cancelled: false } });
		await expect(cancel(gone, "first")).resolves.toMatchObject({ data: { cancelled: true } });
		await rejected;
		expect(state.pendingAttaches).toBe(1);
		expect(attachWaiterCount(shared)).toBe(1);
		expect(internals.sessionSnapshotLoads.get(state)).toBe(shared);
		expect(gone.capabilitiesByActiveSessionId?.size ?? 0).toBe(0);
		gate.resolve(snapshot);
		await expect(second).resolves.toMatchObject({ success: true });
		expect(internals.createSessionSnapshotOnce).toHaveBeenCalledOnce();
		expect(state.clients).toEqual(new Set([retained]));
		expect(state.pendingAttaches).toBe(0);
		expect(gone.attachedActiveSessionIds.size).toBe(0);
		expect(retained.capabilitiesByActiveSessionId?.get("active")?.has("extension_ui")).toBe(true);
	});

	it("times out a viewer waiting on shared binding without cancelling that binding", async () => {
		vi.useFakeTimers();
		const { internals, state, attach } = fixture();
		const binding = deferred<void>();
		internals.bindingSessions.add("active");
		internals.bindingCompletions.set("active", binding.promise);
		const client = viewer("viewer");
		const rejected = expect(attach(client, "binding", 20)).rejects.toThrow("deadline");
		await vi.advanceTimersByTimeAsync(20);
		await rejected;
		expect(internals.bindingCompletions.get("active")).toBe(binding.promise);
		expect(internals.createSessionSnapshotOnce).not.toHaveBeenCalled();
		expect(state.clients.size).toBe(0);
		expect(client.capabilitiesByActiveSessionId?.size ?? 0).toBe(0);
		internals.bindingSessions.delete("active");
		binding.resolve();
		await expect(attach(viewer("next"), "next")).resolves.toMatchObject({ success: true });
	});

	it("abandons passivation waiting without interrupting passivation or starting late hydration", async () => {
		const { internals, state, attach, cancel } = fixture();
		const passivation = deferred<void>();
		internals.passivatingSessions.set("/tmp/active.jsonl", passivation.promise);
		internals.closingSessions.set("active", {
			promise: passivation.promise,
			reason: "shutdown",
			descendants: new Set(),
		});
		internals.findPassiveRlmSubagent = vi.fn(async () => undefined);
		const client = viewer("viewer");
		const rejected = expect(attach(client, "passivation")).rejects.toThrow("cancelled");
		await cancel(client, "passivation");
		await rejected;
		expect(internals.passivatingSessions.get("/tmp/active.jsonl")).toBe(passivation.promise);
		passivation.resolve();
		await Promise.resolve();
		expect(internals.findPassiveRlmSubagent).not.toHaveBeenCalled();
		expect(state.pendingAttaches).toBe(0);
	});

	it("does not start hydration when cancelled metadata lookup later resolves", async () => {
		const { internals, state, attach, cancel } = fixture();
		internals.sessions.clear();
		const metadata = deferred<unknown>();
		internals.findPassiveRlmSubagent = vi.fn(() => metadata.promise);
		internals.hydratePassiveRlmSubagent = vi.fn(async () => state);
		const client = viewer("viewer");
		const rejected = expect(attach(client, "metadata")).rejects.toThrow("cancelled");
		await cancel(client, "metadata");
		await rejected;
		expect(attachWaiterCount(metadata.promise)).toBe(0);
		metadata.resolve({});
		await Promise.resolve();
		expect(internals.hydratePassiveRlmSubagent).not.toHaveBeenCalled();
	});

	it("keeps already-started hydration alive after its last viewer leaves", async () => {
		const { internals, state, attach, cancel } = fixture();
		internals.sessions.clear();
		const hydration = deferred<ActiveSessionState>();
		internals.findPassiveRlmSubagent = vi.fn(async () => ({}));
		internals.hydratePassiveRlmSubagent = vi.fn(() => hydration.promise);
		const client = viewer("viewer");
		const rejected = expect(attach(client, "hydration")).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(internals.hydratePassiveRlmSubagent).toHaveBeenCalledOnce());
		await cancel(client, "hydration");
		await rejected;
		expect(attachWaiterCount(hydration.promise)).toBe(0);
		hydration.resolve(state);
		await Promise.resolve();
		expect(internals.createSessionSnapshotOnce).not.toHaveBeenCalled();
		expect(state.clients.size).toBe(0);
	});

	it("cleans a direct peer's pending attach when its socket closes", async () => {
		const { internals, state, snapshot } = fixture(true);
		const connection = socket();
		internals.handleConnection(connection as unknown as Socket);
		const client = [...internals.clients][0]!;
		client.authenticated = true;
		client.authenticationRole = "session_client";
		internals.peerClaims.set(client, {
			activeSessionId: "active",
			purpose: "session_client",
		} as DaemonWorkerPeerGrant);
		const gate = deferred<DaemonSessionSnapshot>();
		internals.createSessionSnapshotOnce = vi.fn(() => gate.promise);
		const handling = internals.handleLine(
			client,
			JSON.stringify({ type: "attach", id: "closed", activeSessionId: "active", capabilities: ["slim_attach"] }),
		);
		await vi.waitFor(() => expect(state.pendingAttaches).toBe(1));
		const shared = internals.sessionSnapshotLoads.get(state)!;
		connection.destroy();
		await handling;
		expect(state.pendingAttaches).toBe(0);
		expect(attachWaiterCount(shared)).toBe(0);
		expect(client.capabilitiesByActiveSessionId?.size ?? 0).toBe(0);
		gate.resolve(snapshot);
		await Promise.resolve();
		expect(state.clients.size).toBe(0);
		expect(client.attachedActiveSessionIds.size).toBe(0);
	});

	it("cancels a queued streamed attach without detaching an existing viewer or closing its shared socket", async () => {
		const { internals, state, attach, cancel } = fixture();
		const client = viewer("viewer");
		client.transport = "private-framed";
		state.clients.add(client);
		client.attachedActiveSessionIds.add("active");
		setDaemonClientSessionCapabilities(client, "active", new Set(["slim_attach"]));
		const previous = deferred<void>();
		client.snapshotTransferTails = new Map([["active", previous.promise]]);
		await expect(attach(client, "stream", 30_000, true)).resolves.toMatchObject({ success: true });
		await vi.waitFor(() => expect(attachWaiterCount(previous.promise)).toBe(1));
		await expect(cancel(client, "stream")).resolves.toMatchObject({ data: { cancelled: true } });
		await vi.waitFor(() => expect(client.snapshotStreaming).toBe(false));
		expect(attachWaiterCount(previous.promise)).toBe(0);
		expect(state.clients).toContain(client);
		expect(client.attachedActiveSessionIds).toContain("active");
		expect(client.capabilitiesByActiveSessionId?.get("active")).toEqual(new Set(["slim_attach"]));
		expect(client.socket.destroy).not.toHaveBeenCalled();
		expect(client.socket.end).not.toHaveBeenCalled();
		expect(client.snapshotTransferTails.get("active")).toBe(previous.promise);
		expect(internals.viewerAttaches.get(client, "stream")).toBeUndefined();
		previous.resolve();
	});

	it("cancels an owned attach before a stalled supervisor generation check completes", async () => {
		const { internals, state } = fixture(true);
		const client = viewer("supervisor");
		client.authenticated = true;
		client.authenticationRole = "supervisor";
		internals.supervisorClaims.set(client, { claim: {}, ownerFingerprint: "current" });
		const fence = deferred<string>();
		internals.assertSupervisorClaimCurrent = vi.fn(() => fence.promise);
		const handling = internals.handleLine(
			client,
			JSON.stringify({ type: "attach", id: "fenced", activeSessionId: "active" }),
		);
		expect(internals.viewerAttaches.get(client, "fenced")).toBeDefined();
		await internals.handleLine(
			client,
			JSON.stringify({ type: "cancel_attach", id: "cancel", requestId: "fenced", activeSessionId: "active" }),
		);
		await handling;
		expect(internals.assertSupervisorClaimCurrent).toHaveBeenCalledOnce();
		expect(state.clients.size).toBe(0);
		expect(client.socket.end).not.toHaveBeenCalled();
		expect(internals.supervisorClaims.has(client)).toBe(true);
		fence.resolve("current");
		await Promise.resolve();
		expect(internals.createSessionSnapshotOnce).not.toHaveBeenCalled();
	});

	it("keeps a later stream behind the first when the middle queued attach is cancelled", async () => {
		const { internals, state, attach, cancel } = fixture();
		const client = viewer("viewer");
		client.transport = "private-framed";
		const first = deferred<void>();
		client.snapshotTransferTails = new Map([["active", first.promise]]);
		await attach(client, "middle", 30_000, true);
		await vi.waitFor(() => expect(attachWaiterCount(first.promise)).toBe(1));
		const middleBarrier = client.snapshotTransferTails.get("active")!;
		await attach(client, "last", 30_000, true);
		await vi.waitFor(() => expect(attachWaiterCount(middleBarrier)).toBe(1));
		await cancel(client, "middle");
		await vi.waitFor(() => expect(attachWaiterCount(first.promise)).toBe(0));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(client.socket.write).not.toHaveBeenCalled();
		expect(attachWaiterCount(middleBarrier)).toBe(1);
		expect(state.clients).toContain(client);
		first.resolve();
		await vi.waitFor(() => expect(internals.viewerAttaches.get(client, "last")).toBeUndefined());
		expect(client.socket.write).toHaveBeenCalled();
		expect(state.clients).toContain(client);
		expect(client.snapshotStreaming).toBe(false);
	});

	it("commits a delivered stream and treats later cancellation as a no-op", async () => {
		const { internals, state, attach, cancel } = fixture();
		const client = viewer("viewer");
		client.transport = "private-framed";
		await attach(client, "complete", 30_000, true);
		await vi.waitFor(() => expect(internals.viewerAttaches.get(client, "complete")).toBeUndefined());
		expect(state.clients).toContain(client);
		expect(client.capabilitiesByActiveSessionId?.get("active")?.has("extension_ui")).toBe(true);
		await expect(cancel(client, "complete")).resolves.toMatchObject({ data: { cancelled: false } });
		expect(state.clients).toContain(client);
	});
});
