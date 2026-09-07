import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import type { DaemonCommand, DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { writeRlmSubagentDisplayEntry } from "../src/modes/daemon/rlm-subagent-display.js";
import { normalizeSupervisionRequest } from "../src/modes/daemon/rlm-supervision.js";

const cli = resolve(__dirname, "../src/cli.ts");
const tsx = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const extension = resolve(__dirname, "fixtures/native-supervision-faux-extension.ts");
const roots: string[] = [];
const children = new Set<ChildProcess>();
const clients = new Set<DaemonClient>();
const sockets = new Set<string>();
const diagnostics = new Map<ChildProcess, string>();

function start(args: string[], root: string): ChildProcess {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("PRIME_AGENT_INTERNAL_") || key.startsWith("RLM_") || key.endsWith("SESSION_DIR"))
			delete env[key];
	}
	const child = spawn(process.execPath, args, {
		cwd: root,
		env: {
			...env,
			[ENV_AGENT_DIR]: root,
			TMPDIR: "/tmp",
			NATIVE_SUPERVISION_PROCESS_ROOT: root,
			PI_OFFLINE: "1",
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR: join(root, "owners"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	diagnostics.set(child, "");
	for (const stream of [child.stdout, child.stderr])
		stream?.on("data", (chunk: Buffer) => diagnostics.set(child, diagnostics.get(child) + chunk.toString()));
	return child;
}
async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 20_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((done) => setTimeout(done, 25));
	}
	throw new Error(`Condition timed out\n${[...diagnostics.values()].join("\n")}`);
}
async function connect(socket: string): Promise<DaemonClient> {
	let result: DaemonClient | undefined;
	await waitUntil(async () => {
		const client = new DaemonClient(socket);
		try {
			await client.connect(200);
			await client.waitForHello(1000);
			result = client;
			return true;
		} catch {
			client.close();
			return false;
		}
	});
	clients.add(result!);
	return result!;
}
function data<T>(response: DaemonResponse): T {
	if (!response.success) throw new Error(response.error);
	return response.data as T;
}
function descriptor(root: string): DaemonWorkerDescriptor {
	const dir = join(root, "daemon-workers");
	for (const shard of readdirSync(dir))
		for (const file of readdirSync(join(dir, shard))) {
			if (file.endsWith(".json"))
				return JSON.parse(readFileSync(join(dir, shard, file), "utf8")) as DaemonWorkerDescriptor;
		}
	throw new Error("No worker descriptor");
}
async function fixture(oldReader = false) {
	const root = mkdtempSync(join(tmpdir().length > 40 ? "/tmp" : tmpdir(), "prime-supervision-process-"));
	roots.push(root);
	const socket = join(root, "daemon.sock");
	sockets.add(socket);
	const sessionDir = join(root, "sessions");
	const board = SessionManager.create(root, sessionDir);
	board.appendMessage({ role: "user", content: "board fixture", timestamp: 1 });
	board.flushNow();
	const boardFile = board.getSessionFile()!;
	const artifact = board.getSessionArtifactDir()!;
	const makeChild = (name: string) => {
		const child = SessionManager.create(root, join(artifact, name));
		child.newSession({ parentSession: boardFile, rlmDepth: 1 });
		child.appendSessionInfo(name);
		child.appendMessage({ role: "user", content: name, timestamp: 2 });
		child.flushNow();
		return child;
	};
	const ceo = makeChild("ceo");
	const ticket = makeChild("ticket");
	writeFileSync(
		join(artifact, "rlm-subagents.jsonl"),
		`${[ceo, ticket]
			.map((child, index) =>
				JSON.stringify({
					type: "rlm_subagent",
					childId: index ? "ticket" : "ceo",
					sessionName: index ? "ticket" : "ceo",
					sessionDir: join(artifact, index ? "ticket" : "ceo"),
					sessionFile: child.getSessionFile(),
					parentSessionId: board.getSessionId(),
					parentSessionFile: boardFile,
					rlmDepth: 1,
					rlmMaxDepth: 8,
					rlmParentNodeId: index ? "ticket" : "ceo",
					status: "completed",
					createdAt: 1,
					updatedAt: "2026-01-01T00:00:00.000Z",
				}),
			)
			.join("\n")}\n`,
	);
	for (const [name, child] of [
		["ceo", ceo],
		["ticket", ticket],
	] as const) {
		writeRlmSubagentDisplayEntry({
			type: "rlm_subagent",
			childId: name,
			sessionName: name,
			sessionDir: join(artifact, name),
			sessionFile: child.getSessionFile()!,
			rlmMaxDepth: 8,
			rlmParentNodeId: name,
			status: "completed",
			createdAt: 1,
			updatedAt: new Date().toISOString(),
			model: { provider: "faux", modelId: "faux" },
		});
	}
	const ledger = new RlmSpawnLedger(root, sessionDir);
	for (const [name, child] of [
		["ceo", ceo],
		["ticket", ticket],
	] as const)
		await ledger.appendSpawn({ childId: name, child: child.getSessionFile()!, parent: boardFile, depth: 1, name });
	const keys = generateKeyPairSync("ed25519");
	writeFileSync(join(root, "supervision-owner.pub"), keys.publicKey.export({ type: "spki", format: "pem" }));
	if (oldReader) {
		start([tsx, resolve(__dirname, "fixtures/native-supervision-old-worker.ts"), root, socket], root);
		await waitUntil(() => existsSync(join(root, "old-reader.ready")));
	}
	const supervisor = start([tsx, cli, "--mode", "daemon", "--daemon-socket", socket, "--offline"], root);
	const client = await connect(socket);
	const config = {
		agentDir: root,
		cwd: root,
		sessionDir,
		apiKey: "faux-key",
		extensions: [extension],
		model: "faux",
		provider: "faux",
		noTools: true,
		noSkills: true,
		noContextFiles: true,
		noExtensions: false,
		rlmMaxDepth: 8,
	};
	const summaries: SessionSummary[] = [];
	for (const manager of [board, ceo, ticket]) {
		summaries.push(
			data<SessionSummary>(
				await client.request({ type: "create", sessionPath: manager.getSessionFile()!, config }, 60_000),
			),
		);
		await client.request({ type: "list" });
	}
	expect(new Set(summaries.map((summary) => summary.workerPid)).size).toBe(1);
	const request = normalizeSupervisionRequest({
		operationId: "transport-adoption",
		expectedRevision: (await ledger.supervisionSnapshot()).revision,
		ownerRoot: boardFile,
		moves: [
			{
				childId: "ticket",
				child: ticket.getSessionFile()!,
				expectedParent: boardFile,
				parent: ceo.getSessionFile()!,
			},
		],
	});
	const command: Extract<DaemonCommand, { type: "adopt_supervision" }> = {
		type: "adopt_supervision",
		activeSessionId: summaries[0]!.activeSessionId!,
		request,
		signature: sign(null, Buffer.from(JSON.stringify(request)), keys.privateKey).toString("base64"),
	};
	return {
		root,
		socket,
		sessionDir,
		board,
		ceo,
		ticket,
		ledger,
		supervisor,
		client,
		summaries,
		command,
		keys,
		config,
	};
}

afterEach(async () => {
	for (const root of roots) writeFileSync(join(root, "model.release"), "release");
	for (const client of clients) client.close();
	clients.clear();
	for (const socket of sockets) {
		const client = new DaemonClient(socket);
		try {
			await client.connect(300);
			await client.request({ type: "shutdown" }, 10_000);
			await waitUntil(() => !existsSync(socket));
		} catch {
			/* Already stopped. */
		} finally {
			client.close();
		}
	}
	sockets.clear();
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		await waitUntil(() => child.exitCode !== null || child.signalCode !== null).catch(() => undefined);
	}
	children.clear();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	diagnostics.clear();
}, 60_000);

