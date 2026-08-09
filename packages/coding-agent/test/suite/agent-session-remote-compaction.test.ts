import { type AssistantMessage, fauxAssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionEntry } from "../../src/core/session-manager.js";
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
});
