import { createHash } from "node:crypto";

interface AttachWaitOptions {
	activeSessionId: string;
	clientId?: string;
	workerId?: string;
	timeoutMs?: number;
	log?: (line: string) => void;
}

export class AttachCancelledError extends Error {
	constructor(readonly reason: "deadline" | "cancelled" | "disconnected" | "finished") {
		super(`Attachment wait ${reason}`);
		this.name = "AttachCancelledError";
	}
}

interface PromiseObserver {
	waiters: Set<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }>;
}
const observers = new WeakMap<Promise<unknown>, PromiseObserver>();

/** One observer per shared operation; abort removes the viewer's callbacks immediately. */
function observe<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	let observer = observers.get(promise);
	if (!observer) {
		observer = { waiters: new Set() };
		observers.set(promise, observer);
		const current = observer;
		void promise.then(
			(value) => {
				observers.delete(promise);
				for (const waiter of [...current.waiters]) waiter.resolve(value);
				current.waiters.clear();
			},
			(error: unknown) => {
				observers.delete(promise);
				for (const waiter of [...current.waiters]) waiter.reject(error);
				current.waiters.clear();
			},
		);
	}
	const current = observer;
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => {
			current.waiters.delete(waiter);
			signal.removeEventListener("abort", abort);
		};
		const waiter = {
			resolve: (value: unknown) => {
				cleanup();
				resolve(value as T);
			},
			reject: (error: unknown) => {
				cleanup();
				reject(error);
			},
		};
		const abort = () => waiter.reject(signal.reason);
		current.waiters.add(waiter);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

function correlation(value: string | undefined): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	if (/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) return value;
	return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export class AttachWaitScope {
	readonly controller = new AbortController();
	readonly signal: AbortSignal = this.controller.signal;
	readonly requestedSessionId: string;
	transferred = false;
	private relatedRequestId?: string;
	activeSessionId: string;
	private workerId?: string;
	private readonly startedAt = performance.now();
	private readonly deadline: ReturnType<typeof setTimeout>;
	private finished = false;
	private logCount = 0;
	private readonly phases = new Set<string>();

	constructor(
		readonly requestId: string,
		private readonly options: AttachWaitOptions,
		private readonly remove: () => void,
	) {
		this.requestedSessionId = options.activeSessionId;
		this.activeSessionId = options.activeSessionId;
		this.workerId = options.workerId;
		const requested = options.timeoutMs ?? 300_000;
		if (!Number.isFinite(requested) || requested < 1) throw new Error("Attach timeoutMs must be positive");
		this.deadline = setTimeout(() => this.cancel("deadline"), Math.min(requested, 300_000));
		this.deadline.unref();
		this.record("started");
	}

	transfer(): void {
		this.check();
		this.transferred = true;
	}

	linkRequest(requestId: string): void {
		this.relatedRequestId = requestId;
		this.record("linked_request");
	}

	check(): void {
		if (this.signal.aborted) throw this.signal.reason;
		if (this.finished) throw new AttachCancelledError("finished");
	}

	setWorker(workerId: string, activeSessionId?: string): void {
		this.workerId = workerId;
		if (activeSessionId) this.activeSessionId = activeSessionId;
	}

	async wait<T>(phase: string, work: () => Promise<T>): Promise<T> {
		this.check();
		const startedAt = performance.now();
		this.phases.add(phase);
		this.record("phase_started", phase, undefined, startedAt - this.startedAt);
		try {
			const result = await observe(work(), this.signal);
			this.check();
			this.record("phase_finished", phase, "completed", performance.now() - startedAt);
			return result;
		} catch (error) {
			this.record(
				"phase_finished",
				phase,
				this.signal.aborted ? "cancelled" : "failed",
				performance.now() - startedAt,
			);
			throw error;
		} finally {
			this.phases.delete(phase);
		}
	}

	cancel(reason: "deadline" | "cancelled" | "disconnected" = "cancelled"): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.deadline);
		this.controller.abort(new AttachCancelledError(reason));
		this.record("cancelled", undefined, reason);
		this.remove();
	}

	finish(outcome: "completed" | "failed" = "completed"): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.deadline);
		if (this.phases.size) this.controller.abort(new AttachCancelledError("finished"));
		this.record("finished", undefined, outcome);
		this.remove();
	}

	private record(event: string, phase?: string, outcome?: string, phaseMs?: number): void {
		if (!this.options.log || (this.logCount++ >= 40 && event !== "finished" && event !== "cancelled")) return;
		try {
			this.options.log(
				JSON.stringify({
					component: "attach",
					event,
					requestId: correlation(this.requestId),
					clientId: correlation(this.options.clientId),
					relatedRequestId: correlation(this.relatedRequestId),
					workerId: correlation(this.workerId),
					activeSessionId: correlation(this.activeSessionId),
					phase: phase ? correlation(phase) : undefined,
					outcome,
					elapsedMs: Math.round((performance.now() - this.startedAt) * 100) / 100,
					...(event === "phase_finished" && phaseMs !== undefined
						? { phaseMs: Math.round(phaseMs * 100) / 100 }
						: {}),
					...(event === "phase_finished" && (phase === "queue" || phase === "admission")
						? { queueWaitMs: Math.round((phaseMs ?? 0) * 100) / 100 }
						: {}),
				}),
			);
		} catch {
			/* Attach diagnostics must not prevent observation. */
		}
	}
}

