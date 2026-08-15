import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model } from "../src/types.js";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

const context: Context = {
	messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
};

function createModel(baseUrl: string, compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

async function captureAnthropicRequest(
	compat: Model<"anthropic-messages">["compat"],
	options: Parameters<typeof streamAnthropic>[2],
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;
	const server = createServer(async (request, response) => {
		capturedRequest = { headers: request.headers, body: await readRequestBody(request) };
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		const requestStream = streamAnthropic(createModel(`http://127.0.0.1:${address.port}`, compat), context, {
			apiKey: "test-key",
			...options,
		});
		for await (const event of requestStream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	if (!capturedRequest) throw new Error("Anthropic request was not captured");
	return capturedRequest;
}

describe("Anthropic session-affinity headers", () => {
	it("sends affinity headers for opted-in cached sessions without request metadata", async () => {
		const request = await captureAnthropicRequest({ sendSessionAffinityHeaders: true }, { sessionId: "session-123" });
		expect(request.headers["x-client-request-id"]).toBe("session-123");
		expect(request.headers["x-session-affinity"]).toBe("session-123");
		expect(request.body.metadata).toBeUndefined();
	});

	it("omits affinity headers unless the provider opts in, the session is present, and caching is enabled", async () => {
		const cases = [
			{ compat: undefined, options: { sessionId: "session-123" } },
			{ compat: { sendSessionAffinityHeaders: false }, options: { sessionId: "session-123" } },
			{ compat: { sendSessionAffinityHeaders: true }, options: {} },
			{
				compat: { sendSessionAffinityHeaders: true },
				options: { sessionId: "session-123", cacheRetention: "none" as const },
			},
		];

		for (const testCase of cases) {
			const request = await captureAnthropicRequest(testCase.compat, testCase.options);
			expect(request.headers["x-client-request-id"]).toBeUndefined();
			expect(request.headers["x-session-affinity"]).toBeUndefined();
		}
	});

	it("lets explicit request headers override generated affinity headers", async () => {
		const request = await captureAnthropicRequest(
			{ sendSessionAffinityHeaders: true },
			{
				sessionId: "session-123",
				headers: { "x-client-request-id": "explicit-request", "x-session-affinity": "explicit-affinity" },
			},
		);
		expect(request.headers["x-client-request-id"]).toBe("explicit-request");
		expect(request.headers["x-session-affinity"]).toBe("explicit-affinity");
	});
});
