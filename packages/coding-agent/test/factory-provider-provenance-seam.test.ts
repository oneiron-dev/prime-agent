import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import { streamAnthropic } from "../../ai/src/providers/anthropic.js";
import { streamOpenAIResponses } from "../../ai/src/providers/openai-responses.js";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import type { OneironManifest } from "../src/factory/adapters/oneiron.js";
import { readOneironTransport } from "../src/factory/adapters/oneiron-transport.js";
import {
	defaultOneironWriterProfile,
	type OneironWriterStage,
	summarizeOneironWriter,
} from "../src/factory/adapters/oneiron-writer.js";
import { runPrintMode } from "../src/modes/print-mode.js";
import { createHarness, type Harness } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.js";

const output = vi.hoisted(() => ({ chunks: [] as string[] }));
vi.mock("../src/core/output-guard.js", () => ({
	writeRawStdout: (text: string) => output.chunks.push(text),
	flushRawStdout: async () => {},
}));
const harnesses: Harness[] = [];
const servers: Server[] = [];
const requested = "gpt-6-astra";
function selfReport(reportedModel?: string): string {
	return reportedModel === "claude-fable-5.1"
		? "I am GPT-6 Astra. My serving identity is Astra. This text is not transport provenance."
		: "I am Claude Fable 5.1. My serving identity is Fable. This text is not transport provenance.";
}

type Transport = "anthropic" | "responses";
function events(transport: Transport, reportedModel?: string): Array<Record<string, unknown>> {
	if (transport === "anthropic")
		return [
			{
				type: "message_start",
				message: {
					id: "msg_fixture_response",
					type: "message",
					role: "assistant",
					...(reportedModel ? { model: reportedModel } : {}),
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 2, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: selfReport(reportedModel) } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			},
			{ type: "message_stop" },
		];
	return [
		// Created-event aliases are not serving proof; only the terminal response model qualifies.
		{ type: "response.created", response: { id: "resp_fixture_created", model: requested, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "message_fixture", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			item_id: "message_fixture",
			part: { type: "output_text", text: "", annotations: [] },
		},
		{
			type: "response.output_text.delta",
			output_index: 0,
			content_index: 0,
			item_id: "message_fixture",
			delta: selfReport(reportedModel),
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "message_fixture",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: selfReport(reportedModel), annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_fixture_terminal",
				status: "completed",
				...(reportedModel ? { model: reportedModel } : {}),
				usage: { input_tokens: 2, output_tokens: 5, total_tokens: 7 },
			},
		},
	];
}
async function fixture(transport: Transport, reportedModel?: string) {
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			requests.push({ path: request.url ?? "", body: JSON.parse(body) as Record<string, unknown> });
			response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "fixture-http-request" });
			for (const event of events(transport, reportedModel))
				response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			response.end();
		});
	});
	servers.push(server);
	await new Promise<void>((resolveReady, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveReady);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind a port");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const harness = await createHarness({
		provider: "cpa-r",
		models: [{ id: requested, reasoning: true }],
		persistSession: true,
		tools: [],
		settings: { retry: { enabled: false } },
	});
	harnesses.push(harness);
	// Keep real agent/session behavior. Replace only the provider route with a local HTTP stream.
	harness.session.agent.streamFn = (model, context, options) =>
		transport === "anthropic"
			? streamAnthropic({ ...model, api: "anthropic-messages", baseUrl }, context, {
					...options,
					apiKey: "fixture-not-a-secret",
					maxRetries: 0,
				})
			: streamOpenAIResponses({ ...model, api: "openai-responses", baseUrl }, context, {
					...options,
					apiKey: "fixture-not-a-secret",
					maxRetries: 0,
					transport: "sse",
				});
	const services = {
		cwd: harness.tempDir,
		agentDir: join(harness.tempDir, "agent"),
		authStorage: harness.authStorage,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		resourceLoader: createTestResourceLoader(),
		mcpManager: new McpManager({ authStorage: harness.authStorage, getUserServers: () => ({}) }),
		diagnostics: [],
	};
	const runtime = new AgentSessionRuntime(harness.session, services, async () => {
		throw new Error("Fixture cannot replace runtimes");
	});
	output.chunks.length = 0;
	expect(await runPrintMode(runtime, { mode: "json", initialMessage: "Return the fixture response." })).toBe(0);
	const transcript = output.chunks.join("");
	const emitted = transcript
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type?: string; message?: AssistantMessage });
	const terminal = emitted.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
	expect(terminal).toHaveLength(1);
	const message = terminal[0].message!;
	expect(message.stopReason).toBe("stop");
	expect(message.model).toBe(requested);
	expect(message.content).toContainEqual(expect.objectContaining({ type: "text", text: selfReport(reportedModel) }));
	expect(requests).toHaveLength(1);
	expect(requests[0].path).toContain(transport === "anthropic" ? "/messages" : "/responses");
	expect(requests[0].body.model).toBe(requested);
	const sessionFile = harness.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Fixture must persist the event to a real session file");
	const saved = readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type?: string; message?: AssistantMessage })
		.find((entry) => entry.type === "message" && entry.message?.role === "assistant")?.message;
	expect(saved).toMatchObject(message);
	const placeholderPin = { path: join(harness.tempDir, "not-read.json"), sha256: "a".repeat(64) };
	const profile = defaultOneironWriterProfile(placeholderPin);
	const stage: OneironWriterStage = {
		kind: "writer",
		prompt: placeholderPin,
		triage: placeholderPin,
		writerProfile: placeholderPin,
	};
	const manifest: OneironManifest = {
		version: 1,
		ticketId: "FIXTURE",
		owner: "fixture-owner",
		source: {
			workspace: harness.tempDir,
			head: "a".repeat(40),
			tree: "b".repeat(40),
			branch: "fixture",
			remoteUrl: "https://example.invalid/fixture.git",
			fingerprint: `git:${"c".repeat(64)}`,
		},
		factoryDirectory: harness.tempDir,
		ownerPauseFile: join(harness.tempDir, "OWNER-PAUSE"),
		custody: placeholderPin,
		outputDirectory: join(harness.tempDir, "output"),
		stage,
	};
	mkdirSync(manifest.outputDirectory);
	const transcriptPath = join(manifest.outputDirectory, "writer.jsonl");
	writeFileSync(transcriptPath, transcript, { flag: "wx" });
	return {
		message,
		provenance: summarizeOneironWriter(
			manifest,
			stage,
			profile,
			readOneironTransport(transcriptPath),
			"d".repeat(64),
		),
	};
}
afterEach(async () => {
	for (const server of servers.splice(0))
		await new Promise<void>((resolveClose, reject) => {
			server.closeAllConnections();
			server.close((error) => (error ? reject(error) : resolveClose()));
		});
	for (const harness of harnesses.splice(0)) harness.cleanup();
	output.chunks.length = 0;
});

