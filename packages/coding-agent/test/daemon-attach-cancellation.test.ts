import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_INFO, type DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";

type Reply = (data?: unknown) => void;

async function withDaemon(
	script: (command: DaemonCommand, socket: Socket, reply: Reply) => void,
	check: (client: DaemonClient, commands: DaemonCommand[]) => Promise<void>,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "prime-attach-cancel-"));
	const socketPath = join(directory, "daemon.sock");
	const sockets = new Set<Socket>();
	const commands: DaemonCommand[] = [];
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => undefined);
		socket.write(
			`${JSON.stringify({ type: "daemon_hello", protocol: DAEMON_PROTOCOL_INFO, schemaRevision: 28, serverCapabilities: ["attach_cancellation"] })}\n`,
		);
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let end = buffer.indexOf("\n");
			while (end !== -1) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				end = buffer.indexOf("\n");
				const wire = JSON.parse(line) as { id: string; command: DaemonCommand };
				if (wire.command.type === "ack_result") continue;
				commands.push(wire.command);
				script(wire.command, socket, (data) =>
					socket.write(
						`${JSON.stringify({ type: "response", id: wire.id, command: wire.command.type, success: true, data })}\n`,
					),
				);
			}
		});
	});
	await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
	const client = new DaemonClient(socketPath);
	try {
		await client.connect();
		await client.waitForHello();
		await check(client, commands);
	} finally {
		client.close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		rmSync(directory, { recursive: true, force: true });
	}
}

function summary(activeSessionId: string) {
	return { id: activeSessionId, activeSessionId, sessionId: "saved-session", sessionFile: "/tmp/saved-session.jsonl" };
}

function streamedAttach(activeSessionId: string) {
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary: summary(activeSessionId),
			state: summary(activeSessionId),
			messages: [],
			lastEventSequence: 0,
		},
		replay: { status: "complete", toSequence: 0 },
		lastEventSequence: 0,
		snapshotStream: { id: "abandoned-snapshot", messageCount: 1, targetChunkBytes: 1024 },
		client: { id: "viewer", capabilities: ["chunked_snapshot"] },
	};
}

describe("viewer-specific attach cancellation", () => {
	it("cancels an incomplete stream without detaching an existing same-session viewer", async () => {
		let attaches = 0;
		await withDaemon(
			(command, _socket, reply) => {
				if (command.type === "attach")
					reply(++attaches === 1 ? summary(command.activeSessionId) : streamedAttach(command.activeSessionId));
				else if (command.type === "get_connection_state") reply({ sessionId: "saved-session" });
				else reply({ cancelled: true });
			},
			async (client, commands) => {
				const existing = await DaemonAgentConnection.attach(client, "same-session", { directTransport: false });
				await expect(
					DaemonAgentConnection.attach(client, "same-session", { directTransport: false, snapshotTimeoutMs: 20 }),
				).rejects.toThrow("Timed out waiting for snapshot");
				await vi.waitFor(() =>
					expect(commands.filter((command) => command.type === "cancel_attach")).toHaveLength(1),
				);
				const attaches = commands.filter((command) => command.type === "attach");
				expect(commands.filter((command) => command.type === "cancel_attach")).toEqual([
					expect.objectContaining({ requestId: attaches[1]!.id, activeSessionId: "same-session" }),
				]);
				expect(commands.some((command) => command.type === "detach")).toBe(false);
				expect(client.isConnected).toBe(true);
				await expect(existing.getState()).resolves.toMatchObject({ sessionId: "saved-session" });
				await existing.dispose();
				expect(commands.filter((command) => command.type === "detach")).toHaveLength(1);
			},
		);
	});

	it("disposes a pending streamed attach with one scoped cancellation", async () => {
		await withDaemon(
			(command, _socket, reply) => {
				reply(command.type === "attach" ? streamedAttach(command.activeSessionId) : { cancelled: true });
			},
			async (client, commands) => {
				const connection = new DaemonAgentConnection(client, "pending");
				const attached = connection.attach().catch((error: unknown) => error);
				await vi.waitFor(() => expect(commands.some((command) => command.type === "attach")).toBe(true));
				await connection.dispose();
				expect(await attached).toBeInstanceOf(Error);
				await vi.waitFor(() =>
					expect(commands.filter((command) => command.type === "cancel_attach")).toHaveLength(1),
				);
				expect(commands.some((command) => command.type === "detach")).toBe(false);
				expect(client.isConnected).toBe(true);
				await expect(client.request({ type: "list" })).resolves.toMatchObject({ success: true });
			},
		);
	});

	it("bounds the complete streamed wait by the original attach deadline", async () => {
		await withDaemon(
			(command, _socket, reply) => {
				reply(command.type === "attach" ? streamedAttach(command.activeSessionId) : { cancelled: true });
			},
			async (client, commands) => {
				const request = client.request.bind(client);
				client.request = (command, timeoutMs, options) =>
					request(command, command.type === "attach" ? 30 : timeoutMs, options);
				await expect(
					DaemonAgentConnection.attach(client, "deadline", { directTransport: false, snapshotTimeoutMs: 10_000 }),
				).rejects.toThrow("Timed out waiting for snapshot");
				await vi.waitFor(() =>
					expect(commands.filter((command) => command.type === "cancel_attach")).toHaveLength(1),
				);
				expect(client.isConnected).toBe(true);
			},
		);
	});
});
