import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonAttachRequest } from "../src/modes/daemon/daemon-client.js";
import type { DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonWorkerClient, DaemonWorkerProbeTimeoutError } from "../src/modes/daemon/daemon-worker-client.js";
import { isDaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import { encodePrivateFrame, PrivateFrameDecoder } from "../src/modes/session-worker/private-framing.js";

const netMock = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: netMock.createConnection }));

class FakeSocket extends Duplex {
	readonly commands: DaemonCommand[] = [];
	private readonly decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
	writeError?: Error;
	blockedWrite?: () => void;
	blockNextWrite = false;

	_read(): void {}

	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		for (const frame of this.decoder.push(chunk)) {
			this.commands.push(JSON.parse(frame.payload.toString("utf8")) as DaemonCommand);
		}
		if (this.blockNextWrite) {
			this.blockNextWrite = false;
			this.blockedWrite = () => callback();
		} else {
			callback(this.writeError);
		}
	}

	receive(message: { type: string; id?: string } & Record<string, unknown>): void {
		this.emit(
			"data",
			encodePrivateFrame(
				{ kind: "outbound", outboundType: message.type, requestId: message.id },
				Buffer.from(JSON.stringify(message)),
			),
		);
	}

	respond(id: string, command = "attach"): void {
		this.receive({ type: "response", id, command, success: true });
	}
}

function emitHello(socket: FakeSocket, overrides: Record<string, unknown> = {}): void {
	socket.receive({
		type: "daemon_hello",
		socketPath: "/tmp/worker-attach-cancellation.sock",
		protocol: { name: "prime-agent.daemon", version: 7 },
		schemaRevision: 28,
		appVersion: "9.9.9",
		clientId: "client-1",
		serverCapabilities: ["attach_cancellation"],
		...overrides,
	});
}

const clients: DaemonWorkerClient[] = [];

async function connect(client = new DaemonWorkerClient("/tmp/worker-attach-cancellation.sock")): Promise<{
	client: DaemonWorkerClient;
	socket: FakeSocket;
}> {
	const socket = new FakeSocket();
	netMock.createConnection.mockReturnValueOnce(socket);
	const connected = client.connect();
	socket.emit("connect");
	await connected;
	if (!clients.includes(client)) clients.push(client);
	return { client, socket };
}

beforeEach(() => {
	netMock.createConnection.mockReset();
	vi.useFakeTimers();
	vi.setSystemTime(100_000);
});

afterEach(() => {
	for (const client of clients.splice(0)) client.close();
	vi.useRealTimers();
});

