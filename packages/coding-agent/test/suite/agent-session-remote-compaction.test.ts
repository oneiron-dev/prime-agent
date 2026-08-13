import { type AssistantMessage, fauxAssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CompactionEntry, SessionManager } from "../../src/core/session-manager.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, type Harness } from "./harness.js";

const usage: Usage = {
	input: 80_000,
	output: 1_000,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 81_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function seedSession(harness: Harness): void {
	const model = harness.getModel() as Model<"openai-responses">;
	model.compat = { supportsResponsesCompact: true };
	harness.sessionManager.appendModelChange(model.provider, model.id, model.api);
	harness.sessionManager.appendMessage({ role: "user", content: "old request ".repeat(200), timestamp: 1 });
	const oldAssistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "old answer ".repeat(200) }],
		api: "openai-responses",
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: 2,
	};
	harness.sessionManager.appendMessage(oldAssistant);
	harness.sessionManager.appendMessage({ role: "user", content: "recent request", timestamp: 3 });
	harness.sessionManager.appendMessage({
		...oldAssistant,
		content: [{ type: "text", text: "recent answer" }],
		timestamp: 4,
	});
}

function appendTurn(harness: Harness, userText: string, assistantText: string): void {
	const model = harness.session.model ?? harness.getModel();
	harness.sessionManager.appendMessage({ role: "user", content: userText, timestamp: Date.now() });
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: assistantText }],
		api: "openai-responses",
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

function latestCompaction(harness: Harness): CompactionEntry {
	const entry = harness.sessionManager
		.getEntries()
		.filter((candidate) => candidate.type === "compaction")
		.at(-1);
	if (!entry || entry.type !== "compaction") throw new Error("missing compaction entry");
	return entry;
}

