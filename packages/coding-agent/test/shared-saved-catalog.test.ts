import { describe, expect, it, vi } from "vitest";
import type { AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/types.js";
import { SharedSavedCatalogRequest } from "../src/modes/agents-view/shared-saved-catalog.js";
import type { DaemonClientRequestOptions, DaemonTransportClient } from "../src/modes/daemon/daemon-client.js";
import type { DaemonCommand, DaemonResponse, DaemonSavedSessionInfo } from "../src/modes/daemon/daemon-protocol.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function session(overrides: Partial<DaemonSavedSessionInfo> = {}): DaemonSavedSessionInfo {
	return {
		path: "/tmp/sessions/one.jsonl",
		id: "one",
		cwd: "/tmp/project",
		created: "2026-01-01T00:00:00.000Z",
		modified: "2026-01-02T00:00:00.000Z",
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
		...overrides,
	};
}

function harness() {
	const response = deferred<DaemonResponse>();
	let options: DaemonClientRequestOptions = {};
	const request = vi.fn((_command: DaemonCommand, _timeout: number, requestOptions: DaemonClientRequestOptions) => {
		options = requestOptions;
		return response.promise;
	});
	const client = { request } as unknown as DaemonTransportClient;
	const catalog = new SharedSavedCatalogRequest(client, { cwd: "/tmp/project" });
	return {
		catalog,
		response,
		request,
		emitSession: (value: DaemonSavedSessionInfo) =>
			options.onProgress?.({ type: "session_list_item", command: "list_saved_sessions", session: value }),
		emitProgress: (loaded: number, total: number) =>
			options.onProgress?.({ type: "session_list_progress", command: "list_saved_sessions", loaded, total }),
	};
}

describe("shared saved catalog", () => {
	it("replays the latest row and retained usage in the settled failure window before owner disposal", async () => {
		const { catalog, response, request, emitSession, emitProgress } = harness();
		const usage = { inputTokens: 120, outputTokens: 30, cost: 0.25 };
		emitSession(session({ path: "/tmp/sessions/./one.jsonl", name: "Original", usage }));
		emitSession(session({ name: "Renamed" }));
		emitProgress(1, 4);
		emitProgress(2, 4);
		const rows: AgentConnectionSavedSessionInfo[] = [];
		const progress: Array<[number, number]> = [];
		const failure = new Error("catalog scan failed");
		const owner = catalog.promise.catch((error: unknown) => {
			expect(error).toBe(failure);
			expect(rows).toHaveLength(1);
			catalog.dispose();
		});
		// Resume between the helper's settlement reaction and the owner's disposal reaction.
		const resumedView = response.promise
			.catch(() => undefined)
			.then(() => {
				expect(catalog.isSettled).toBe(true);
				catalog.subscribe({
					onSession: (row) => rows.push(row),
					onProgress: (loaded, total) => progress.push([loaded, total]),
				});
			});
		response.reject(failure);
		await Promise.all([owner, resumedView]);

		expect(rows[0]).toMatchObject({ path: "/tmp/sessions/one.jsonl", name: "Renamed", usage });
		expect(progress).toEqual([[2, 4]]);
		expect(request).toHaveBeenCalledTimes(1);
		expect(catalog.getSessions()).toEqual([]);
		const afterDisposal = vi.fn();
		catalog.subscribe({ onSession: afterDisposal, onProgress: afterDisposal });
		expect(afterDisposal).not.toHaveBeenCalled();
	});

	it("reports observer errors without poisoning another subscriber or the shared request", async () => {
		const { catalog, response, emitSession } = harness();
		const observerFailure = new Error("observer failed");
		const onError = vi.fn();
		const rows: AgentConnectionSavedSessionInfo[] = [];
		emitSession(session({ name: "Original" }));
		expect(() =>
			catalog.subscribe(
				{
					onSession: () => {
						throw observerFailure;
					},
				},
				onError,
			),
		).not.toThrow();
		catalog.subscribe({ onSession: (row) => rows.push(row) });
		expect(() => emitSession(session({ name: "Renamed" }))).not.toThrow();
		response.resolve({
			type: "response",
			command: "list_saved_sessions",
			success: true,
			data: { sessions: [session({ name: "Renamed" })] },
		});
		await expect(catalog.promise).resolves.toMatchObject([{ name: "Renamed" }]);
		expect(onError).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenNthCalledWith(1, observerFailure);
		expect(onError).toHaveBeenNthCalledWith(2, observerFailure);
		expect(rows.map((row) => row.name)).toEqual(["Original", "Renamed"]);
		catalog.dispose();
	});

	it("disposal removes listeners and replay data while the raw request finishes", async () => {
		const { catalog, response, emitSession, emitProgress } = harness();
		const observer = vi.fn();
		catalog.subscribe({ onSession: observer, onProgress: observer });
		emitSession(session());
		expect(observer).toHaveBeenCalledTimes(1);
		catalog.dispose();
		emitSession(session({ name: "Late" }));
		emitProgress(4, 4);
		catalog.subscribe({ onSession: observer, onProgress: observer });
		expect(observer).toHaveBeenCalledTimes(1);
		expect(catalog.getSessions()).toEqual([]);
		response.resolve({ type: "response", command: "list_saved_sessions", success: true, data: { sessions: [] } });
		await expect(catalog.promise).resolves.toEqual([]);
		expect(catalog.isSettled).toBe(true);
	});
});
