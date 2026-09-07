import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { getProcessStartId } from "../../src/core/session-lease.js";
import { SessionManager } from "../../src/core/session-manager.js";
import {
	type DaemonWorkerFrameHeader,
	isDaemonWorkerFrameHeader,
} from "../../src/modes/daemon/daemon-worker-protocol.js";
import { encodePrivateFrame, PrivateFrameDecoder } from "../../src/modes/session-worker/private-framing.js";

const root = process.argv[2]!;
const supervisorSocket = process.argv[3]!;
const workerSocket = join(root, "old-worker.sock");
const token = randomUUID();
const manager = SessionManager.create(root, join(root, "sessions"));
manager.appendMessage({ role: "user", content: "old reader", timestamp: 1 });
manager.flushNow();
const summary = {
	id: "old-reader",
	activeSessionId: "old-reader",
	sessionId: manager.getSessionId(),
	sessionFile: manager.getSessionFile(),
	lifecycle: "live",
	activity: "idle",
	isSessionActive: false,
	cwd: root,
	isStreaming: false,
	isCompacting: false,
	attachedClients: 0,
	messageCount: 1,
	sessionActions: { queuedCount: 0, steering: [], followUps: [] },
};
const server = createServer((socket) => {
	let authenticated = false;
	const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
	const send = (outboundType: "daemon_hello" | "response", body: unknown, requestId?: string) =>
		socket.write(
			encodePrivateFrame<DaemonWorkerFrameHeader>(
				{ kind: "outbound", outboundType, requestId },
				Buffer.from(`${JSON.stringify(body)}\n`),
			),
		);
	send("daemon_hello", {
		type: "daemon_hello",
		socketPath: workerSocket,
		clientId: "old-reader",
		protocol: { name: "prime-agent.daemon", version: 7 },
		schemaRevision: 28,
		serverCapabilities: [],
	});
	socket.on("data", (chunk: Buffer) => {
		for (const frame of decoder.push(chunk)) {
			if (frame.header.kind !== "command") continue;
			const command = JSON.parse(frame.payload.toString()) as { id: string; type: string; token?: string };
			if (command.type === "worker_auth") authenticated = command.token === token;
			const data =
				command.type === "worker_auth"
					? { capabilities: ["agent_roster"] }
					: command.type === "list"
						? { sessions: [summary] }
						: summary;
			send(
				"response",
				{
					id: command.id,
					type: "response",
					command: command.type,
					success: authenticated,
					...(authenticated ? { data } : { error: "Authentication required" }),
				},
				frame.header.requestId,
			);
			if (command.type === "adopt_supervision") writeFileSync(join(root, "old-reader-was-sent-adoption"), "unsafe");
			if (authenticated && (command.type === "shutdown" || command.type === "worker_archive_and_shutdown"))
				setTimeout(() => process.exit(0), 20);
		}
	});
	socket.on("error", () => socket.destroy());
});
await new Promise<void>((done) => server.listen(workerSocket, done));
const descriptorDir = join(
	root,
	"daemon-workers",
	createHash("sha256").update(supervisorSocket).digest("hex").slice(0, 12),
);
mkdirSync(descriptorDir, { recursive: true });
const now = new Date().toISOString();
writeFileSync(
	join(descriptorDir, "old-reader.json"),
	JSON.stringify({
		version: 2,
		workerId: "old-reader",
		pid: process.pid,
		processStartId: getProcessStartId(process.pid),
		socketPath: workerSocket,
		recoveryJournalPath: join(descriptorDir, "old-reader.recovery.jsonl"),
		supervisorSocketPath: supervisorSocket,
		authenticationToken: token,
		rootActiveSessionId: "old-reader",
		rootSessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile(),
		sessionDir: join(root, "sessions"),
		createdAt: now,
		updatedAt: now,
		lifecycle: "ready",
		createCommand: { type: "create", sessionPath: manager.getSessionFile() },
		consecutiveFailures: 0,
	}),
);
writeFileSync(join(root, "old-reader.ready"), "ready");
