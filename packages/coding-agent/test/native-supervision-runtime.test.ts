import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionMessageReceipt } from "../src/core/agent-messages.js";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { AgentSessionServices } from "../src/core/agent-session-services.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	type DaemonCommand,
	type DaemonOutbound,
	daemonHelloMeetsCompatibility,
} from "../src/modes/daemon/daemon-protocol.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { normalizeSupervisionRequest, type RlmSupervisionRequest } from "../src/modes/daemon/rlm-supervision.js";
import { createHarness, type Harness } from "./suite/harness.js";

interface NativeTestHost {
	sessions: Map<string, ActiveSessionState>;
	rlmSpawnLedgerInstance: RlmSpawnLedger;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonOutbound | undefined>;
	isAgentFamilyReachable(from: ActiveSessionState, target: ActiveSessionState): boolean;
	sendAgentSessionMessage(input: {
		targetSelector: string;
		message: string;
		fromState: ActiveSessionState;
		origin: "agent";
	}): Promise<AgentSessionMessageReceipt>;
}
function state(harness: Harness, parent?: ActiveSessionState, childId?: string): ActiveSessionState {
	const session = harness.session;
	mkdirSync(dirname(session.sessionFile!), { recursive: true });
	writeFileSync(
		session.sessionFile!,
		`${JSON.stringify({ ...harness.sessionManager.getHeader(), parentSession: parent?.runtime.session.sessionFile })}\n`,
	);
	return {
		activeSessionId: `active-${session.sessionId}`,
		clients: new Set(),
		runtime: new AgentSessionRuntime(
			session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as AgentSessionServices,
			async () => {
				throw new Error("adoption must not recreate a runtime");
			},
			[],
			undefined,
			undefined,
			{
				kind: parent ? "subagent" : "top-level",
				createdAt: 1,
				rlmChildId: childId,
				parentActiveSessionId: parent?.activeSessionId,
				parentSessionId: parent?.runtime.session.sessionId,
				parentSessionFile: parent?.runtime.session.sessionFile,
			},
		),
	} as unknown as ActiveSessionState;
}
async function fixture() {
	const old = await createHarness({ tools: [], rlmMaxDepth: 8, persistSession: true });
	const next = await createHarness({ tools: [], rlmDepth: 1, rlmMaxDepth: 8, persistSession: true });
	const child = await createHarness({ tools: [], rlmDepth: 1, rlmMaxDepth: 8, persistSession: true });
	const board = state(old);
	const ceo = state(next, board, "ceo");
	const ticket = state(child, board, "ticket");
	old.session.registerRlmChildSession("ceo", next.session);
	old.session.registerRlmChildSession("ticket", child.session);
	const daemon = new AgentDaemon(join(old.tempDir, "unused.sock"), {
		defaultSessionConfig: { agentDir: old.tempDir, sessionDir: dirname(old.session.sessionFile!) },
		createRuntime: async () => {
			throw new Error("adoption must not recreate a runtime");
		},
	});
	const host = daemon as unknown as NativeTestHost;
	for (const item of [board, ceo, ticket]) host.sessions.set(item.activeSessionId, item);
	const ledger = new RlmSpawnLedger(old.tempDir, dirname(old.session.sessionFile!));
	host.rlmSpawnLedgerInstance = ledger;
	for (const [id, session] of [
		["ceo", next.session],
		["ticket", child.session],
	] as const)
		await ledger.appendSpawn({
			childId: id,
			child: session.sessionFile!,
			parent: old.session.sessionFile!,
			depth: 1,
			name: id,
		});
	const keys = generateKeyPairSync("ed25519");
	writeFileSync(join(old.tempDir, "supervision-owner.pub"), keys.publicKey.export({ type: "spki", format: "pem" }));
	const request: RlmSupervisionRequest = normalizeSupervisionRequest({
		operationId: "native-test",
		expectedRevision: (await ledger.supervisionSnapshot()).revision,
		ownerRoot: old.session.sessionFile!,
		moves: [
			{
				childId: "ticket",
				child: child.session.sessionFile!,
				expectedParent: old.session.sessionFile!,
				parent: next.session.sessionFile!,
			},
		],
	});
	const signature = sign(null, Buffer.from(JSON.stringify(request)), keys.privateKey).toString("base64");
	const command: DaemonCommand = {
		type: "adopt_supervision",
		activeSessionId: board.activeSessionId,
		request,
		signature,
	};
	const adopt = () => host.handleCommand({} as DaemonSocketClient, command);
	return {
		old,
		next,
		child,
		board,
		ceo,
		ticket,
		host,
		ledger,
		command,
		adopt,
		cleanup: () => {
			old.cleanup();
			next.cleanup();
			child.cleanup();
		},
	};
}

