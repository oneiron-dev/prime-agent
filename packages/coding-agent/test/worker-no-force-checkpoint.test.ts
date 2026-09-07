import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecuteResult, KernelClient } from "../src/core/kernel/index.js";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../src/core/orphan-process-journal.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonOutbound, DaemonUpdateRestartManifest } from "../src/modes/daemon/daemon-protocol.js";
import type { DaemonWorkerCommand } from "../src/modes/daemon/daemon-worker-protocol.js";
import { createHarness } from "./suite/harness.js";

interface Transaction {
	id: symbol;
	phase: string;
	noForce: boolean;
}
interface CheckpointHost {
	sessions: Map<string, ActiveSessionState>;
	updateRestart?: Transaction;
	beginUpdateRestartTransaction(owner?: DaemonSocketClient, noForce?: boolean): Transaction;
	runUpdateRestartPreparation(transaction: Transaction): Promise<DaemonUpdateRestartManifest>;
	commitPreparedUpdateRestart(id: symbol): Promise<DaemonUpdateRestartManifest>;
	cancelPreparedUpdateRestart(id?: symbol): void;
	closeSession: ReturnType<typeof vi.fn>;
	handleWorkerCommand(client: DaemonSocketClient, command: DaemonWorkerCommand): Promise<void>;
	write: ReturnType<typeof vi.fn>;
}
async function fixture() {
	const h = await createHarness({ tools: [], persistSession: true });
	h.sessionManager.appendCustomEntry("checkpoint-fixture", {});
	const daemon = new AgentDaemon(join(h.tempDir, "unused.sock"), {
		defaultSessionConfig: { agentDir: h.tempDir },
		createRuntime: async () => {
			throw new Error("checkpoint must not recreate runtime");
		},
	});
	const host = daemon as unknown as CheckpointHost;
	const state = {
		activeSessionId: `active-${h.session.sessionId}`,
		clients: new Set(),
		runtime: {
			session: h.session,
			metadata: { kind: "top-level", createdAt: 1 },
		},
	} as unknown as ActiveSessionState;
	host.sessions.set(state.activeSessionId, state);
	host.closeSession = vi.fn(async () => {
		host.sessions.delete(state.activeSessionId);
	});
	host.write = vi.fn();
	return {
		h,
		host,
		state,
		cleanup: () => {
			host.cancelPreparedUpdateRestart();
			h.cleanup();
		},
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
describe("worker no-force update checkpoint", () => {
	it.each(["resolve", "reject"] as const)(
		"retains timeout fences until the owned probe drains (%s)",
		async (outcome) => {
			const f = await fixture();
			const earlier = await fixture();
			f.host.sessions = new Map([
				[earlier.state.activeSessionId, earlier.state],
				[f.state.activeSessionId, f.state],
			]);
			let resolveProbe!: (result: ExecuteResult) => void;
			let rejectProbe!: (error: Error) => void;
			const probe = new Promise<ExecuteResult>((resolve, reject) => {
				resolveProbe = resolve;
				rejectProbe = reject;
			});
			const execute = vi.fn<KernelClient["execute"]>().mockReturnValueOnce(probe).mockResolvedValue({
				stdout: "",
				stderr: "",
				status: "ok",
				durationMs: 0,
			});
			const interrupt = vi.fn();
			const manager = { execute, interrupt } as unknown as KernelClient;
			const provisioner = new IpythonKernelProvisioner(f.h.tempDir);
			Object.assign(provisioner, { startedManager: manager, managerPromise: Promise.resolve(manager) });
			Object.assign(f.h.session, { _ipythonKernelProvisioner: provisioner });
			const queueReleases: ReturnType<typeof vi.fn>[] = [];
			const inputReleases: ReturnType<typeof vi.fn>[] = [];
			for (const session of [earlier.h.session, f.h.session]) {
				const acquireQueue = session.acquireQueuedWorkPause.bind(session);
				const acquireInput = session.acquireSessionInputPause.bind(session);
				vi.spyOn(session, "acquireQueuedWorkPause").mockImplementation(() => {
					const pause = acquireQueue();
					const release = vi.fn(() => pause.release());
					queueReleases.push(release);
					return { release };
				});
				vi.spyOn(session, "acquireSessionInputPause").mockImplementation(() => {
					const pause = acquireInput();
					const release = vi.fn(() => pause.release());
					inputReleases.push(release);
					return { release };
				});
			}
			vi.useFakeTimers();
			try {
				const owner = {} as DaemonSocketClient;
				Object.assign(f.host, { peerAdmissionsFenced: true });
				const transaction = f.host.beginUpdateRestartTransaction(owner, true);
				const preparing = f.host.runUpdateRestartPreparation(transaction);
				const failed = expect(preparing).rejects.toThrow(/timed out without interruption/);
				await vi.advanceTimersByTimeAsync(5_000);
				await failed;
				expect(f.host.updateRestart).toBe(transaction);
				expect(transaction.phase).toBe("draining");
				expect(Reflect.get(earlier.h.session, "_noForceUpdateCheckpoint")).toBe(true);
				for (const release of [...queueReleases, ...inputReleases]) expect(release).not.toHaveBeenCalled();
				expect(execute).toHaveBeenCalledWith(expect.any(String), { internal: true });
				expect(interrupt).not.toHaveBeenCalled();
				expect(() => f.host.beginUpdateRestartTransaction(owner, true)).toThrow(/already preparing/);
				await expect(provisioner.assertNoForceUpdateCustody()).rejects.toThrow(/custody.*pending/i);
				expect(execute).toHaveBeenCalledTimes(1);
				await f.host.handleWorkerCommand({} as DaemonSocketClient, { type: "worker_cancel_update", id: "foreign" });
				expect(f.host.write.mock.calls.at(-1)?.[1]).toMatchObject({ success: false });
				await f.host.handleWorkerCommand(owner, { type: "worker_cancel_update", id: "cancel" });
				expect(f.host.write.mock.calls.at(-1)?.[1]).toMatchObject({ success: true });
				expect(Reflect.get(f.host, "peerAdmissionsFenced")).toBe(true);
				await f.host.handleWorkerCommand(owner, { type: "worker_commit_update", id: "commit", noForce: true });
				expect(f.host.write.mock.calls.at(-1)?.[1]).toMatchObject({ success: false });
				expect(f.host.closeSession).not.toHaveBeenCalled();
				if (outcome === "resolve") resolveProbe({ stdout: "", stderr: "", status: "ok", durationMs: 0 });
				else rejectProbe(new Error("owned request failed late"));
				await vi.advanceTimersByTimeAsync(0);
				expect(f.host.updateRestart).toBeUndefined();
				expect(Reflect.get(f.host, "peerAdmissionsFenced")).toBe(false);
				expect(Reflect.get(earlier.h.session, "_noForceUpdateCheckpoint")).toBe(false);
				for (const release of [...queueReleases, ...inputReleases]) expect(release).toHaveBeenCalledTimes(1);
				const retry = f.host.beginUpdateRestartTransaction(owner, true);
				expect((await f.host.runUpdateRestartPreparation(retry)).noForce).toBe(true);
				expect(execute).toHaveBeenCalledTimes(2);
				f.host.cancelPreparedUpdateRestart(retry.id);
				f.h.setResponses([fauxAssistantMessage("resumed after custody drain")]);
				const resumed = f.h.session.prompt("resume normal work");
				await vi.advanceTimersByTimeAsync(0);
				await resumed;
				expect(f.h.session.messages.at(-1)).toMatchObject({ role: "assistant" });
				expect(interrupt).not.toHaveBeenCalled();
			} finally {
				resolveProbe({ stdout: "", stderr: "", status: "ok", durationMs: 0 });
				await vi.advanceTimersByTimeAsync(0);
				vi.useRealTimers();
				Object.assign(f.h.session, { _ipythonKernelProvisioner: undefined });
				f.cleanup();
				earlier.cleanup();
			}
		},
	);

	it("cancels promptly before timeout and releases a late acquired pause only after drain", async () => {
		const f = await fixture();
		let resolveProbe!: (result: ExecuteResult) => void;
		const probe = new Promise<ExecuteResult>((resolve) => {
			resolveProbe = resolve;
		});
		const execute = vi.fn<KernelClient["execute"]>().mockReturnValue(probe);
		const interrupt = vi.fn();
		const manager = { execute, interrupt } as unknown as KernelClient;
		const provisioner = new IpythonKernelProvisioner(f.h.tempDir);
		Object.assign(provisioner, { startedManager: manager, managerPromise: Promise.resolve(manager) });
		Object.assign(f.h.session, { _ipythonKernelProvisioner: provisioner });
		const owner = {} as DaemonSocketClient;
		vi.useFakeTimers();
		try {
			const transaction = f.host.beginUpdateRestartTransaction(owner, true);
			const preparing = f.host.runUpdateRestartPreparation(transaction);
			const cancelled = expect(preparing).rejects.toThrow(/cancelled/);
			await vi.advanceTimersByTimeAsync(0);
			expect(execute).toHaveBeenCalledTimes(1);
			await f.host.handleWorkerCommand(owner, { type: "worker_cancel_update", id: "cancel" });
			expect(f.host.write.mock.calls.at(-1)?.[1]).toMatchObject({ success: true });
			expect(f.host.updateRestart).toBe(transaction);
			expect(transaction.phase).toBe("draining");
			expect(Reflect.get(f.h.session, "_queuedWorkPauses").size).toBe(1);
			expect(Reflect.get(f.h.session, "_sessionInputAdmissionPauses").size).toBe(1);
			expect(() => f.host.beginUpdateRestartTransaction(owner, true)).toThrow(/already preparing/);
			resolveProbe({ stdout: "", stderr: "", status: "ok", durationMs: 0 });
			await cancelled;
			await vi.advanceTimersByTimeAsync(0);
			expect(f.host.updateRestart).toBeUndefined();
			expect(Reflect.get(f.h.session, "_queuedWorkPauses").size).toBe(0);
			expect(Reflect.get(f.h.session, "_sessionInputAdmissionPauses").size).toBe(0);
			expect(Reflect.get(f.h.session, "_noForceUpdateCheckpoint")).toBe(false);
			expect(interrupt).not.toHaveBeenCalled();
			expect(f.host.closeSession).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			resolveProbe({ stdout: "", stderr: "", status: "ok", durationMs: 0 });
			await vi.advanceTimersByTimeAsync(0);
			vi.useRealTimers();
			Object.assign(f.h.session, { _ipythonKernelProvisioner: undefined });
			f.cleanup();
		}
	});

	it("checks native kernel custody without interrupting a detached Python task", async () => {
		const python = process.env.PRIME_AGENT_KERNEL_PYTHON;
		if (!python) throw new Error("PRIME_AGENT_KERNEL_PYTHON must name the local native runtime executable");
		const provisioner = new IpythonKernelProvisioner(process.cwd(), {
			python,
			env: { PYTHONPATH: resolve("../../prime-agent-runtime/src") },
		});
		try {
			const kernel = await provisioner.ensure();
			await provisioner.assertNoForceUpdateCustody();
			expect(
				(await kernel.execute("import asyncio\nevent = asyncio.Event()\ntask = asyncio.create_task(event.wait())"))
					.status,
			).toBe("ok");
			await expect(provisioner.assertNoForceUpdateCustody()).rejects.toThrow(/background.*custody/i);
			expect((await kernel.execute("task.done()")).result).toBe("False");
			await kernel.execute("event.set()\nawait task");
			await provisioner.assertNoForceUpdateCustody();
		} finally {
			await provisioner.dispose({ snapshot: false });
		}
	});

	it("rejects a busy faux model before any abort or close, then accepts its natural boundary", async () => {
		const f = await fixture();
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const starting = new Promise<void>((resolve) => {
			started = resolve;
		});
		f.h.setResponses([
			async () => {
				started();
				await gate;
				return fauxAssistantMessage("done");
			},
		]);
		const running = f.h.session.prompt("work");
		await starting;
		const abort = vi.spyOn(f.h.session, "abortForUpdateRestart");
		try {
			await expect(
				f.host.runUpdateRestartPreparation(f.host.beginUpdateRestartTransaction(undefined, true)),
			).rejects.toThrow(/no-force.*busy/i);
			expect(f.host.closeSession).not.toHaveBeenCalled();
			expect(abort).not.toHaveBeenCalled();
			expect(f.h.session.isStreaming).toBe(true);
			release();
			await running;
			await f.h.session.waitForIdle();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			const transaction = f.host.beginUpdateRestartTransaction(undefined, true);
			await f.host.runUpdateRestartPreparation(transaction);
			await f.host.commitPreparedUpdateRestart(transaction.id);
			expect(f.host.closeSession).toHaveBeenCalledTimes(1);
		} finally {
			release();
			await running;
			f.cleanup();
		}
	});

	it("rejects uncertain external process custody before any close", async () => {
		const f = await fixture();
		const journal = join(f.h.tempDir, "orphans.jsonl");
		vi.stubEnv(ORPHAN_PROCESS_JOURNAL_ENV, journal);
		writeFileSync(
			journal,
			`${JSON.stringify({
				version: 1,
				pid: process.pid,
				ownerPid: process.pid,
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);
		try {
			await expect(
				f.host.runUpdateRestartPreparation(f.host.beginUpdateRestartTransaction(undefined, true)),
			).rejects.toThrow(/external process custody/i);
			expect(f.host.closeSession).not.toHaveBeenCalled();
			expect(f.host.updateRestart).toBeUndefined();
		} finally {
			f.cleanup();
		}
	});

	it("fails closed on an unreadable process custody journal", async () => {
		const f = await fixture();
		const journal = join(f.h.tempDir, "orphans.jsonl");
		vi.stubEnv(ORPHAN_PROCESS_JOURNAL_ENV, journal);
		writeFileSync(journal, '{"version":1,"pid":');
		try {
			await expect(
				f.host.runUpdateRestartPreparation(f.host.beginUpdateRestartTransaction(undefined, true)),
			).rejects.toThrow(/custody/i);
			expect(f.host.closeSession).not.toHaveBeenCalled();
		} finally {
			f.cleanup();
		}
	});

	it("rechecks the whole worker before closing the first session", async () => {
		const f = await fixture();
		try {
			const transaction = f.host.beginUpdateRestartTransaction(undefined, true);
			await f.host.runUpdateRestartPreparation(transaction);
			vi.spyOn(f.h.session, "isBashRunning", "get").mockReturnValue(true);
			await expect(f.host.commitPreparedUpdateRestart(transaction.id)).rejects.toThrow(/no-force/i);
			expect(f.host.closeSession).not.toHaveBeenCalled();
		} finally {
			f.cleanup();
		}
	});

	it("does not downgrade a no-force checkpoint when commit omits its mode", async () => {
		const f = await fixture();
		const client = {} as DaemonSocketClient;
		try {
			const transaction = f.host.beginUpdateRestartTransaction(client, true);
			await f.host.runUpdateRestartPreparation(transaction);
			await f.host.handleWorkerCommand(client, { type: "worker_commit_update", id: "commit" });
			const response = f.host.write.mock.calls.at(-1)?.[1] as DaemonOutbound;
			expect(response).toMatchObject({ type: "response", success: false });
			expect(f.host.closeSession).not.toHaveBeenCalled();
		} finally {
			f.cleanup();
		}
	});

	it("preserves queued action IDs while input admission is fenced", async () => {
		const f = await fixture();
		const pause = f.h.session.acquireQueuedWorkPause();
		try {
			await f.h.session.followUp("accepted inbox", undefined, { agentMessageId: "accepted-message-1" });
			const before = f.h.session.getSessionActionRecoverySnapshot();
			const transaction = f.host.beginUpdateRestartTransaction(undefined, true);
			const manifest = await f.host.runUpdateRestartPreparation(transaction);
			expect(manifest.sessions[0].queue.actions).toEqual(before);
			expect(f.h.session.getSessionActionRecoverySnapshot()).toEqual(before);
		} finally {
			f.cleanup();
			pause.release();
		}
	});
});