test.each([
	["anthropic", "gpt-6-astra", "astra"],
	["anthropic", "claude-fable-5.1", "fable"],
	["responses", "gpt-6-astra", "astra"],
	["responses", "claude-fable-5.1", "fable"],
] as const)(
	"%s wire identity %s survives print JSON without bypassing the Astra-only writer policy",
	async (transport, responseModel, family) => {
		const { message, provenance } = await fixture(transport, responseModel);
		expect(message.responseModel).toBe(responseModel);
		expect(message.responseModelSource).toBe("provider-response");
		expect(message.responseId).toBe(transport === "anthropic" ? "msg_fixture_response" : "resp_fixture_terminal");
		expect(provenance.identityAccepted).toBe(responseModel === "gpt-6-astra");
		expect(provenance.requested).toEqual({ provider: "cpa-r", model: requested, effort: "xhigh" });
		if (responseModel === "claude-fable-5.1") expect(provenance.blockers).not.toEqual([]);
		expect(provenance.responseModels).toEqual([responseModel]);
		expect(provenance.observations[0].family).toBe(family);
		expect(provenance.upstreamIdentityAttested).toBe(false);
	},
);

test.each(["anthropic", "responses"] as const)(
	"%s model text cannot manufacture missing transport provenance",
	async (transport) => {
		const { message, provenance } = await fixture(transport);
		expect(message.responseModel).toBeUndefined();
		expect(message.responseModelSource).toBeUndefined();
		expect(provenance.identityAccepted).toBe(false);
		expect(provenance.responseModels).toEqual([]);
		expect(provenance.observations[0]).toMatchObject({ responseModel: null, source: "unknown", family: "unknown" });
		expect(provenance.blockers).not.toEqual([]);
	},
);