export class AttachWaitRegistry {
	private readonly clients = new WeakMap<object, Map<string, AttachWaitScope>>();

	start(client: object, requestId: string, options: AttachWaitOptions): AttachWaitScope {
		let pending = this.clients.get(client);
		if (!pending) {
			pending = new Map();
			this.clients.set(client, pending);
		}
		if (pending.has(requestId)) throw new Error("Duplicate pending attach request ID");
		const requests = pending;
		const scope = new AttachWaitScope(requestId, options, () => {
			if (requests.get(requestId) === scope) requests.delete(requestId);
		});
		requests.set(requestId, scope);
		return scope;
	}

	get(client: object, requestId: string): AttachWaitScope | undefined {
		return this.clients.get(client)?.get(requestId);
	}

	cancel(client: object, requestId: string, activeSessionId?: string): boolean {
		const scope = this.clients.get(client)?.get(requestId);
		if (
			!scope ||
			(activeSessionId !== undefined &&
				scope.requestedSessionId !== activeSessionId &&
				scope.activeSessionId !== activeSessionId)
		)
			return false;
		scope.cancel();
		return true;
	}

	cancelClient(client: object): void {
		for (const scope of this.clients.get(client)?.values() ?? []) scope.cancel("disconnected");
		this.clients.delete(client);
	}

	cancelSession(client: object, activeSessionId: string): void {
		for (const scope of this.clients.get(client)?.values() ?? []) {
			if (scope.activeSessionId === activeSessionId || scope.requestedSessionId === activeSessionId) scope.cancel();
		}
	}
}

export interface AttachLease {
	commit(): void;
	release(): void;
}

/** A cancelled pending stream cannot remove a preexisting or separately completed attachment. */
export class AttachLeaseRegistry {
	private readonly clients = new WeakMap<object, Map<string, { committed: boolean; pending: Set<object> }>>();

	acquire(
		client: object,
		activeSessionId: string,
		target: { has: () => boolean; add: () => void; delete: () => void },
	): AttachLease {
		let sessions = this.clients.get(client);
		if (!sessions) {
			sessions = new Map();
			this.clients.set(client, sessions);
		}
		let entry = sessions.get(activeSessionId);
		if (entry && !target.has()) {
			sessions.delete(activeSessionId);
			entry = undefined;
		}
		if (!entry) {
			entry = { committed: target.has(), pending: new Set() };
			sessions.set(activeSessionId, entry);
		}
		const current = entry;
		const map = sessions;
		const token = {};
		current.pending.add(token);
		target.add();
		let released = false;
		const finish = (commit: boolean) => {
			if (released) return;
			released = true;
			current.pending.delete(token);
			if (map.get(activeSessionId) !== current) return;
			if (commit) current.committed = true;
			if (!current.committed && current.pending.size === 0) target.delete();
			if (current.pending.size === 0) map.delete(activeSessionId);
		};
		return { commit: () => finish(true), release: () => finish(false) };
	}
}

export function attachWaiterCount(promise: Promise<unknown>): number {
	return observers.get(promise)?.waiters.size ?? 0;
}
