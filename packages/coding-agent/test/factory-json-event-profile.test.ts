import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { ONEIRON_TRANSPORT_LIMITS, readOneironTransport } from "../src/factory/adapters/oneiron-transport.js";
import type { AgentConnection, AgentConnectionEvent } from "../src/modes/agent-connection/types.js";
import { runPrintModeWithConnection } from "../src/modes/print-mode.js";

const output = vi.hoisted(() => ({ chunks: [] as string[] }));
vi.mock("../src/core/output-guard.js", () => ({
	writeRawStdout: (text: string) => output.chunks.push(text),
	flushRawStdout: async () => {},
}));
const roots: string[] = [];
afterEach(() => {
	output.chunks.length = 0;
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const assistant = {
	role: "assistant",
	provider: "cpa-r",
	model: "gpt-6-astra",
	responseModel: "gpt-6-astra",
	responseModelSource: "provider-response",
	responseId: "resp_complete",
	stopReason: "stop",
	content: [{ type: "text", text: "complete native content" }],
};
async function emit(events: object[], profile?: "all" | "factory-completed") {
	let listener: ((event: AgentConnectionEvent) => void) | undefined;
	const connection = {
		getSessionHeader: async () => ({ type: "session", id: "fixture", timestamp: "2026-09-06", cwd: "/fixture" }),
		subscribe: (fn: typeof listener) => {
			listener = fn;
			return () => {
				listener = undefined;
			};
		},
		promptAndWait: async () => {
			for (const event of events) listener?.({ type: "session_event", event } as AgentConnectionEvent);
		},
		waitForHeadlessCompletion: async () => ({
			enabled: false,
			limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80000, timeoutMs: 1800000 },
		}),
		dispose: async () => {},
	} as unknown as AgentConnection;
	const code = await runPrintModeWithConnection(connection, {
		mode: "json",
		initialMessage: "fixture",
		jsonEventProfile: profile,
	});
	const directory = mkdtempSync(join(tmpdir(), "factory-json-profile-"));
	roots.push(directory);
	const path = join(directory, "writer.jsonl");
	writeFileSync(path, output.chunks.join(""));
	return { code, path, events: output.chunks.map((line) => JSON.parse(line) as Record<string, unknown>) };
}
test("factory completed profile drops over 256 MiB of progressive snapshots before serialization", async () => {
	const snapshot = {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "x".repeat(65536) }] },
	};
	const update = {
		type: "tool_execution_update",
		toolCallId: "call",
		toolName: "fixture",
		args: {},
		partialResult: { content: [{ type: "text", text: "x".repeat(65536) }] },
	};
	const repeats = 2048;
	const oldBytes =
		repeats * (Buffer.byteLength(JSON.stringify(snapshot)) + Buffer.byteLength(JSON.stringify(update)) + 2);
	expect(oldBytes).toBeGreaterThan(ONEIRON_TRANSPORT_LIMITS.rawBytes);
	const stringify = vi.fn(() => {
		throw new Error("progressive snapshot must not be serialized");
	});
	Object.assign(snapshot, { toJSON: stringify });
	Object.assign(update, { toJSON: stringify });
	const complete = [
		{ type: "message_end", message: assistant },
		{
			type: "tool_execution_end",
			toolCallId: "call",
			toolName: "fixture",
			result: { content: [{ type: "text", text: "final tool output" }] },
			isError: false,
		},
		{ type: "turn_end", message: assistant, toolResults: [] },
		{ type: "agent_end", messages: [assistant] },
	];
	const actual = await emit(
		[
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "tool_execution_start", toolCallId: "call", toolName: "fixture", args: {} },
			...Array.from({ length: repeats }, () => [snapshot, update]).flat(),
			...complete,
		],
		"factory-completed",
	);
	expect(actual.code).toBe(0);
	expect(stringify).not.toHaveBeenCalled();
	expect(actual.events.slice(-complete.length)).toEqual(complete);
	expect(actual.events[0]).toMatchObject({ jsonEventProfile: "factory-completed" });
	const read = readOneironTransport(actual.path);
	expect(read.rawBytes).toBeLessThan(4096);
	expect(read.messages).toEqual([
		{
			provider: assistant.provider,
			model: assistant.model,
			responseId: assistant.responseId,
			responseModel: assistant.responseModel,
			responseModelSource: assistant.responseModelSource,
			stopReason: assistant.stopReason,
		},
	]);
});

test.each([undefined, "all"] as const)(
	"default/nonfactory JSON still emits both progressive events: %s",
	async (profile) => {
		const events = [
			{ type: "message_update", message: { role: "assistant", content: [] } },
			{ type: "tool_execution_update", toolCallId: "call", partialResult: { content: [] } },
			{ type: "message_end", message: assistant },
		];
		const actual = await emit(events, profile);
		expect(actual.code).toBe(0);
		expect(actual.events.slice(1)).toEqual(events);
		expect(actual.events[0]).not.toHaveProperty("jsonEventProfile");
	},
);
test.each(["error", "aborted"])(
	"factory profile preserves failed completed events without inventing success: %s",
	async (stopReason) => {
		const message = { ...assistant, stopReason, errorMessage: "fixture failure" };
		const complete = [
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_end", message },
			{ type: "agent_end", messages: [message] },
		];
		const actual = await emit(complete, "factory-completed");
		expect(actual.events.slice(1)).toEqual(complete);
		expect(readOneironTransport(actual.path).messages[0]!.stopReason).toBe(stopReason);
	},
);
test("incomplete profile streams keep their boundary and reader rejects without a fabricated terminal", async () => {
	const events = [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", message: { role: "assistant", content: [] } },
	];
	const actual = await emit(events, "factory-completed");
	expect(actual.events.map((event) => event.type)).toEqual(["session", "agent_start", "message_start"]);
	expect(() => readOneironTransport(actual.path)).toThrow(/Partial transport/);
});
test("genuine oversized completed content is not dropped and fails the unchanged line cap", async () => {
	const message = { ...assistant, content: [{ type: "text", text: "x".repeat(ONEIRON_TRANSPORT_LIMITS.lineBytes) }] };
	const actual = await emit([{ type: "message_end", message }], "factory-completed");
	expect(actual.events[1]).toEqual({ type: "message_end", message });
	expect(() => readOneironTransport(actual.path)).toThrow(/lineBytes=.* exceeds limit=8388608/);
	expect(readFileSync(actual.path).length).toBeGreaterThan(ONEIRON_TRANSPORT_LIMITS.lineBytes);
});
test("native CLI parses explicit profiles and rejects unsupported or non-JSON selection", () => {
	for (const argv of [
		["--mode", "json", "--json-event-profile", "factory-completed"],
		["--json-event-profile=factory-completed", "--mode", "json"],
	]) {
		const parsed = parseArgs(argv);
		expect(parsed.jsonEventProfile).toBe("factory-completed");
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.unknownFlags.size).toBe(0);
	}
	for (const argv of [
		["--mode", "json", "--json-event-profile", "typo"],
		["--mode", "json", "--json-event-profile"],
		["--json-event-profile", "factory-completed"],
		["--mode", "rpc", "--json-event-profile", "factory-completed"],
	])
		expect(parseArgs(argv).diagnostics.some((item) => item.type === "error")).toBe(true);
	expect(parseArgs(["--mode", "json"]).jsonEventProfile).toBeUndefined();
});
