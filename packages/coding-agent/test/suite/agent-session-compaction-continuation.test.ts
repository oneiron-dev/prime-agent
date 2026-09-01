/**
 * Regression tests: the agent must keep working after an auto-compaction that interrupted
 * unfinished work. BUG A: a skipped/failed threshold compaction that stopped a tool loop must
 * resume it. BUG B: an assistant-text-turn threshold stop reads as "task finished", so an
 * active goal queues its continuation as a session input before compaction.
 */
import type { AgentMessage, ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import { createHarness, type Harness } from "./harness.js";

type SessionInternals = {
	_shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => Promise<boolean>;
	_performCompaction: (options: {
		model: unknown;
		apiKey: string;
		headers?: Record<string, string>;
		customInstructions?: string;
		signal: AbortSignal;
	}) => Promise<unknown>;
	_continueAfterThresholdCompaction: boolean;
};

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: { stopReason?: AssistantMessage["stopReason"]; totalTokens?: number; timestamp?: number },
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", { stopReason: options.stopReason, timestamp: options.timestamp }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

/** Faux ipython tool that services goal.* host requests like the real kernel bridge. */
function createFauxIpythonTool(sessionRef: { current?: AgentSession }) {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python code in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId: string, params: unknown) => {
			const session = sessionRef.current;
			if (!session) throw new Error("test session is not initialized");
			const code = (params as { code: string }).code.trim();
			let text = "";
			if (code.startsWith("goal.")) {
				const spaceIndex = code.indexOf(" ");
				const type = spaceIndex < 0 ? code : code.slice(0, spaceIndex);
				const payload = spaceIndex < 0 ? {} : JSON.parse(code.slice(spaceIndex + 1));
				text = JSON.stringify(session.handleGoalHostRequest(type, payload));
			}
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	};
}