function compactResponse(encryptedContent = "opaque-ciphertext"): Response {
	return new Response(
		JSON.stringify({
			id: "resp_compact_1",
			object: "response.compaction",
			created_at: 1,
			output: [{ type: "compaction", id: "cmp_1", encrypted_content: encryptedContent }],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function v2StreamResponse(encryptedContent = "v2-opaque-ciphertext"): Response {
	const events = [
		{
			type: "response.output_item.done",
			item: {
				type: "compaction",
				id: "cmp_v2",
				encrypted_content: encryptedContent,
				future: { preserved: true },
			},
		},
		{ type: "response.completed", response: { id: "resp_v2", status: "completed" } },
	];
	const body = events
		.map(
			(event) => `event: ${event.type}
data: ${JSON.stringify(event)}

`,
		)
		.join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function requestUrl(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function enableV2(harness: Harness, both = false): Model<"openai-responses"> {
	const model = harness.session.model as Model<"openai-responses">;
	model.compat = {
		...(both ? { supportsResponsesCompact: true } : {}),
		supportsResponsesRemoteCompactionV2: true,
		supportsWebSocket: false,
	};
	return model;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("AgentSession remote Responses compaction", () => {
	it("persists and reloads one remote checkpoint without running local summarization", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			const fetchMock = vi.fn(async () => compactResponse());
			vi.stubGlobal("fetch", fetchMock);

			const result = await harness.session.compact();

			expect(result.mechanism).toBeUndefined();
			expect(result.remoteCompaction).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain("opaque-ciphertext");
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const entry = latestCompaction(harness);
			expect(entry.mechanism).toBe("remote");
			expect(entry.remoteCompaction?.version).toBe(1);
			expect(harness.sessionManager.buildSessionContext().messages[0]?.role).toBe("openaiResponsesCompaction");
			expect(harness.eventsOfType("compaction_end").at(-1)?.result?.mechanism).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("falls back once to local summary only for a concrete unsupported endpoint", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			harness.setResponses([
				fauxAssistantMessage("local fallback summary"),
				fauxAssistantMessage("local fallback turn summary"),
			]);
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								error: { message: "responses compact endpoint not found opaque-ciphertext", type: "not_found" },
							}),
							{ status: 404, headers: { "content-type": "application/json" } },
						),
				),
			);

			const result = await harness.session.compact();

			expect(result.mechanism).toBeUndefined();
			expect(result.fallback).toBeUndefined();
			expect(result.remoteCompaction).toBeUndefined();
			expect(harness.getPendingResponseCount()).toBe(0);
			const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
			expect(entries).toHaveLength(1);
			const entry = latestCompaction(harness);
			expect(entry.mechanism).toBe("local");
			expect(entry.fallback?.reason).toContain("HTTP 404");
			expect(JSON.stringify(result)).not.toContain("opaque-ciphertext");
			expect(JSON.stringify(entry)).not.toContain("opaque-ciphertext");
		} finally {
			harness.cleanup();
		}
	});

	it("carries a previous local summary into a local-to-remote transition", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			const recentUser = harness.sessionManager
				.getEntries()
				.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.content === "recent request",
				);
			if (!recentUser) throw new Error("missing recent user");
			harness.sessionManager.appendCompaction(
				"LOCAL PREVIOUS SUMMARY",
				recentUser.id,
				81_000,
				undefined,
				false,
				undefined,
				{
					mechanism: "local",
				},
			);
			appendTurn(harness, "new work ".repeat(100), "new result ".repeat(100));
			let compactBody: Record<string, unknown> | undefined;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
					compactBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return compactResponse("local-to-remote");
				}),
			);

			await harness.session.compact();

			expect(JSON.stringify(compactBody?.input)).toContain("LOCAL PREVIOUS SUMMARY");
			expect(latestCompaction(harness).mechanism).toBe("remote");
		} finally {
			harness.cleanup();
		}
	});

	it("replays the prior opaque checkpoint on remote-to-remote compaction", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			const bodies: Array<Record<string, unknown>> = [];
			const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return compactResponse(bodies.length === 1 ? "first-opaque" : "second-opaque");
			});
			vi.stubGlobal("fetch", fetchMock);
			await harness.session.compact();
			appendTurn(harness, "later work ".repeat(100), "later result ".repeat(100));
			await harness.session.compact();

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(JSON.stringify(bodies[1]?.input)).toContain("first-opaque");
			expect(latestCompaction(harness).remoteCompaction?.items).toEqual([
				{ type: "compaction", id: "cmp_1", encrypted_content: "second-opaque" },
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("reconstructs raw history for a remote-to-local endpoint fallback", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			let compactCalls = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					compactCalls++;
					if (compactCalls === 1) return compactResponse("first-opaque");
					return new Response(JSON.stringify({ error: { message: "compact endpoint unavailable" } }), {
						status: 404,
						headers: { "content-type": "application/json" },
					});
				}),
			);
			await harness.session.compact();
			appendTurn(harness, "later work ".repeat(100), "later result ".repeat(100));
			let localPrompt = "";
			const captureLocalPrompt = (context: { messages: unknown[] }) => {
				localPrompt += JSON.stringify(context.messages);
				return fauxAssistantMessage("remote to local summary");
			};
			harness.setResponses([captureLocalPrompt, captureLocalPrompt]);

			const result = await harness.session.compact();

			expect(result.mechanism).toBeUndefined();
			expect(result.fallback).toBeUndefined();
			expect(latestCompaction(harness).fallback?.reason).toBe("HTTP 404 compact endpoint unavailable");
			expect(localPrompt).toContain("old request");
			expect(localPrompt).not.toContain("first-opaque");
		} finally {
			harness.cleanup();
		}
	});

	it("rebuilds full history before compacting after a same-provider model switch", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			models: [{ id: "sol" }, { id: "terra" }],
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			const sol = harness.getModel("sol") as Model<"openai-responses">;
			const terra = harness.getModel("terra") as Model<"openai-responses">;
			sol.compat = { supportsResponsesCompact: true };
			terra.compat = { supportsResponsesCompact: true };
			harness.session.agent.state.model = sol;
			seedSession(harness);
			const bodies: Array<Record<string, unknown>> = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
					bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
					return compactResponse(bodies.length === 1 ? "sol-opaque" : "terra-opaque");
				}),
			);
			await harness.session.compact();
			harness.session.agent.state.model = terra;
			harness.sessionManager.appendModelChange(terra.provider, terra.id, terra.api);
			appendTurn(harness, "terra work ".repeat(100), "terra result ".repeat(100));
			await harness.session.compact();

			expect(JSON.stringify(bodies[1]?.input)).not.toContain("sol-opaque");
			expect(JSON.stringify(bodies[1]?.input)).toContain("old request");
			expect(latestCompaction(harness).remoteCompaction?.modelId).toBe("terra");
		} finally {
			harness.cleanup();
		}
	});

	it("prefers V2 over unary and persists a scoped, reloadable checkpoint without leaking it", async () => {
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getSystemPrompt = () => "V2 SYSTEM PROMPT";
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			persistSession: true,
			resourceLoader,
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			const model = enableV2(harness, true);
			const urls: string[] = [];
			let body: Record<string, unknown> | undefined;
			const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				urls.push(requestUrl(input));
				body = requestBody(init);
				return v2StreamResponse("v2-success-opaque");
			});
			vi.stubGlobal("fetch", fetchMock);

			const result = await harness.session.compact();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(urls).toEqual([expect.stringMatching(/\/responses$/)]);
			expect(urls.some((url) => url.includes("/responses/compact"))).toBe(false);
			expect(body).toMatchObject({ stream: true, store: false });
			expect(body?.previous_response_id).toBeUndefined();
			const requestInput = body?.input as Array<Record<string, unknown>>;
			expect(requestInput.at(-1)).toEqual({ type: "compaction_trigger" });
			expect(requestInput.filter((item) => item.type === "compaction_trigger")).toHaveLength(1);
			expect(JSON.stringify(requestInput)).toContain("old answer");
			expect(JSON.stringify(body)).toContain("V2 SYSTEM PROMPT");

			const entry = latestCompaction(harness);
			expect(entry.mechanism).toBe("remote");
			expect(entry.remoteCompaction).toMatchObject({
				version: 1,
				provider: model.provider,
				api: "openai-responses",
				modelId: model.id,
			});
			const items = entry.remoteCompaction?.items ?? [];
			expect(items.at(-1)).toMatchObject({
				type: "compaction",
				id: "cmp_v2",
				encrypted_content: "v2-success-opaque",
				future: { preserved: true },
			});
			expect(items.filter((item) => item.type === "compaction")).toHaveLength(1);
			for (const item of items.slice(0, -1)) {
				expect(item.type).toBe("message");
				expect(["user"]).toContain(item.role);
			}
			expect(JSON.stringify(items)).toContain("old request");
			expect(JSON.stringify(items)).not.toContain("V2 SYSTEM PROMPT");
			expect(JSON.stringify(items)).not.toContain("compaction-instructions");
			expect(items.slice(0, -1).every((item) => item.role === "user")).toBe(true);
			expect(JSON.stringify(items)).not.toContain("old answer");
			expect(JSON.stringify(result)).not.toContain("v2-success-opaque");
			expect(JSON.stringify(harness.eventsOfType("compaction_end").at(-1)?.result)).not.toContain(
				"v2-success-opaque",
			);

			const sessionFile = harness.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("missing persisted session file");
			const reopened = SessionManager.open(sessionFile);
			const reopenedEntry = reopened
				.getEntries()
				.filter((candidate) => candidate.type === "compaction")
				.at(-1);
			expect(reopenedEntry).toMatchObject({
				type: "compaction",
				mechanism: "remote",
				remoteCompaction: entry.remoteCompaction,
			});
			const replay = reopened
				.buildSessionContext()
				.messages.find((message) => message.role === "openaiResponsesCompaction");
			expect(replay).toMatchObject({
				provider: model.provider,
				model: model.id,
				items: entry.remoteCompaction?.items,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("falls back locally exactly once for a concrete V2 404 and never invokes unary", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			enableV2(harness);
			harness.setResponses([
				fauxAssistantMessage("V2 local fallback summary"),
				fauxAssistantMessage("V2 local fallback turn summary"),
			]);
			const urls: string[] = [];
			const fetchMock = vi.fn(async (input: string | URL | Request) => {
				urls.push(requestUrl(input));
				return new Response(JSON.stringify({ error: { message: "remote_compaction_v2 not found" } }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			});
			vi.stubGlobal("fetch", fetchMock);

			await harness.session.compact();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(urls).toEqual([expect.stringMatching(/\/responses$/)]);
			expect(urls.some((url) => url.includes("/responses/compact"))).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(0);
			const entry = latestCompaction(harness);
			expect(entry.mechanism).toBe("local");
			expect(entry.remoteCompaction).toBeUndefined();
			expect(entry.fallback).toEqual({ from: "remote", reason: "HTTP 404 remote compaction V2 unavailable" });
		} finally {
			harness.cleanup();
		}
	});

	it("surfaces V2 auth_unavailable without local fallback, unary calls, or persistence", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			enableV2(harness, true);
			harness.setResponses([
				fauxAssistantMessage("must remain queued"),
				fauxAssistantMessage("must also remain queued"),
			]);
			const urls: string[] = [];
			const fetchMock = vi.fn(async (input: string | URL | Request) => {
				urls.push(requestUrl(input));
				return new Response(JSON.stringify({ error: { message: "auth_unavailable", code: "auth_unavailable" } }), {
					status: 503,
					headers: { "content-type": "application/json" },
				});
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(harness.session.compact()).rejects.toMatchObject({ status: 503 });

			expect(fetchMock).toHaveBeenCalled();
			expect(urls.every((url) => /\/responses$/.test(url))).toBe(true);
			expect(urls.some((url) => url.includes("/responses/compact"))).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(2);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			const event = harness.eventsOfType("compaction_end").at(-1);
			expect(event).toMatchObject({ aborted: false, result: undefined });
			expect(event?.errorMessage).toContain("auth_unavailable");
		} finally {
			harness.cleanup();
		}
	});

	it("reports an SSE V2 cancellation as aborted without fallback or persistence", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			enableV2(harness);
			harness.setResponses([
				fauxAssistantMessage("must remain queued"),
				fauxAssistantMessage("must also remain queued"),
			]);
			let markStarted: () => void = () => {};
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			const urls: string[] = [];
			const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
				urls.push(requestUrl(input));
				markStarted();
				const signal = input instanceof Request ? input.signal : init?.signal;
				return new Promise<Response>((_resolve, reject) => {
					const rejectAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
					if (signal?.aborted) rejectAbort();
					else signal?.addEventListener("abort", rejectAbort, { once: true });
				});
			});
			vi.stubGlobal("fetch", fetchMock);

			const compactPromise = harness.session.compact();
			await started;
			harness.session.abortCompaction();
			await expect(compactPromise).rejects.toMatchObject({ name: "AbortError" });

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(urls).toEqual([expect.stringMatching(/\/responses$/)]);
			expect(urls.some((url) => url.includes("/responses/compact"))).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(2);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				aborted: true,
				result: undefined,
				errorMessage: undefined,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("rebuilds root history instead of replaying a foreign-model V2 checkpoint", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			models: [{ id: "sol" }, { id: "terra" }],
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			const sol = harness.getModel("sol") as Model<"openai-responses">;
			const terra = harness.getModel("terra") as Model<"openai-responses">;
			harness.session.agent.state.model = sol;
			seedSession(harness);
			sol.compat = { supportsResponsesRemoteCompactionV2: true, supportsWebSocket: false };
			terra.compat = { supportsResponsesRemoteCompactionV2: true, supportsWebSocket: false };
			const bodies: Array<Record<string, unknown>> = [];
			const urls: string[] = [];
			const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				urls.push(requestUrl(input));
				bodies.push(requestBody(init));
				return v2StreamResponse(bodies.length === 1 ? "sol-v2-opaque" : "terra-v2-opaque");
			});
			vi.stubGlobal("fetch", fetchMock);

			await harness.session.compact();
			harness.session.agent.state.model = terra;
			harness.sessionManager.appendModelChange(terra.provider, terra.id, terra.api);
			appendTurn(harness, "terra work ".repeat(100), "terra result ".repeat(100));
			await harness.session.compact();

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(urls.every((url) => /\/responses$/.test(url))).toBe(true);
			expect(JSON.stringify(bodies[1]?.input)).not.toContain("sol-v2-opaque");
			expect(JSON.stringify(bodies[1]?.input)).toContain("old request");
			expect(latestCompaction(harness).remoteCompaction).toMatchObject({
				provider: terra.provider,
				api: "openai-responses",
				modelId: terra.id,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("rejects strict remote mode when compatibility is not declared", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "remote", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			(harness.getModel() as Model<"openai-responses">).compat = {};
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			await expect(harness.session.compact()).rejects.toThrow("Remote compaction is not declared supported");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});
	it("replaces V2 checkpoints without persisting the first ciphertext", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			enableV2(harness);
			const bodies: Record<string, unknown>[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_i, init) => {
					bodies.push(requestBody(init));
					return v2StreamResponse(bodies.length === 1 ? "first-v2-opaque" : "second-v2-opaque");
				}),
			);
			await harness.session.compact();
			appendTurn(harness, "later", "result");
			await harness.session.compact();
			const items = latestCompaction(harness).remoteCompaction?.items ?? [];
			expect(JSON.stringify(bodies[1]?.input)).toContain("first-v2-opaque");
			expect(JSON.stringify(items)).not.toContain("first-v2-opaque");
			expect(items.filter((x) => x.type === "compaction")).toHaveLength(1);
			expect(items.at(-1)).toMatchObject({ encrypted_content: "second-v2-opaque" });
		} finally {
			harness.cleanup();
		}
	});
	it.each([
		[[], 0],
		[
			[
				{ type: "compaction", encrypted_content: "a" },
				{ type: "compaction", encrypted_content: "b" },
			],
			1,
		],
		[[{ type: "compaction", encrypted_content: "" }], 2],
		[[{ type: "compaction", encrypted_content: "a" }], 3],
		[[{ type: "compaction", encrypted_content: "a" }], 4],
	] as const)("does not persist malformed V2 stream", async (outputs, index) => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			enableV2(harness);
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			const urls: string[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) => {
					urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
					return new Response(
						outputs
							.map(
								(x) =>
									`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: x })}\n\n`,
							)
							.join("") +
							(index >= 3
								? index === 4
									? ""
									: `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "failed" } })}\n\n`
								: `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					);
				}),
			);
			await expect(harness.session.compact()).rejects.toThrow();
			expect(harness.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(0);
			expect(harness.getPendingResponseCount()).toBe(2);
			expect(urls).toHaveLength(1);
			expect(urls.every((url) => url.endsWith("/responses"))).toBe(true);
			expect(urls.some((url) => url.includes("/responses/compact"))).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
	it("keeps live custom instructions request-only across V2 compactions", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			settings: { compaction: { mode: "auto", keepRecentTokens: 1 } },
		});
		try {
			seedSession(harness);
			enableV2(harness);
			const bodies: Record<string, unknown>[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_i, init) => {
					bodies.push(requestBody(init));
					return v2StreamResponse();
				}),
			);
			await harness.session.compact("FOCUS_A");
			appendTurn(harness, "later", "result");
			await harness.session.compact("FOCUS_B");
			expect(JSON.stringify(bodies[0]?.input)).toContain("FOCUS_A");
			expect(JSON.stringify(bodies[1]?.input)).not.toContain("FOCUS_A");
			expect(JSON.stringify(bodies[1]?.input)).toContain("FOCUS_B");
			const stored = JSON.stringify(latestCompaction(harness).remoteCompaction?.items);
			expect(stored).not.toContain("FOCUS_A");
			expect(stored).not.toContain("FOCUS_B");
			expect(stored).not.toContain("compaction-instructions");
		} finally {
			harness.cleanup();
		}
	});
});