describe("native supervision custody", () => {
	it("refreshes future kernel cells without replacing the kernel", () => {
		let depth = 1;
		const provisioner = new IpythonKernelProvisioner("/fixture", { liveEnv: () => ({ RLM_DEPTH: String(depth) }) });
		expect(provisioner.prepareUserCode("existing_handle")).toContain('"RLM_DEPTH":"1"');
		depth = 2;
		expect(provisioner.prepareUserCode("existing_handle")).toContain('"RLM_DEPTH":"2"');
		expect(provisioner.prepareUserCode("existing_handle")).toContain("existing_handle");
	});
	it("commits through the native control API without changing sessions, handles or queued custody", async () => {
		const f = await fixture();
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const starting = new Promise<void>((resolve) => {
			started = resolve;
		});
		f.child.setResponses([
			async () => {
				started();
				await gate;
				return fauxAssistantMessage("first turn");
			},
			fauxAssistantMessage("received"),
		]);
		const running = f.child.session.prompt("hold provider stream");
		await starting;
		try {
			const receipt = await f.host.sendAgentSessionMessage({
				targetSelector: f.ticket.activeSessionId,
				message: "accepted before adoption",
				fromState: f.board,
				origin: "agent",
			});
			const before = f.child.session.getSessionActionRecoverySnapshot();
			expect(f.host.isAgentFamilyReachable(f.board, f.ticket)).toBe(true);
			expect(await f.adopt()).toMatchObject({ success: true });
			expect(f.host.sessions.get(f.ticket.activeSessionId)).toBe(f.ticket);
			expect(f.next.session.isRetainedRlmChildSession("ticket", f.child.session)).toBe(true);
			expect(f.old.session.isRetainedRlmChildSession("ticket", f.child.session)).toBe(false);
			expect(f.child.session.rlmDepth).toBe(2);
			expect(f.ticket.runtime.metadata).toMatchObject({
				parentActiveSessionId: f.ceo.activeSessionId,
				parentSessionId: f.next.session.sessionId,
				parentSessionFile: f.next.session.sessionFile,
			});
			const snapshot = f.ticket.runtime.metadata;
			snapshot.parentSessionId = "must not mutate runtime metadata";
			expect(f.ticket.runtime.metadata.parentSessionId).toBe(f.next.session.sessionId);
			expect(f.child.session.getSessionActionRecoverySnapshot()).toEqual(before);
			expect(receipt.target.sessionId).toBe(f.child.session.sessionId);
			expect(f.host.isAgentFamilyReachable(f.board, f.ticket)).toBe(false);
			expect(f.host.isAgentFamilyReachable(f.ceo, f.ticket)).toBe(true);
			await expect(
				f.host.sendAgentSessionMessage({
					targetSelector: f.ticket.activeSessionId,
					message: "stale parent",
					fromState: f.board,
					origin: "agent",
				}),
			).rejects.toThrow();
			expect(await f.adopt()).toMatchObject({ success: true });
			f.host.rlmSpawnLedgerInstance = new RlmSpawnLedger(f.old.tempDir, dirname(f.old.session.sessionFile!));
			expect(f.host.isAgentFamilyReachable(f.board, f.ticket)).toBe(false);
			expect(await f.adopt()).toMatchObject({ success: true });
		} finally {
			release();
			await running;
			f.cleanup();
		}
	});

	it("rejects unsigned changes and aborts the whole batch when a resident custody preflight fails", async () => {
		const f = await fixture();
		try {
			await expect(
				f.host.handleCommand({} as DaemonSocketClient, { ...f.command, signature: "invalid" } as DaemonCommand),
			).rejects.toThrow();
			const before = await f.ledger.supervisionSnapshot();
			f.host.sessions.delete(f.ceo.activeSessionId);
			await expect(f.adopt()).rejects.toThrow("same ready worker");
			expect(await f.ledger.supervisionSnapshot()).toEqual(before);
			expect(f.old.session.isRetainedRlmChildSession("ticket", f.child.session)).toBe(true);
		} finally {
			f.cleanup();
		}
	});

	it.each(["before", "after"])("preserves a faux task terminal committed %s adoption", async (when) => {
		const child = await createHarness({ tools: [], rlmDepth: 1, rlmMaxDepth: 8 });
		const old = await createHarness({
			tools: [],
			rlmMaxDepth: 8,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		const next = await createHarness({ tools: [], rlmDepth: 1, rlmMaxDepth: 8 });
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const starting = new Promise<void>((resolve) => {
			started = resolve;
		});
		child.setResponses([
			async () => {
				started();
				await gate;
				return fauxAssistantMessage("genuine finding");
			},
		]);
		try {
			const handle = await old.session.runRlmChild("work", { name: "worker" });
			await starting;
			if (when === "before") {
				release();
				await old.session.waitForRlmQuiescence();
			}
			old.session.prepareRlmChildTransfer(handle.rlm_child_id, child.session, next.session)();
			child.session.prepareRlmTopologyUpdate(2, next.session)();
			release();
			await next.session.waitForRlmQuiescence();
			const terminal = (h: Harness) =>
				h.session.messages.filter((m) => m.role === "custom" && m.customType === "rlm_child_terminal_notice");
			expect(terminal(old)).toHaveLength(when === "before" ? 1 : 0);
			expect(terminal(next)).toHaveLength(when === "before" ? 0 : 1);
			expect(next.session.isRetainedRlmChildSession(handle.rlm_child_id, child.session)).toBe(true);
		} finally {
			release();
			old.cleanup();
			next.cleanup();
			child.cleanup();
		}
	});

	it("does not credit an old daemon with the new writer/reader boundary", () => {
		expect(daemonHelloMeetsCompatibility(undefined, DAEMON_COMMAND_COMPATIBILITY.adopt_supervision)).toBe(false);
		const old: Extract<DaemonOutbound, { type: "daemon_hello" }> = {
			type: "daemon_hello",
			socketPath: "/fixture",
			clientId: "old",
			protocol: { name: "prime-agent.daemon", version: 7 },
			schemaRevision: 29,
			serverCapabilities: ["native_supervision"],
		};
		expect(daemonHelloMeetsCompatibility(old, DAEMON_COMMAND_COMPATIBILITY.adopt_supervision)).toBe(false);
	});
});
