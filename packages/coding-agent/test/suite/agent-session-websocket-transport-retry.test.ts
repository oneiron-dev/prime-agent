import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

// Both wordings the WebSocket transports produce for a drop before response.completed.
const CLOSED = "WebSocket closed before response.completed";
const STREAM_CLOSED = "WebSocket stream closed before response.completed";
const SOCKET_ERROR = "WebSocket error";

type TransportPhase = "before_message_stream_start" | "after_message_stream_start";

/** The message shape the Responses provider records for a WebSocket transport drop. */
function transportFailure(
	content: Parameters<typeof fauxAssistantMessage>[0],
	options: { errorMessage?: string; cause?: "closed" | "error" | "eof"; phase?: TransportPhase } = {},
): AssistantMessage {
	const errorMessage = options.errorMessage ?? CLOSED;
	const cause = options.cause ?? "closed";
	const phase = options.phase ?? "after_message_stream_start";
	const error = { name: "WebSocketTransportError", message: errorMessage };
	return {
		...fauxAssistantMessage(content, { stopReason: "error", errorMessage }),
		diagnostics: [
			{
				type: "provider_transport_failure",
				timestamp: Date.now(),
				error,
				details: {
					configuredTransport: "auto",
					eventsEmitted: phase === "after_message_stream_start",
					phase,
				},
			},
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				error,
				details: {
					kind: "transport",
					providerErrorType: `websocket_${cause}`,
					transport: { protocol: "websocket", cause },
				},
			},
		],
	};
}

function retrySettings(overrides: { maxRetries?: number; baseDelayMs?: number; enabled?: boolean } = {}) {
	return {
		retry: {
			enabled: overrides.enabled ?? true,
			maxRetries: overrides.maxRetries ?? 3,
			baseDelayMs: overrides.baseDelayMs ?? 1,
			// Quick retries only: the bounded provider-wait loop is a separate policy.
			provider: { waitForUsage: { enabled: false } },
		},
	};
}

