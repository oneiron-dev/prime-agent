/**
 * Anthropic session-affinity parity capture: run the TS fork's
 * `streamAnthropic` against a loopback server for every case in
 * `tests/testdata/anthropic_session_affinity_ts.json` and print that fixture
 * again with the `ts` captures refreshed. The Rust test
 * `ts_capture_parity` replays the same inputs and compares the wire.
 *
 * Kept per request: every header the provider's header assembly produces,
 * lowercased, in wire order, and the parsed JSON body. Dropped: the headers
 * only the TS SDK client adds (`x-stainless-*`, its `Anthropic/JS`
 * user-agent, `content-type`) and transport framing (`host`, `connection`,
 * `accept-encoding`, `content-length`). A case's `messages` replaces the
 * default single user turn (the conversation cache-marker shapes).
 *
 * The provider loads from the current directory, which must be the root of
 * a disposable checkout of the TS fork at its deployed tip (bf4d2c6ca), never
 * the live install. From this repo's root:
 *   scratch=$(mktemp -d)
 *   git archive --format=tar --output="$scratch/ts.tar" bf4d2c6ca
 *   tar -xf "$scratch/ts.tar" -C "$scratch"
 *   bun install --cwd "$scratch" --ignore-scripts
 *   (cd "$scratch" && bun "$OLDPWD/crates/pa-ai/tests/differential/anthropic_affinity_ts_driver.ts" \
 *     "$OLDPWD/crates/pa-ai/tests/testdata/anthropic_session_affinity_ts.json") > fixture.new
 * then replace the fixture with `fixture.new` and run `ts_capture_parity`.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { streamAnthropic } = await import(
	pathToFileURL(join(process.cwd(), "packages/ai/src/providers/anthropic.ts")).href
);

type CaseInput = {
	provider?: string;
	apiKey?: string;
	compat?: Record<string, unknown>;
	modelHeaders?: Record<string, string>;
	sessionId?: string;
	cacheRetention?: "none" | "short" | "long";
	headers?: Record<string, string>;
	messages?: unknown[];
};

const SDK_OR_TRANSPORT = new Set(["content-type", "connection", "host", "accept-encoding", "content-length"]);

const sse =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
	'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const fixture = JSON.parse(readFileSync(process.argv[2], "utf8")) as { name: string; input: CaseInput }[];
const lines: string[] = [];
for (const { name, input } of fixture) {
	let captured: { headers: string[][]; body: unknown } | undefined;
	const server = createServer(async (request, response) => {
		const headers: string[][] = [];
		for (let i = 0; i < request.rawHeaders.length; i += 2) {
			const header = request.rawHeaders[i].toLowerCase();
			const value = request.rawHeaders[i + 1];
			if (SDK_OR_TRANSPORT.has(header) || header.startsWith("x-stainless-")) continue;
			if (header === "user-agent" && value.startsWith("Anthropic/JS")) continue;
			headers.push([header, value]);
		}
		captured = { headers, body: await readBody(request) };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(sse);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const model = {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: input.provider ?? "cpa-a",
		baseUrl: `http://127.0.0.1:${port}`,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		...(input.compat ? { compat: input.compat } : {}),
		...(input.modelHeaders ? { headers: input.modelHeaders } : {}),
	};
	const context = {
		systemPrompt: "You are terse.",
		messages: input.messages ?? [{ role: "user", content: "Say hello.", timestamp: 1 }],
		tools: [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		],
	};
	const stream = streamAnthropic(model as never, context as never, {
		apiKey: input.apiKey ?? "test-key",
		...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
		...(input.cacheRetention ? { cacheRetention: input.cacheRetention } : {}),
		...(input.headers ? { headers: input.headers } : {}),
	});
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (!captured) throw new Error(`case ${name}: no request captured`);
	lines.push(JSON.stringify({ name, input, ts: captured }));
}
process.stdout.write(`[\n${lines.join(",\n")}\n]\n`);
