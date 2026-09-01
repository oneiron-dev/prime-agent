import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionResult } from "../src/core/compaction/compaction.js";
import { createHarness, type Harness } from "./suite/harness.js";

type DisposalInternals = {
	_disposed: boolean;
	_disposing: boolean;
	_agentEventQueue: Promise<void>;
	_ipythonKernelProvisioner?: { dispose(): Promise<void> };
	_handleAgentEvent(event: { type: string; message?: unknown }): void;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const COMPACTION_RESULT: CompactionResult = {
	summary: "compacted summary",
	firstKeptEntryId: "entry-1",
	tokensBefore: 100,
};

describe("AgentSession disposal during compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/** Session with a real model/auth whose compaction blocks on a test-controlled gate. */
	async function createSessionWithGatedCompaction() {
		const harness = await createHarness();
		harnesses.push(harness);
		const gate = deferred<CompactionResult>();
		const performSpy = vi.spyOn(harness.session as any, "_performCompaction").mockImplementation(() => gate.promise);
		const reconnectSpy = vi.spyOn(harness.session as any, "_reconnectToAgent");
		return { harness, gate, performSpy, reconnectSpy };
	}

	it("does not reconnect to agent after disposal during compaction", async () => {
		const { harness, gate, performSpy, reconnectSpy } = await createSessionWithGatedCompaction();

		const compactPromise = harness.session.compact("test instructions");
		await vi.waitFor(() => expect(performSpy).toHaveBeenCalled());

		harness.session.dispose();
		gate.resolve(COMPACTION_RESULT);
		await compactPromise.catch(() => undefined);

		expect(reconnectSpy).not.toHaveBeenCalled();
	});

	it("does not reconnect when compaction settles while disposeAsync is draining", async () => {
		const { harness, gate, performSpy, reconnectSpy } = await createSessionWithGatedCompaction();
		const session = harness.session;
		const internals = session as unknown as DisposalInternals;

		// Hold disposeAsync in the window where _disposing is set but _disposed is
		// not yet: the kernel provisioner flush is the delayed async step.
		const kernelGate = deferred<void>();
		internals._ipythonKernelProvisioner = { dispose: vi.fn(() => kernelGate.promise) };

		const compactPromise = session.compact("test instructions");
		await vi.waitFor(() => expect(performSpy).toHaveBeenCalled());

		const disposePromise = session.disposeAsync();
		await vi.waitFor(() => expect(internals._disposing).toBe(true));
		expect(internals._disposed).toBe(false);

		// The compaction settles inside the disposal window; its finally must not
		// resubscribe the session to agent events.
		gate.resolve(COMPACTION_RESULT);
		await compactPromise.catch(() => undefined);
		expect(reconnectSpy).not.toHaveBeenCalled();

		kernelGate.resolve();
		await disposePromise;
		expect(internals._disposed).toBe(true);
		expect(reconnectSpy).not.toHaveBeenCalled();
	});

	it("does not deliver agent events to subscribers after disposal when compaction completes", async () => {
		const { harness, gate, performSpy } = await createSessionWithGatedCompaction();
		const session = harness.session;
		const internals = session as unknown as DisposalInternals;

		const eventHandler = vi.fn();
		session.subscribe((event) => {
			if (event.type === "message_end") {
				eventHandler(event);
			}
		});

		const compactPromise = session.compact("test");
		await vi.waitFor(() => expect(performSpy).toHaveBeenCalled());

		session.dispose();
		gate.resolve(COMPACTION_RESULT);
		await compactPromise.catch(() => undefined);

		// Even an agent event driven through the real dispatch path after disposal
		// must not reach subscribers.
		internals._handleAgentEvent({ type: "message_end", message: fauxAssistantMessage("late") });
		await internals._agentEventQueue.catch(() => undefined);
		expect(eventHandler).not.toHaveBeenCalled();
	});
});