describe("direct worker attach cancellation", () => {
	it("exposes the concrete request ID and deadline only after queuing its attach", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		const onAttachRequest = vi.fn((handle: DaemonAttachRequest) => {
			expect(socket.commands[0]).toMatchObject({ id: handle.id, type: "attach", timeoutMs: 500 });
		});
		const response = client.request({ type: "attach", activeSessionId: "session-1" }, 500, { onAttachRequest });
		expect(onAttachRequest).toHaveBeenCalledOnce();
		expect(onAttachRequest.mock.calls[0]![0]).toMatchObject({ id: "worker_1", deadlineAt: 100_500 });
		socket.respond("worker_1");
		await expect(response).resolves.toMatchObject({ success: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves a shorter explicit snapshot deadline", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		const onAttachRequest = vi.fn();
		const response = client.request({ type: "attach", activeSessionId: "session-1", timeoutMs: 25 }, 500, {
			onAttachRequest,
		});
		expect(socket.commands[0]).toMatchObject({ timeoutMs: 25 });
		expect(onAttachRequest.mock.calls[0]![0]).toMatchObject({ deadlineAt: 100_025 });
		socket.respond("worker_1");
		await response;
	});

	it("cancels a timed-out attach on the same live channel without disturbing other requests", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		const response = client.request({ type: "attach", activeSessionId: "session-1" }, 50);
		const timeout = expect(response).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		const other = client.request({ type: "list" }, 500);
		await vi.advanceTimersByTimeAsync(50);
		await timeout;
		expect(socket.commands.at(-1)).toEqual({
			id: "worker_3",
			type: "cancel_attach",
			requestId: "worker_1",
			activeSessionId: "session-1",
		});
		expect(client.isConnected).toBe(true);
		socket.respond("worker_2", "list");
		await expect(other).resolves.toMatchObject({ success: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("makes cancellation idempotent and rejects only the matching pending request", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		let handle: DaemonAttachRequest | undefined;
		const response = client.request({ type: "attach", activeSessionId: "session-1" }, 500, {
			onAttachRequest: (request) => {
				handle = request;
			},
		});
		const cancelled = expect(response).rejects.toThrow("Daemon attach request cancelled");
		const other = client.request({ type: "attach", activeSessionId: "session-2" }, 500);
		await Promise.all([handle!.cancel(), handle!.cancel()]);
		await cancelled;
		expect(socket.commands.filter((command) => command.type === "cancel_attach")).toEqual([
			{ id: "worker_3", type: "cancel_attach", requestId: "worker_1", activeSessionId: "session-1" },
		]);
		socket.respond("worker_2");
		await other;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the handle usable after the response while the consumer waits for a streamed snapshot", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		let handle: DaemonAttachRequest | undefined;
		const response = client.request({ type: "attach", activeSessionId: "session-1" }, 500, {
			onAttachRequest: (request) => {
				handle = request;
			},
		});
		socket.respond("worker_1");
		await response;
		await handle!.cancel();
		expect(socket.commands.at(-1)).toMatchObject({ type: "cancel_attach", requestId: "worker_1" });
		expect(client.isConnected).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("makes an old handle inert after reconnect and requires a fresh capability advertisement", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		let handle: DaemonAttachRequest | undefined;
		const first = client.request({ type: "attach", activeSessionId: "session-1" }, 500, {
			onAttachRequest: (request) => {
				handle = request;
			},
		});
		socket.respond("worker_1");
		await first;
		client.close();
		const replacement = (await connect(client)).socket;
		expect(client.hello).toBeUndefined();
		const onAttachRequest = vi.fn();
		const second = client.request({ type: "attach", activeSessionId: "session-1" }, 500, { onAttachRequest });
		await handle!.cancel();
		expect(socket.commands).toHaveLength(1);
		expect(replacement.commands).toEqual([{ id: "worker_2", type: "attach", activeSessionId: "session-1" }]);
		expect(onAttachRequest).not.toHaveBeenCalled();
		replacement.respond("worker_2");
		await second;
	});

	it("ignores late frames and cancellation handles from a disconnected socket", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		let handle: DaemonAttachRequest | undefined;
		const first = client.request({ type: "attach", activeSessionId: "session-1" }, 500, {
			onAttachRequest: (request) => {
				handle = request;
			},
		});
		const disconnected = expect(first).rejects.toThrow("lost connection");
		socket.emit("error", new Error("lost connection"));
		await disconnected;
		await handle!.cancel();
		expect(socket.commands).toHaveLength(1);
		const replacement = (await connect(client)).socket;
		emitHello(socket);
		expect(client.hello).toBeUndefined();
		const onAttachRequest = vi.fn();
		const second = client.request({ type: "attach", activeSessionId: "session-1" }, 500, { onAttachRequest });
		await handle!.cancel();
		expect(onAttachRequest).not.toHaveBeenCalled();
		expect(replacement.commands).toHaveLength(1);
		replacement.respond("worker_2");
		await second;
		socket.destroy();
	});

	it.each([
		["absent hello", undefined],
		["absent capability", { serverCapabilities: [] }],
		["old schema", { schemaRevision: 27 }],
		["absent schema", { schemaRevision: undefined }],
		["old protocol", { protocol: { name: "prime-agent.daemon", version: 6 } }],
	] as const)("keeps ordinary attachment compatible with %s", async (_label, hello) => {
		const { client, socket } = await connect();
		if (hello) emitHello(socket, hello);
		const onAttachRequest = vi.fn();
		const response = client.request({ type: "attach", activeSessionId: "session-1" }, 50, { onAttachRequest });
		const timeout = expect(response).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		await vi.advanceTimersByTimeAsync(50);
		await timeout;
		expect(socket.commands).toEqual([{ id: "worker_1", type: "attach", activeSessionId: "session-1" }]);
		expect(onAttachRequest).not.toHaveBeenCalled();
		expect(client.isConnected).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects explicit new wire features when the concrete worker lacks the capability", async () => {
		const { client, socket } = await connect();
		emitHello(socket, { schemaRevision: 27 });
		await expect(client.request({ type: "attach", activeSessionId: "session-1", timeoutMs: 500 })).rejects.toThrow(
			"does not support attach_cancellation",
		);
		await expect(
			client.request({ type: "cancel_attach", requestId: "worker_1", activeSessionId: "session-1" }),
		).rejects.toThrow("does not support attach_cancellation");
		expect(socket.commands).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not expose attach cancellation for unrelated commands", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		const onAttachRequest = vi.fn();
		const response = client.request({ type: "list" }, 50, { onAttachRequest });
		const timeout = expect(response).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		await vi.advanceTimersByTimeAsync(50);
		await timeout;
		expect(onAttachRequest).not.toHaveBeenCalled();
		expect(socket.commands).toEqual([{ id: "worker_1", type: "list" }]);
	});

	it("cleans pending state and cancels the sent attach when its consumer callback throws", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		await expect(
			client.request({ type: "attach", activeSessionId: "session-1" }, 500, {
				onAttachRequest: () => {
					throw new Error("consumer failed");
				},
			}),
		).rejects.toThrow("consumer failed");
		expect(socket.commands.map((command) => command.type)).toEqual(["attach", "cancel_attach"]);
		expect(client.isConnected).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["circular", "bigint"] as const)("rejects %s commands before registering pending state", async (kind) => {
		const { client, socket } = await connect();
		emitHello(socket);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const command = {
			type: "attach" as const,
			activeSessionId: "session-1",
			invalidPayload: kind === "circular" ? circular : 1n,
		};
		const onAttachRequest = vi.fn();
		await expect(client.request(command, 50, { onAttachRequest })).rejects.toThrow();
		expect(socket.commands).toEqual([]);
		expect(onAttachRequest).not.toHaveBeenCalled();
		expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(50);
		const response = client.request({ type: "list" });
		socket.respond("worker_2", "list");
		await expect(response).resolves.toMatchObject({ success: true });
		expect(client.isConnected).toBe(true);
	});

	it("cleans pending state when sending fails", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		socket.writeError = new Error("write failed");
		await expect(client.request({ type: "attach", activeSessionId: "session-1" }, 500)).rejects.toThrow(
			"write failed",
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("delivers the timeout even if socket backpressure has not released the attach write", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		socket.blockNextWrite = true;
		const response = client.request({ type: "attach", activeSessionId: "session-1" }, 50);
		const timeout = expect(response).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		await vi.advanceTimersByTimeAsync(50);
		await timeout;
		expect(client.isConnected).toBe(true);
		socket.blockedWrite!();
		await Promise.resolve();
		expect(socket.commands.at(-1)).toMatchObject({ type: "cancel_attach", requestId: "worker_1" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not accumulate timers or socket listeners as completed handles are discarded", async () => {
		const { client, socket } = await connect();
		emitHello(socket);
		const listeners = socket.eventNames().map((event) => [event, socket.listenerCount(event)]);
		for (let index = 0; index < 100; index++) {
			const response = client.request({ type: "attach", activeSessionId: "session-1" }, 500, {
				onAttachRequest: () => {},
			});
			socket.respond(`worker_${index + 1}`);
			await response;
		}
		expect(vi.getTimerCount()).toBe(0);
		expect(socket.eventNames().map((event) => [event, socket.listenerCount(event)])).toEqual(listeners);
	});
});