describe("compaction continuation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function midToolLoopContext(harness: Harness): ShouldStopAfterTurnContext {
		const assistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 250_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "big",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			assistant,
			toolResult,
		];
		harness.session.agent.state.messages = messages;
		return {
			message: assistant,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [assistant, toolResult],
		};
	}

	it("resumes the interrupted tool loop when a threshold compaction is skipped", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		const context = midToolLoopContext(harness);

		// toolResult-last makes the session stop the loop for compaction AND continue afterwards.
		const shouldStop = await internals._shouldStopAfterTurn(context);
		expect(shouldStop).toBe(true);
		expect(internals._continueAfterThresholdCompaction).toBe(true);

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		// The in-memory session has no persisted entries, so _performCompaction throws CompactionSkippedError.
		await internals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(500);

		const endEvents = harness.eventsOfType("compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0].errorMessage).toContain("skipped");

		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("control: a skipped requested compaction mid tool loop does resume", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		midToolLoopContext(harness);
		internals._continueAfterThresholdCompaction = true;

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		await internals._runAutoCompaction("requested", false);
		await vi.advanceTimersByTimeAsync(500);

		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("e2e: tool loop interrupted by a skipped threshold compaction resumes", async () => {
		const bigTool = {
			name: "big",
			label: "big",
			description: "returns big text",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "x".repeat(40_000) }],
				details: {},
			}),
		};
		const harness = await createHarness({
			tools: [bigTool],
			// Huge keepRecentTokens: prepareCompaction finds nothing to summarize and throws CompactionSkippedError.
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1_000_000 } },
			models: [{ id: "faux-1", contextWindow: 6_000 }],
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer after the tool call"),
		]);

		await harness.session.prompt("run the tool then summarize");
		await new Promise((resolve) => setTimeout(resolve, 300));
		await harness.session.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toContain("threshold");
		expect(harness.eventsOfType("compaction_end")[0]?.errorMessage).toContain("skipped");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("headless idle includes a successful post-compaction continuation", async () => {
		const bigTool = {
			name: "big",
			label: "big",
			description: "returns big text",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "x".repeat(40_000) }],
				details: {},
			}),
		};
		const harness = await createHarness({
			tools: [bigTool],
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 6_000 }],
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer after successful compaction"),
		]);

		await harness.session.prompt("run the tool then summarize");
		await harness.session.waitForHeadlessIdle();

		expect(harness.eventsOfType("compaction_end").find((event) => event.result)?.result).toBeDefined();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getLastAssistantText()).toBe("final answer after successful compaction");
	});

	it("headless idle includes a successful continuation after remote compaction", async () => {
		const bigTool = {
			name: "big",
			label: "big",
			description: "returns big text",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "x".repeat(40_000) }],
				details: {},
			}),
		};
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			tools: [bigTool],
			settings: { compaction: { enabled: true, mode: "auto", reserveTokens: 500, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 6_000 }],
			persistSession: true,
		});
		harnesses.push(harness);
		const model = harness.session.model as Model<"openai-responses">;
		model.compat = { ...model.compat, supportsResponsesCompact: true };
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						id: "resp_compact_continuation",
						object: "response.compaction",
						created_at: 1,
						output: [
							{
								type: "compaction",
								id: "cmp_continuation",
								encrypted_content: "opaque-continuation-checkpoint",
							},
						],
						usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer after successful remote compaction"),
		]);

		await harness.session.prompt("run the tool then summarize remotely");
		await harness.session.waitForHeadlessIdle();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const compaction = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "compaction")
			.at(-1);
		if (!compaction || compaction.type !== "compaction") throw new Error("missing compaction entry");
		expect(compaction.mechanism).toBe("remote");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getLastAssistantText()).toBe("final answer after successful remote compaction");
	});

	it("rejects headless idle waiters when a continuation cannot start", async () => {
		vi.useFakeTimers();
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
		};
		vi.spyOn(harness.session.agent, "continue").mockRejectedValueOnce(new Error("continuation failed"));

		sessionInternals._schedulePostCompactionContinue();
		const idle = harness.session.waitForHeadlessIdle();
		const rejectedIdle = expect(idle).rejects.toThrow("continuation failed");
		await vi.advanceTimersByTimeAsync(100);

		await rejectedIdle;
	});

	it("does not expose a failed continuation to later headless idle waiters", async () => {
		vi.useFakeTimers();
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
		};
		vi.spyOn(harness.session.agent, "continue").mockRejectedValueOnce(new Error("continuation failed"));

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(100);

		await expect(harness.session.waitForHeadlessIdle()).resolves.toBeUndefined();
	});

	// BUG B (end-to-end): unlike the tests above, the threshold compaction here SUCCEEDS.
	it("e2e: an active goal keeps continuing after a successful threshold compaction", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			// Let a running goal continuation cross the threshold while remaining well below overflow.
			settings: { compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 10_000 }],
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		sessionRef.current = harness.session;
		const largeStep = "x".repeat(3_500);
		harness.setResponses([
			fauxAssistantMessage(`step one done, more to do ${largeStep}`),
			fauxAssistantMessage(`step two done, still more to do ${largeStep}`),
			fauxAssistantMessage(`step three done, still not finished ${largeStep}`),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "goal.complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");
		await vi.waitFor(
			() => {
				const compactionReasons = harness.eventsOfType("compaction_start").map((event) => event.reason);
				expect(compactionReasons).toContain("threshold");
				expect(compactionReasons).not.toContain("overflow");
				expect(harness.eventsOfType("compaction_end").find((event) => event.result)?.result).toBeDefined();
				expect(harness.getPendingResponseCount()).toBe(0);
				expect(harness.session.goalState.status).toBe("complete");
			},
			{ timeout: 5_000 },
		);
	});

	// With both drivers active the goal continuation takes exclusive priority, matching _getContinuationMessages.
	it("queues only the goal continuation when a goal and autonomous mode are both active", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			autonomous: { enabled: true, maxContinuations: 5 },
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		sessionRef.current = harness.session;
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the task" });
		const internals = harness.session as unknown as SessionInternals;
		const context = midToolLoopContext(harness);

		const shouldStop = await internals._shouldStopAfterTurn(context);
		expect(shouldStop).toBe(true);
		expect(internals._continueAfterThresholdCompaction).toBe(true);

		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	// A user-cancelled compaction must withdraw the goal continuation queued for it.
	it("withdraws the queued goal continuation when the threshold compaction is cancelled", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		sessionRef.current = harness.session;
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the task" });
		const internals = harness.session as unknown as SessionInternals;
		const context = midToolLoopContext(harness);

		const shouldStop = await internals._shouldStopAfterTurn(context);
		expect(shouldStop).toBe(true);
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);

		vi.spyOn(internals, "_performCompaction").mockRejectedValue(new Error("Compaction cancelled"));
		await internals._runAutoCompaction("threshold", false);

		const endEvents = harness.eventsOfType("compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0].aborted).toBe(true);
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.goalState.continuationsUsed).toBe(0);

		// The cancellation must not consume the continuation: the next natural threshold stop re-queues it.
		const shouldStopAgain = await internals._shouldStopAfterTurn(context);
		expect(shouldStopAgain).toBe(true);
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);
	});

	// Disposing a session while a provider compaction is still in flight must settle it.
	// A stalled provider response never has to answer, so disposal itself must cancel.
	it("settles an in-flight compaction when the session is disposed and stops compacting", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		let deliveredSignal: AbortSignal | undefined;
		vi.spyOn(internals, "_performCompaction").mockImplementation(
			({ signal }) =>
				new Promise((_resolve, reject) => {
					deliveredSignal = signal;
					signal.addEventListener("abort", () => {
						const error = new Error("Request was aborted");
						error.name = "AbortError";
						reject(error);
					});
				}),
		);

		const settled = harness.session.compact().then(
			() => "resolved" as const,
			(error: unknown) => error,
		);
		const startedAt = Date.now();
		while (!deliveredSignal && Date.now() - startedAt < 2000) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(deliveredSignal, "compaction never reached the provider").toBeDefined();
		expect(harness.session.isCompacting).toBe(true);

		harness.session.dispose();

		const DEADLINE = Symbol("deadline");
		const outcome = await Promise.race([
			settled,
			new Promise((resolve) => setTimeout(() => resolve(DEADLINE), 1000)),
		]);
		expect(outcome, "the disposed session's compaction never settled").not.toBe(DEADLINE);
		expect(outcome).toMatchObject({ name: "AbortError" });
		expect(deliveredSignal!.aborted).toBe(true);
		expect(harness.session.isCompacting).toBe(false);
	});

	// A stale marker (continuation already consumed, goal completed) must not be rolled back.
	it("keeps completed-goal bookkeeping when a later threshold compaction is cancelled", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		sessionRef.current = harness.session;
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the task" });
		const internals = harness.session as unknown as SessionInternals;
		const context = midToolLoopContext(harness);

		await internals._shouldStopAfterTurn(context);
		expect(harness.session.goalState.continuationsUsed).toBe(1);

		// Completing the goal clears the queued continuation but leaves the marker stale.
		harness.session.handleGoalHostRequest("goal.complete");
		expect(harness.session.queuedActionCount).toBe(0);

		const shouldStop = await internals._shouldStopAfterTurn(context);
		expect(shouldStop).toBe(true);
		vi.spyOn(internals, "_performCompaction").mockRejectedValue(new Error("Compaction cancelled"));
		await internals._runAutoCompaction("threshold", false);

		expect(harness.session.goalState.status).toBe("complete");
		expect(harness.session.goalState.continuationsUsed).toBe(1);
	});
});
