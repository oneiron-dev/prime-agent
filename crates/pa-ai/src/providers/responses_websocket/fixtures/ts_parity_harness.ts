// TS reference harness (prime-agent bf4d2c6ca sources): drives
// streamOpenAIResponses over a scripted in-process WebSocket and prints the
// handshake headers, every request frame (exact JSON.stringify text), and
// every close the transport sent. No network: the fake socket answers, and
// the base URL points at a closed loopback port.
//
// Regenerate ts_parity.json (the Rust test
// `request_frames_match_the_ts_reference` compares against it):
//   git archive --format=tar -o ref.tar bf4d2c6ca packages/ai/src package.json packages/ai/package.json
//   tar -xf ref.tar -C <dir>; link <dir>/node_modules and <dir>/packages/ai/node_modules
//   to a TS checkout's installed dependencies; copy this file to <dir>/harness.ts
//   bun run <dir>/harness.ts > ts_parity.json
import { streamOpenAIResponses } from "./packages/ai/src/providers/openai-responses.ts";
import {
	closeOpenAIResponsesWebSocketSessions,
	setOpenAIResponsesWebSocketConstructorForTesting,
} from "./packages/ai/src/providers/openai-responses-websocket.ts";

type Listener = (event: unknown) => void;
const upgrades: { path: string; headers: [string, string][] }[] = [];
const frames: { connection: number; text: string }[] = [];
const closes: { connection: number; code?: number; reason?: string }[] = [];
const script: unknown[][] = [];
let nextConnection = 0;

class FakeSocket {
	readyState = 0;
	connection: number;
	listeners = new Map<string, Set<Listener>>();
	constructor(url: string, init?: { headers?: Record<string, string> }) {
		this.connection = ++nextConnection;
		const headers = Object.entries(init?.headers ?? {})
			.map(([name, value]) => [name.toLowerCase(), value] as [string, string])
			.sort(([a], [b]) => a.localeCompare(b));
		upgrades.push({ path: new URL(url).pathname, headers });
		setTimeout(() => {
			this.readyState = 1;
			this.emit("open", {});
		}, 0);
	}
	addEventListener(type: string, listener: Listener) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(listener);
	}
	removeEventListener(type: string, listener: Listener) {
		this.listeners.get(type)?.delete(listener);
	}
	emit(type: string, event: unknown) {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
	}
	send(data: string) {
		frames.push({ connection: this.connection, text: data });
		const events = script.shift() ?? [];
		let delay = 0;
		for (const event of events) {
			const remoteClose = (event as { remoteClose?: [number, string] }).remoteClose;
			if (remoteClose) {
				// The peer closes mid-response: the socket is gone, a later
				// local close is a no-op (WHATWG `close()` on CLOSED).
				setTimeout(() => {
					this.readyState = 3;
					this.emit("close", { code: remoteClose[0], reason: remoteClose[1], wasClean: true });
				}, ++delay);
				continue;
			}
			setTimeout(() => this.emit("message", { data: JSON.stringify(event) }), ++delay);
		}
	}
	close(code?: number, reason?: string) {
		if (this.readyState === 3) return;
		this.readyState = 3;
		closes.push({ connection: this.connection, code, reason });
		setTimeout(() => this.emit("close", { code: code ?? 1005, reason: reason ?? "", wasClean: true }), 0);
	}
}

const created = (id: string) => ({ type: "response.created", response: { id } });
const completed = (id: string) => ({
	type: "response.completed",
	response: { id, status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
});
const textResponse = (id: string, text: string) => [
	created(id),
	{
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] },
	},
	{
		type: "response.content_part.added",
		output_index: 0,
		content_index: 0,
		part: { type: "output_text", text: "" },
	},
	{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
	{
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "message",
			id: `msg_${id}`,
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text }],
		},
	},
	completed(id),
];
const toolResponse = (id: string, callId: string, marker: string) => {
	const args = JSON.stringify({ marker });
	return [
		created(id),
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", id: `fc_${id}`, call_id: callId, name: "probe", arguments: "" },
		},
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: args },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "function_call",
				id: `fc_${id}`,
				call_id: callId,
				name: "probe",
				arguments: args,
				status: "completed",
			},
		},
		completed(id),
	];
};

setOpenAIResponsesWebSocketConstructorForTesting(FakeSocket as never);
const model = {
	id: "gpt-ws",
	name: "gpt-ws",
	api: "openai-responses",
	provider: "cpa-r",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
	compat: { supportsWebSocket: true },
} as never;
const tools = [
	{
		name: "probe",
		description: "record a marker",
		parameters: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
	},
];
const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const options = { apiKey: "test-key", sessionId: "parity" };
const run = async (context: unknown) => {
	const message = await streamOpenAIResponses(model, context as never, options as never).result();
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(`unexpected ${message.stopReason}: ${message.errorMessage}`);
	}
	return message;
};

script.push(textResponse("resp_1", "first"));
script.push(toolResponse("resp_2", "call_1", "once"));
script.push(textResponse("resp_3", "after tool"));
script.push(textResponse("resp_4", "new prompt"));

const messages: unknown[] = [user("one")];
const first = await run({ systemPrompt: "sys", messages, tools });
messages.push(first, user("two"));
const second = await run({ systemPrompt: "sys", messages, tools });
messages.push(second, {
	role: "toolResult",
	toolCallId: (second.content.find((block) => block.type === "toolCall") as { id: string }).id,
	toolName: "probe",
	content: [{ type: "text", text: "probe ran once" }],
	isError: false,
	timestamp: 1,
});
const third = await run({ systemPrompt: "sys", messages, tools });
messages.push(third, user("three"));
await run({ systemPrompt: "changed sys", messages, tools });
closeOpenAIResponsesWebSocketSessions("parity");
await new Promise((resolve) => setTimeout(resolve, 10));

// A socket the peer closes mid-response (after the first events): the
// transport failure class, no SSE fallback, the persisted diagnostics.
script.push([...textResponse("resp_drop", "cut off").slice(0, 4), { remoteClose: [1011, "upstream reset"] }]);
const dropped = await streamOpenAIResponses(
	model,
	{ systemPrompt: "sys", messages: [user("drop")] } as never,
	{ apiKey: "test-key", sessionId: "parity-drop" } as never,
).result();
const strip = (diagnostic: Record<string, unknown>) => {
	const { timestamp: _timestamp, ...rest } = diagnostic;
	if (rest.error && typeof rest.error === "object") {
		const { stack: _stack, ...error } = rest.error as Record<string, unknown>;
		rest.error = error;
	}
	return rest;
};
const drop = {
	stopReason: dropped.stopReason,
	errorMessage: dropped.errorMessage,
	diagnostics: (dropped.diagnostics ?? []).map((diagnostic) => strip(diagnostic as never)),
};
closeOpenAIResponsesWebSocketSessions("parity-drop");
console.log(JSON.stringify({ upgrades, frames, closes, drop }, null, 2));
