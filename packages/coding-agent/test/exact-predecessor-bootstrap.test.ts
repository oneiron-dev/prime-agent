import { type ChildProcess, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistDaemonUpdateRestartAliases } from "../src/cli/daemon-update-restart.js";
import { ENV_AGENT_DIR, getDaemonUpdateRestartManifestPath } from "../src/config.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import type {
	DaemonCommand,
	DaemonResponse,
	DaemonUpdateRestartManifest,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { writeRlmSubagentDisplayEntry } from "../src/modes/daemon/rlm-subagent-display.js";
import { normalizeSupervisionRequest } from "../src/modes/daemon/rlm-supervision.js";

const cli = resolve(__dirname, "../src/cli.ts");
const tsx = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const extension = resolve(__dirname, "fixtures/native-supervision-faux-extension.ts");
const predecessor =
	"/mnt/wd16/offload/oneiron-factory/prime-runtime-20260905/installs/0.9.1-oneiron.20260905.10-linux-x64/node_modules/prime-agent";
const oldCli = join(predecessor, "dist/bundle/cli.js");
const evidence = process.env.NATIVE_BOOTSTRAP_EVIDENCE_DIR ?? mkdtempSync(join("/tmp", "prime-bootstrap-evidence-"));
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
			UV_OFFLINE: "1",
			UV_PYTHON_DOWNLOADS: "never",
			NPM_CONFIG_OFFLINE: "true",
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
async function fixture() {
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
	const supervisor = start([oldCli, "--mode", "daemon", "--daemon-socket", socket, "--offline"], root);
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

function record(name: string, value: unknown): void {
	writeFileSync(join(evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function finitePreflight(client: DaemonClient, summaries: SessionSummary[], custodyKnown = true): Promise<void> {
	if (!custodyKnown) throw new Error("unknown external custody");
	const current = data<{ sessions: SessionSummary[] }>(await client.request({ type: "list" })).sessions;
	expect(current.map((row) => row.sessionId).sort()).toEqual(summaries.map((row) => row.sessionId).sort());
	for (const summary of summaries) {
		const state = data<SessionSummary>(
			await client.request({ type: "get_state", activeSessionId: summary.activeSessionId! }),
		);
		const busyFlags = [
			state.isStreaming,
			state.isCompacting,
			state.isBashRunning,
			state.hasRunningRlmChildren,
			state.isRunningTools,
		];
		if (busyFlags.some((flag) => flag === true) || (state.unfinishedActionCount ?? 0) > 0) throw new Error("busy");
		if (
			busyFlags.some((flag) => flag !== false) ||
			state.unfinishedActionCount !== 0 ||
			state.workerState !== "ready"
		) {
			throw new Error("unknown session activity");
		}
	}
}

afterEach(async () => {
	for (const root of roots) {
		writeFileSync(join(root, "model.release"), "release");
		writeFileSync(join(root, "sentinel.release"), "release");
	}
	for (const client of clients) client.close();
	clients.clear();
	for (const socket of sockets) {
		if (!existsSync(socket)) continue;
		const client = new DaemonClient(socket);
		try {
			await client.connect(1000);
			const rows = data<{ sessions: SessionSummary[] }>(await client.request({ type: "list" })).sessions;
			for (const row of rows)
				data(await client.request({ type: "wait_for_idle", activeSessionId: row.activeSessionId! }));
			await finitePreflight(client, rows);
			data(await client.request({ type: "shutdown" }, 10000));
			await waitUntil(() => !existsSync(socket));
		} finally {
			client.close();
		}
	}
	sockets.clear();
	for (const child of children) {
		await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
	}
	record("process-output", [...diagnostics.values()]);
	children.clear();
	// Preserve isolated native evidence; no signal or forced cleanup path exists here.
	roots.length = 0;
	diagnostics.clear();
}, 60000);

describe.skipIf(!existsSync(oldCli))("exact installed .10 native cold bootstrap", () => {
	it("checkpoints .10 supervisor/worker at a finite natural boundary and restores into the reviewed source", async () => {
		const f = await fixture();
		record("profile", { root: f.root, socket: f.socket, oldCli });
		expect(f.client.hello?.appVersion).toBe("0.9.1-oneiron.20260905.10");
		expect(f.client.hello?.protocol.version).toBe(7);
		expect(f.client.hello?.serverCapabilities).not.toContain("no_force_update_restart");
		const oldWorker = descriptor(f.root);
		const workerProbe = new DaemonWorkerClient(oldWorker.socketPath);
		await workerProbe.connect();
		const workerHello = await workerProbe.waitForHello();
		workerProbe.close();
		expect(workerHello.appVersion).toBe("0.9.1-oneiron.20260905.10");
		expect(workerHello.runtime?.entrypointPath).toContain("0.9.1-oneiron.20260905.10-linux-x64/");
		record("predecessor-worker-hello", workerHello);
		await expect(finitePreflight(f.client, f.summaries, false)).rejects.toThrow("unknown external custody");
		record("unknown-refusal", { prepareSent: false, reason: "unknown external custody" });
		record("predecessor", {
			supervisor: f.client.hello,
			worker: oldWorker,
			cliSha256: createHash("sha256").update(readFileSync(oldCli)).digest("hex"),
		});
		const target = f.summaries[2]!.activeSessionId!;
		data(await f.client.request({ type: "prompt", activeSessionId: target, message: "hold local faux response" }));
		await waitUntil(() => existsSync(join(f.root, "model.ready")));
		await expect(finitePreflight(f.client, f.summaries)).rejects.toThrow("busy");
		record("busy-refusal", { prepareSent: false, workerPid: oldWorker.pid, reason: "model streaming" });
		const accepted = data<{ id: string; deliveryStatus: string }>(
			await f.client.request({
				type: "send_message",
				fromActiveSessionId: f.summaries[0]!.activeSessionId!,
				targetActiveSessionId: target,
				message: "accepted before old boundary",
				agentOrigin: true,
			}),
		);
		expect(accepted.deliveryStatus).toBe("queued");
		writeFileSync(join(f.root, "model.release"), "release");
		data(await f.client.request({ type: "wait_for_idle", activeSessionId: target }));
		const eventId = "exact-old-queued-event";
		data(
			await f.client.request({
				type: "restore_next_turn",
				activeSessionId: target,
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
		const job = data<{ job: { id: string } }>(
			await f.client.request({
				type: "cron_add",
				activeSessionId: target,
				schedule: "every 1h",
				prompt: "notifier deadline custody",
			}),
		).job;
		const rootJob = data<{ job: { id: string } }>(
			await f.client.request({
				type: "cron_add",
				activeSessionId: f.summaries[0]!.activeSessionId!,
				schedule: "every 1h",
				prompt: "root notifier alias custody",
			}),
		).job;
		const pauseOwner = await connect(f.socket);
		for (const summary of f.summaries)
			data(
				await pauseOwner.request({
					type: "acquire_session_input_pause",
					activeSessionId: summary.activeSessionId!,
					leaseKey: "bounded-bootstrap",
				}),
			);
		await finitePreflight(f.client, f.summaries);
		const ready = join(f.root, "sentinel.ready");
		const sentinel = start(
			[
				"--input-type=module",
				"-e",
				`import {watch,writeFileSync,existsSync} from 'node:fs';
const root=process.argv[1]; const watcher=watch(root,()=>{if(existsSync(root+'/sentinel.release')) watcher.close()});
writeFileSync(root+'/sentinel.ready',String(process.pid));`,
				f.root,
			],
			f.root,
		);
		await waitUntil(() => existsSync(ready));
		const sentinelStartId = getProcessStartId(sentinel.pid!);
		expect(sentinelStartId).toBeDefined();
		record("finite-preflight", {
			scope: "isolated fixture only",
			noTools: true,
			noKernel: true,
			extensions: [extension],
			singleController: true,
			inputPauses: true,
			cronDue: "1h",
			modelNaturalEnd: true,
			sessions: f.summaries,
			sentinel: { pid: sentinel.pid, processStartId: sentinelStartId },
		});
		// The exact old public operation performs native prepare+commit. No optional noForce field is sent.
		const manifest = data<DaemonUpdateRestartManifest>(
			await f.client.request({ type: "prepare_update_restart" }, 60000),
		);
		expect(manifest.noForce).toBeUndefined();
		expect(manifest.sessions).toHaveLength(3);
		for (const session of manifest.sessions) {
			expect([
				session.wasStreaming,
				session.wasCompacting,
				session.wasBashRunning,
				session.hadRunningRlmChildren,
				session.wasRetrying,
				session.hadAcceptedPromptInFlight,
			]).toEqual([false, false, false, false, false, false]);
		}
		expect(manifest.sessions.find((row) => row.activeSessionId === target)!.queue.nextTurn).toContainEqual(
			expect.objectContaining({ details: { eventId, taskHandle: "ticket" } }),
		);
		record("old-native-manifest", manifest);
		expect([...diagnostics.values()].join("\n")).not.toMatch(/forcing restart completion|SIGKILL/);
		data(await f.client.request({ type: "shutdown" }, 10000));
		await waitUntil(() => f.supervisor.exitCode !== null && !existsSync(f.socket));
		expect(getProcessStartId(oldWorker.pid)).toBeUndefined();
		expect(getProcessStartId(sentinel.pid!)).toBe(sentinelStartId);
		// Offline successor helper creates the transient-alias sidecar from the native checkpoint, not a ledger rewrite.
		persistDaemonUpdateRestartAliases(f.socket, f.root, manifest.sessions);
		record(
			"alias-sidecar",
			JSON.parse(readFileSync(`${getDaemonUpdateRestartManifestPath(f.socket, f.root)}.aliases.json`, "utf8")),
		);
		mkdirSync(join(f.root, "update-restarts"), { recursive: true });
		const statusPath = join(f.root, "update-restarts", "legacy-restore-status.json");
		const coordinator = start(
			[
				tsx,
				cli,
				"update",
				"--internal-update-restart-coordinator",
				"--daemon-socket",
				f.socket,
				"--internal-update-restart-status",
				statusPath,
			],
			f.root,
		);
		await waitUntil(() => coordinator.exitCode !== null || coordinator.signalCode !== null, 90000);
		const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
			phase: string;
			counts: { restored: number; failed: number };
		};
		record("new-native-restore-status", status);
		expect(status).toMatchObject({ phase: "complete", counts: { restored: 3, failed: 0 } });
		const current = await connect(f.socket);
		expect(current.hello?.protocol.version).toBe(8);
		expect(current.hello?.serverCapabilities).toContain("no_force_update_restart");
		const restored = data<{ sessions: SessionSummary[] }>(await current.request({ type: "list" })).sessions;
		record("successor", { supervisor: current.hello, worker: descriptor(f.root) });
		for (const before of f.summaries) {
			const now = restored.find((row) => row.sessionId === before.sessionId)!;
			expect(now.sessionFile).toBe(before.sessionFile);
			expect(now.workerPid).not.toBe(before.workerPid);
			expect(
				data(await current.request({ type: "get_state", activeSessionId: before.activeSessionId! })),
			).toMatchObject({ sessionId: before.sessionId });
			expect(data(await current.request({ type: "get_state", activeSessionId: before.sessionId }))).toMatchObject({
				sessionId: before.sessionId,
			});
		}
		const rootNow = restored.find((row) => row.sessionId === f.board.getSessionId())!;
		expect(rootNow.activeSessionId).not.toBe(f.summaries[0]!.activeSessionId);
		const rootJobs = data<{ jobs: Array<{ id: string; activeSessionId: string; sessionFile: string }> }>(
			await current.request({ type: "cron_list", activeSessionId: f.summaries[0]!.activeSessionId! }),
		).jobs;
		expect(rootJobs).toContainEqual(
			expect.objectContaining({
				id: rootJob.id,
				activeSessionId: rootNow.activeSessionId,
				sessionFile: f.board.getSessionFile(),
			}),
		);
		record("notifier-target-mapping", {
			oldAlias: f.summaries[0]!.activeSessionId,
			currentAlias: rootNow.activeSessionId,
			stableSessionId: rootNow.sessionId,
			jobs: rootJobs,
		});
		// First native v2 publication happens only after the old workers have exited.
		data(
			await current.request({
				...f.command,
				activeSessionId: restored.find((row) => row.sessionId === f.board.getSessionId())!.activeSessionId!,
			}),
		);
		data(
			await current.request({
				type: "prompt_and_wait",
				activeSessionId: target,
				message: "consume preserved queued event",
			}),
		);
		const messages = data<{ messages: Array<{ details?: { id?: string; eventId?: string } }> }>(
			await current.request({ type: "get_messages", activeSessionId: target }),
		).messages;
		expect(messages.filter((row) => row.details?.id === accepted.id)).toHaveLength(1);
		expect(messages.filter((row) => row.details?.eventId === eventId)).toHaveLength(1);
		expect(
			data<{ jobs: Array<{ id: string }> }>(await current.request({ type: "cron_list", activeSessionId: target }))
				.jobs,
		).toContainEqual(expect.objectContaining({ id: job.id }));
		expect(await f.ledger.edges()).toContainEqual(
			expect.objectContaining({ childId: "ticket", parent: f.ceo.getSessionFile(), depth: 2 }),
		);
		const adopted = data<SessionSummary>(await current.request({ type: "get_state", activeSessionId: target }));
		expect(adopted).toMatchObject({ rlmChildId: "ticket", parentSessionId: f.ceo.getSessionId(), rlmDepth: 2 });
		record("adopted-runtime", adopted);
		expect([...diagnostics.values()].join("\n")).not.toMatch(/forcing restart completion|SIGKILL/);
		expect(getProcessStartId(sentinel.pid!)).toBe(sentinelStartId);
		record("continuity", {
			before: f.summaries,
			after: restored,
			acceptedId: accepted.id,
			eventId,
			cronId: job.id,
			sentinel: { pid: sentinel.pid, processStartId: sentinelStartId, aliveAfter: true },
			graph: await f.ledger.edges(),
			manifestPath: getDaemonUpdateRestartManifestPath(f.socket, f.root),
		});
	}, 150000);
});
