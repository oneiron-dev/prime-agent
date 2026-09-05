import { resolve } from "node:path";
import { canonicalizePath } from "../../utils/paths.js";
import type {
	AgentConnectionSavedSessionInfo,
	AgentConnectionSessionListCallbacks,
} from "../agent-connection/types.js";
import type { DaemonTransportClient } from "../daemon/daemon-client.js";
import { type DaemonSavedSessionCatalogContext, listDaemonSavedSessions } from "../daemon/saved-session-catalog.js";

interface CatalogSubscriber {
	callbacks: AgentConnectionSessionListCallbacks;
	onError?: (error: unknown) => void;
}

/** One catalog scan retained across views; the owner disposes it after storing the result. */
export class SharedSavedCatalogRequest {
	readonly contextKey: string;
	readonly promise: Promise<AgentConnectionSavedSessionInfo[]>;
	isSettled = false;
	private disposed = false;
	private sessions = new Map<string, AgentConnectionSavedSessionInfo>();
	private progress: { loaded: number; total: number } | undefined;
	private subscribers = new Set<CatalogSubscriber>();

	constructor(
		readonly client: DaemonTransportClient,
		context: DaemonSavedSessionCatalogContext,
	) {
		this.contextKey = JSON.stringify(context);
		this.promise = listDaemonSavedSessions(client, context, "all", {
			onSession: (session) => {
				if (this.disposed || this.isSettled) return;
				const key = resolve(canonicalizePath(session.path));
				const previous = this.sessions.get(key);
				const merged = { ...session, usage: session.usage ?? previous?.usage };
				this.sessions.set(key, merged);
				for (const subscriber of [...this.subscribers]) {
					this.deliver(subscriber, () => subscriber.callbacks.onSession?.(merged));
				}
			},
			onProgress: (loaded, total) => {
				if (this.disposed || this.isSettled) return;
				this.progress = { loaded, total };
				for (const subscriber of [...this.subscribers]) {
					this.deliver(subscriber, () => subscriber.callbacks.onProgress?.(loaded, total));
				}
			},
		}).then(
			(sessions) => {
				this.isSettled = true;
				return sessions;
			},
			(error: unknown) => {
				this.isSettled = true;
				throw error;
			},
		);
	}

	getSessions(): readonly AgentConnectionSavedSessionInfo[] {
		return [...this.sessions.values()];
	}

	subscribe(callbacks: AgentConnectionSessionListCallbacks, onError?: (error: unknown) => void): () => void {
		if (this.disposed) return () => {};
		const subscriber = { callbacks, onError };
		this.subscribers.add(subscriber);
		try {
			for (const path of [...this.sessions.keys()]) {
				const session = this.sessions.get(path);
				if (session) this.deliver(subscriber, () => callbacks.onSession?.(session));
			}
			const progress = this.progress;
			if (progress) this.deliver(subscriber, () => callbacks.onProgress?.(progress.loaded, progress.total));
		} catch (error) {
			this.subscribers.delete(subscriber);
			throw error;
		}
		return () => this.subscribers.delete(subscriber);
	}

	dispose(): void {
		this.disposed = true;
		this.subscribers.clear();
		this.sessions.clear();
		this.progress = undefined;
	}

	private deliver(subscriber: CatalogSubscriber, callback: () => void): void {
		if (this.disposed || !this.subscribers.has(subscriber)) return;
		try {
			callback();
		} catch (error) {
			if (!subscriber.onError) throw error;
			subscriber.onError(error);
		}
	}
}