function contextAssistantTexts(context: Context): string[] {
	return context.messages
		.filter((message): message is AssistantMessage => message.role === "assistant")
		.flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text));
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("AgentSession retry of mid-stream WebSocket transport failures", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function retryEvents(harness: Harness): string[] {
		return harness.events
			.filter((event) => event.type === "auto_retry_start" || event.type === "auto_retry_end")
			.map((event) =>
				event.type === "auto_retry_start"
					? `start:${event.attempt}:${event.errorMessage}`
					: `end:${event.success}:${event.attempt}${event.finalError ? `:${event.finalError}` : ""}`,
			);
	}

	it("retries a transport failure before any output streamed and recovers", async () => {
		const harness = await createHarness({ settings: retrySettings() });
		harnesses.push(harness);
		harness.setResponses([
			transportFailure("", { phase: "before_message_stream_start" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(2);
		expect(retryEvents(harness)).toEqual([`start:1:${CLOSED}`, "end:true:1"]);
		expect(getAssistantTexts(harness)).toEqual(["recovered"]);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("retries after text started without keeping or resending the partial text", async () => {
		const harness = await createHarness({ settings: retrySettings() });
		harnesses.push(harness);
		const retryContexts: string[][] = [];
		harness.setResponses([
			transportFailure([fauxThinking("planning"), fauxText("partial answer that was cut")]),
			(context) => {
				retryContexts.push(contextAssistantTexts(context));
				return fauxAssistantMessage("the complete answer");
			},
		]);

		await harness.session.prompt("explain");

		expect(harness.faux.state.callCount).toBe(2);
		expect(retryEvents(harness)).toEqual([`start:1:${CLOSED}`, "end:true:1"]);
		expect(retryContexts).toEqual([[]]);
		const assistants = harness.session.messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(getAssistantTexts(harness)).toEqual(["the complete answer"]);
	});

	it("retries during tool-call streaming without running the partial call or replaying the finished one", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool], settings: retrySettings() });
		harnesses.push(harness);
		let retryContext: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "first" })], { stopReason: "toolUse" }),
			// The second call's tool arguments were cut mid-stream.
			transportFailure([fauxToolCall("echo", { text: "sec" }, { id: "tool:cut" })]),
			(context) => {
				retryContext = context;
				return fauxAssistantMessage([fauxToolCall("echo", { text: "second" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("both echoed"),
		]);

		await harness.session.prompt("echo twice");

		expect(harness.faux.state.callCount).toBe(4);
		expect(retryEvents(harness)).toEqual([`start:1:${CLOSED}`, "end:true:1"]);
		// The cut tool call never ran; the finished one ran exactly once.
		expect(toolRuns).toEqual(["first", "second"]);
		expect(harness.eventsOfType("tool_execution_start").map((event) => event.args)).toEqual([
			{ text: "first" },
			{ text: "second" },
		]);
		// The retried request still carries the first tool's result, and no cut call.
		const toolResults = retryContext?.messages.filter((message) => message.role === "toolResult") ?? [];
		expect(toolResults).toHaveLength(1);
		expect(
			retryContext?.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "toolCall" && block.id === "tool:cut"),
			),
		).toBe(false);
		expect(getAssistantTexts(harness).filter((text) => text.length > 0)).toEqual(["both echoed"]);
	});

	it("stops after the configured retries and surfaces the last transport error", async () => {
		const harness = await createHarness({ settings: retrySettings({ maxRetries: 2 }) });
		harnesses.push(harness);
		harness.setResponses([
			transportFailure("", { cause: "closed" }),
			transportFailure("", { cause: "error", errorMessage: SOCKET_ERROR }),
			transportFailure("", { cause: "eof", errorMessage: STREAM_CLOSED }),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(3);
		expect(retryEvents(harness)).toEqual([
			`start:1:${CLOSED}`,
			`start:2:${SOCKET_ERROR}`,
			`end:false:2:${STREAM_CLOSED}`,
		]);
		const last = harness.session.messages.at(-1);
		expect(last?.role).toBe("assistant");
		expect((last as AssistantMessage).stopReason).toBe("error");
		expect((last as AssistantMessage).errorMessage).toBe(STREAM_CLOSED);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("cancelling during the backoff ends the retry without re-issuing the request", async () => {
		const harness = await createHarness({ settings: retrySettings({ baseDelayMs: 60_000 }) });
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") harness.session.abortRetry();
		});
		harness.setResponses([transportFailure([fauxText("cut")]), fauxAssistantMessage("never requested")]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(retryEvents(harness)).toEqual([`start:1:${CLOSED}`, "end:false:1:Retry cancelled"]);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each([
		["invalid_request", { kind: "invalid_request", status: 400 }],
		["refusal", { kind: "refusal" }],
		["permission", { kind: "permission", status: 403 }],
	])("keeps a permanent %s failure non-retryable even with a WebSocket-shaped message", async (_kind, details) => {
		const harness = await createHarness({ settings: retrySettings() });
		harnesses.push(harness);
		harness.setResponses([
			{
				...fauxAssistantMessage("", { stopReason: "error", errorMessage: CLOSED }),
				diagnostics: [{ type: "provider_stream_failure", timestamp: Date.now(), details }],
			},
			fauxAssistantMessage("never requested"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(retryEvents(harness)).toEqual([]);
	});

	it("keeps a local lifecycle failure non-retryable even when a transport drop is recorded too", async () => {
		const harness = await createHarness({ settings: retrySettings() });
		harnesses.push(harness);
		const failure = transportFailure("");
		failure.diagnostics = [
			...(failure.diagnostics ?? []),
			{ type: "agent_lifecycle_failure", timestamp: Date.now(), error: { message: "listener crashed" } },
		];
		harness.setResponses([failure, fauxAssistantMessage("never requested")]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(retryEvents(harness)).toEqual([]);
	});

	it("does not retry when retries are disabled", async () => {
		const harness = await createHarness({ settings: retrySettings({ enabled: false }) });
		harnesses.push(harness);
		harness.setResponses([transportFailure(""), fauxAssistantMessage("never requested")]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(retryEvents(harness)).toEqual([]);
	});

	describe("both observed error variants", () => {
		const variants: Array<[string, "closed" | "eof" | "error"]> = [
			[CLOSED, "closed"],
			[STREAM_CLOSED, "eof"],
			[SOCKET_ERROR, "error"],
		];

		it.each(variants)("retries %s with structured transport diagnostics", async (errorMessage, cause) => {
			const harness = await createHarness({ settings: retrySettings() });
			harnesses.push(harness);
			harness.setResponses([
				transportFailure([fauxThinking("thinking")], { errorMessage, cause }),
				fauxAssistantMessage("recovered"),
			]);

			await harness.session.prompt("hello");

			expect(harness.faux.state.callCount).toBe(2);
			expect(retryEvents(harness)).toEqual([`start:1:${errorMessage}`, "end:true:1"]);
			expect(getAssistantTexts(harness)).toEqual(["recovered"]);
		});

		it.each(variants)(
			"retries %s recorded by an older build without structured diagnostics",
			async (errorMessage) => {
				const harness = await createHarness({ settings: retrySettings() });
				harnesses.push(harness);
				harness.setResponses([
					fauxAssistantMessage("", { stopReason: "error", errorMessage }),
					fauxAssistantMessage("recovered"),
				]);

				await harness.session.prompt("hello");

				expect(harness.faux.state.callCount).toBe(2);
				expect(retryEvents(harness)).toEqual([`start:1:${errorMessage}`, "end:true:1"]);
			},
		);
	});

	describe("root and RLM child policy", () => {
		const CHILD_PROMPT = "do the child work";

		function userText(context: Context): string {
			return context.messages
				.filter((message) => message.role === "user")
				.map((user) =>
					typeof user.content === "string"
						? user.content
						: user.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
				)
				.join("\n");
		}

		/**
		 * Runs one in-process RLM child. Every provider call records the prompt it
		 * served, so the child's calls are told apart from the parent turn that the
		 * child's terminal message triggers afterwards.
		 */
		async function runChild(
			harness: Harness,
			childResponses: AssistantMessage[],
		): Promise<{
			status: string;
			answer: string | undefined;
			lastAssistant: AssistantMessage | undefined;
			served: string[];
		}> {
			const served: string[] = [];
			harness.setResponses([
				...childResponses.map((response) => (context: Context) => {
					served.push(userText(context));
					return response;
				}),
				(context: Context) => {
					served.push(userText(context));
					return fauxAssistantMessage("parent acknowledged the child");
				},
			]);
			const spawned = await harness.session.runRlmChild(CHILD_PROMPT);
			await waitFor(() => {
				const snapshot = harness.session.getRlmChildSnapshots().find((child) => child.id === spawned.rlm_child_id);
				return (
					(snapshot?.status === "done" || snapshot?.status === "error") && harness.getPendingResponseCount() === 0
				);
			});
			const snapshot = harness.session.getRlmChildSnapshots().find((child) => child.id === spawned.rlm_child_id);
			const childSession = harness.session.getRlmChildSession(spawned.rlm_child_id);
			const lastAssistant = childSession?.messages
				.filter((message): message is AssistantMessage => message.role === "assistant")
				.at(-1);
			return {
				status: snapshot?.status ?? "missing",
				answer: childSession?.getLastAssistantText(),
				lastAssistant,
				served,
			};
		}

		it("an RLM child retries a mid-stream transport drop under the shared policy and completes", async () => {
			const harness = await createHarness({ settings: retrySettings() });
			harnesses.push(harness);

			const child = await runChild(harness, [
				transportFailure([fauxText("cut child text")]),
				fauxAssistantMessage("child answer"),
			]);

			// Two child calls (the drop, then the retry), then the parent's turn on the result.
			expect(child.served).toHaveLength(3);
			expect(child.served.slice(0, 2).map((text) => text.includes(CHILD_PROMPT))).toEqual([true, true]);
			expect(child.status).toBe("done");
			expect(child.answer).toBe("child answer");
		});

		it("an RLM child stops retrying at the shared limit and reports the failure", async () => {
			const harness = await createHarness({ settings: retrySettings({ maxRetries: 1 }) });
			harnesses.push(harness);

			const child = await runChild(harness, [transportFailure(""), transportFailure("")]);

			// Exactly one retry, then the child's turn ends on the transport error and the run settles.
			expect(child.served).toHaveLength(3);
			expect(child.served.slice(0, 2).map((text) => text.includes(CHILD_PROMPT))).toEqual([true, true]);
			expect(child.status).toBe("done");
			expect(child.lastAssistant).toMatchObject({ stopReason: "error", errorMessage: CLOSED });
		});
	});
});