describe("native supervision authenticated process transport", () => {
	it("serializes competing adoption CAS requests across clients and overlapping native worker admission", async () => {
		const f = await fixture();
		const other = await connect(f.socket);
		const manager = SessionManager.create(f.root, f.sessionDir);
		manager.appendMessage({ role: "user", content: "overlapping root admission", timestamp: 3 });
		manager.flushNow();
		const competing = normalizeSupervisionRequest({ ...f.command.request, operationId: "competing-adoption" });
		const otherCommand = {
			...f.command,
			request: competing,
			signature: sign(null, Buffer.from(JSON.stringify(competing)), f.keys.privateKey).toString("base64"),
		};
		const create: Extract<DaemonCommand, { type: "create" }> = {
			type: "create",
			sessionPath: manager.getSessionFile()!,
			config: f.config,
		};
		const results = await Promise.all([
			f.client.request(create),
			other.request(create),
			f.client.request(f.command),
			other.request(otherCommand),
		]);
		const opened = results.slice(0, 2).map((response) => data<SessionSummary>(response));
		expect(opened[0]!.workerPid).toBe(opened[1]!.workerPid);
		expect(opened[0]!.activeSessionId).toBe(opened[1]!.activeSessionId);
		const adoptions = results.slice(2);
		expect(adoptions.filter((response) => response.success).length).toBeLessThanOrEqual(1);
		if (adoptions.every((response) => !response.success)) {
			expect(adoptions).toEqual(
				expect.arrayContaining([expect.objectContaining({ error: expect.stringContaining("compatibility") })]),
			);
			data(await f.client.request(f.command));
		}
		expect((await f.ledger.edges()).find((edge) => edge.childId === "ticket")).toMatchObject({
			parent: f.ceo.getSessionFile(),
			depth: 2,
		});
		const batches = readFileSync(f.ledger.ledgerPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { v: number })
			.filter((record) => record.v === 2);
		expect(batches).toHaveLength(1);
	}, 90_000);

	it("fences an authenticated old resident reader before the first v2 ledger publication", async () => {
		const f = await fixture(true);
		const before = readFileSync(f.ledger.ledgerPath, "utf8");
		expect(await f.client.request(f.command)).toMatchObject({
			success: false,
			error: expect.stringContaining("All registered workers must prove native supervision compatibility"),
		});
		expect(readFileSync(f.ledger.ledgerPath, "utf8")).toBe(before);
		expect(existsSync(join(f.root, "old-reader-was-sent-adoption"))).toBe(false);
	}, 90_000);

	it("preserves accepted pending delivery through adoption and retries a committed response lost on the socket", async () => {
		const f = await fixture();
		const target = f.summaries[2]!.activeSessionId!;
		data(await f.client.request({ type: "prompt", activeSessionId: target, message: "hold local faux response" }));
		await waitUntil(() => existsSync(join(f.root, "model.ready")));
		expect(await f.client.request({ type: "prepare_update_restart", noForce: true })).toMatchObject({
			success: false,
		});
		const accepted = data<{ id: string; deliveryStatus: string }>(
			await f.client.request({
				type: "send_message",
				fromActiveSessionId: f.summaries[0]!.activeSessionId!,
				targetActiveSessionId: target,
				message: "accepted before response disconnect",
				agentOrigin: true,
			}),
		);
		expect(accepted.deliveryStatus).toBe("queued");
		expect(accepted.id).toEqual(expect.any(String));
		const beforeQueue = data(await f.client.request({ type: "get_queue", activeSessionId: target }));
		const worker = new DaemonWorkerClient(descriptor(f.root).socketPath);
		await worker.connect();
		try {
			const denied = await worker.request(f.command);
			expect(denied.success).toBe(false);
		} finally {
			worker.close();
		}
		const beforeLedger = readFileSync(f.ledger.ledgerPath, "utf8");
		const proxyPath = join(f.root, "lost-response.sock");
		let dropped = false;
		const proxy = createServer((front) => {
			const back = createConnection(f.socket);
			front.pipe(back);
			let pending = "";
			back.on("data", (chunk: Buffer) => {
				pending += chunk.toString();
				while (pending.includes("\n")) {
					const end = pending.indexOf("\n");
					const line = pending.slice(0, end + 1);
					pending = pending.slice(end + 1);
					const message = JSON.parse(line) as { command?: string };
					if (message.command === "adopt_supervision") {
						dropped = true;
						front.destroy();
						back.destroy();
						return;
					}
					front.write(line);
				}
			});
			front.on("close", () => back.destroy());
			back.on("error", () => front.destroy());
		});
		await new Promise<void>((done) => proxy.listen(proxyPath, done));
		try {
			const lost = await connect(proxyPath);
			await expect(lost.request(f.command)).rejects.toThrow();
			expect(dropped).toBe(true);
		} finally {
			proxy.close();
		}
		const receipt = data(await f.client.request(f.command));
		const committed = readFileSync(f.ledger.ledgerPath, "utf8");
		expect(committed.trim().split("\n")).toHaveLength(beforeLedger.trim().split("\n").length + 1);
		expect(data(await f.client.request(f.command))).toEqual(receipt);
		expect(readFileSync(f.ledger.ledgerPath, "utf8")).toBe(committed);
		expect(data(await f.client.request({ type: "get_queue", activeSessionId: target }))).toEqual(beforeQueue);
		expect(await f.ledger.edges()).toContainEqual(
			expect.objectContaining({ childId: "ticket", parent: f.ceo.getSessionFile(), depth: 2 }),
		);
		const denied = await f.client.request({
			type: "send_message",
			fromActiveSessionId: f.summaries[0]!.activeSessionId!,
			targetActiveSessionId: target,
			message: "stale parent",
			agentOrigin: true,
		});
		expect(denied.success).toBe(false);
		writeFileSync(join(f.root, "model.release"), "release");
	}, 90_000);

	it("cold restores stable UUIDs and child handles while an independently owned native sentinel survives", async () => {
		const f = await fixture();
		data(await f.client.request(f.command));
		const accepted = data<{ id: string }>(
			await f.client.request({
				type: "send_message",
				fromActiveSessionId: f.summaries[1]!.activeSessionId!,
				targetActiveSessionId: f.summaries[2]!.activeSessionId!,
				message: "accepted inbox survives cold checkpoint",
				agentOrigin: true,
			}),
		);
		await waitUntil(() => existsSync(join(f.root, "model.ready")));
		writeFileSync(join(f.root, "model.release"), "release");
		data(await f.client.request({ type: "wait_for_idle", activeSessionId: f.summaries[2]!.activeSessionId! }));
		const eventId = "queued-native-event-1";
		data(
			await f.client.request({
				type: "restore_next_turn",
				activeSessionId: f.summaries[2]!.activeSessionId!,
				messages: [
					{
						role: "custom",
						customType: "native_test_pending_event",
						content: "queued terminal evidence",
						display: true,
						details: { eventId, taskHandle: "ticket" },
						timestamp: 4,
					},
				],
			}),
		);
		const before = f.summaries.map((summary) => ({
			sessionId: summary.sessionId,
			activeSessionId: summary.activeSessionId!,
			workerPid: summary.workerPid,
		}));
		const job = data<{ job: { id: string } }>(
			await f.client.request({
				type: "cron_add",
				activeSessionId: before[2]!.activeSessionId,
				schedule: "every 1h",
				prompt: "notifier deadline custody",
			}),
		).job;
		const ready = join(f.root, "sentinel.ready");
		const sentinel = start([resolve(__dirname, "fixtures/blocking-process.mjs"), ready], f.root);
		await waitUntil(() => existsSync(ready));
		const sentinelStartId = getProcessStartId(sentinel.pid!);
		expect(sentinelStartId).toBeDefined();
		mkdirSync(join(f.root, "update-restarts"), { recursive: true });
		const statusPath = join(f.root, "update-restarts", "restart-status.json");
		const coordinator = start(
			[
				tsx,
				cli,
				"update",
				"--internal-update-restart-coordinator",
				"--internal-update-restart-no-force",
				"--daemon-socket",
				f.socket,
				"--internal-update-restart-status",
				statusPath,
			],
			f.root,
		);
		await waitUntil(() => coordinator.exitCode !== null || coordinator.signalCode !== null, 90_000);
		const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
			phase: string;
			message?: string;
			counts: { restored: number; failed: number };
		};
		expect(status, JSON.stringify(status)).toMatchObject({ phase: "complete", counts: { restored: 3, failed: 0 } });
		expect(sentinel.exitCode).toBeNull();
		expect(sentinel.signalCode).toBeNull();
		expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
		expect(getProcessStartId(sentinel.pid!)).toBe(sentinelStartId);
		const restoredClient = await connect(f.socket);
		const restored = data<{ sessions: SessionSummary[] }>(await restoredClient.request({ type: "list" })).sessions;
		for (const old of before) {
			const current = restored.find((summary) => summary.sessionId === old.sessionId)!;
			expect(current).toBeDefined();
			expect(current.workerPid).not.toBe(old.workerPid);
			expect(
				data(await restoredClient.request({ type: "get_state", activeSessionId: old.sessionId })),
			).toMatchObject({ sessionId: old.sessionId });
			expect(
				data(await restoredClient.request({ type: "get_state", activeSessionId: old.activeSessionId })),
			).toMatchObject({ sessionId: old.sessionId });
		}
		const restoredTicket = restored.find((summary) => summary.sessionId === f.ticket.getSessionId())!;
		expect(restoredTicket).toMatchObject({
			rlmChildId: "ticket",
			parentSessionId: f.ceo.getSessionId(),
			rlmDepth: 2,
		});
		data(
			await restoredClient.request({
				type: "prompt_and_wait",
				activeSessionId: before[2]!.activeSessionId,
				message: "consume preserved queued event",
			}),
		);
		const messages = data<{
			messages: Array<{ customType?: string; details?: { id?: string; eventId?: string; taskHandle?: string } }>;
		}>(await restoredClient.request({ type: "get_messages", activeSessionId: before[2]!.activeSessionId })).messages;
		expect(messages.filter((message) => message.details?.id === accepted.id)).toHaveLength(1);
		expect(messages.filter((message) => message.details?.eventId === eventId)).toEqual([
			expect.objectContaining({
				customType: "native_test_pending_event",
				details: { eventId, taskHandle: "ticket" },
			}),
		]);
		expect(
			data<{ jobs: Array<{ id: string }> }>(
				await restoredClient.request({ type: "cron_list", activeSessionId: restoredTicket.activeSessionId! }),
			).jobs,
		).toContainEqual(expect.objectContaining({ id: job.id }));
		expect(await f.ledger.edges()).toContainEqual(
			expect.objectContaining({ childId: "ticket", parent: f.ceo.getSessionFile(), depth: 2 }),
		);
	}, 150_000);
});
