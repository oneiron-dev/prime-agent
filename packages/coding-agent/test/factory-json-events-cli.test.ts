import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { readOneironTransport } from "../src/factory/adapters/oneiron-transport.js";
import { factoryOwnedEnvironment } from "../src/factory/runtime.js";

const directories: string[] = [];
const servers: Server[] = [];
const fixturePath = resolve("test/fixtures/factory-json-events-cli-fixture.ts");
const requestedModel = "fixture-requested-alias";
const responseModel = "fixture-native-model";
const chunks = ["Native ", "completed ", "response."];

type NativeEvent = { type: string; message?: AssistantMessage };

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function runFixture(outcome: "completed" | "failed" | "cancelled" = "completed") {
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			requests.push({ path: request.url ?? "", body: JSON.parse(body) as Record<string, unknown> });
			response.writeHead(200, { "content-type": "text/event-stream" });
			const send = (event: Record<string, unknown>) =>
				response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			send({
				type: "response.created",
				response: { id: "resp_created", model: requestedModel, status: "in_progress" },
			});
			send({
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_fixture", role: "assistant", status: "in_progress", content: [] },
			});
			send({
				type: "response.content_part.added",
				output_index: 0,
				content_index: 0,
				item_id: "msg_fixture",
				part: { type: "output_text", text: "", annotations: [] },
			});
			for (const delta of chunks)
				send({
					type: "response.output_text.delta",
					output_index: 0,
					content_index: 0,
					item_id: "msg_fixture",
					delta,
				});
			if (outcome === "cancelled") return;
			if (outcome === "failed") {
				send({
					type: "response.failed",
					response: { error: { code: "invalid_request_error", message: "fixture provider failure" } },
				});
				response.end();
				return;
			}
			send({
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_fixture",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: chunks.join(""), annotations: [] }],
				},
			});
			send({
				type: "response.completed",
				response: {
					id: "resp_terminal",
					model: responseModel,
					status: "completed",
					usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
				},
			});
			response.end();
		});
	});
	servers.push(server);
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind");

	const directory = mkdtempSync(join(tmpdir(), "factory-json-cli-"));
	directories.push(directory);
	const agentDir = join(directory, "agent");
	const cwd = join(directory, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					api: "openai-responses",
					apiKey: "fixture-not-a-secret",
					models: [{ id: requestedModel, reasoning: false, input: ["text"] }],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			transport: "sse",
			retry: { enabled: false, provider: { maxRetries: 0 } },
			autoRefine: { enabled: false },
		}),
	);
	const workerPath = join(directory, "worker.json");
	const args = [
		"--print",
		"--mode",
		"json",
		"--json-event-profile",
		"factory-completed",
		"--provider",
		"fixture",
		"--model",
		requestedModel,
		"--offline",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-themes",
		"--system-prompt",
		"Return the fixture response.",
		"fixture prompt",
	];
	const child = spawn(
		process.execPath,
		["--import", resolve("../../node_modules/tsx/dist/loader.mjs"), fixturePath, ...args],
		{
			cwd,
			// Do not inherit credentials, provider routes, daemon roles or shared config.
			env: {
				PATH: process.env.PATH,
				HOME: directory,
				TMPDIR: directory,
				XDG_CONFIG_HOME: directory,
				XDG_CACHE_HOME: directory,
				DO_NOT_TRACK: "1",
				TSX_TSCONFIG_PATH: resolve("../../tsconfig.json"),
				PRIME_AGENT_CODING_AGENT_DIR: agentDir,
				FACTORY_JSON_EVENTS_WORKER: workerPath,
				...factoryOwnedEnvironment(),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "",
		stderr = "";
	let cancellationSent = false;
	child.stdout.on("data", (bytes: Buffer) => {
		stdout += bytes.toString();
		if (outcome !== "cancelled" || cancellationSent) return;
		const completeLines = stdout.split("\n").slice(0, -1);
		const assistantStarted = completeLines.some((line) => {
			if (!line) return false;
			const event = JSON.parse(line) as NativeEvent;
			return event.type === "message_start" && event.message?.role === "assistant";
		});
		if (assistantStarted) {
			cancellationSent = true;
			child.kill("SIGTERM");
		}
	});
	child.stderr.on("data", (bytes: Buffer) => {
		stderr += bytes.toString();
	});
	const code = await new Promise<number | null>((done, fail) => {
		let timedOut = false;
		let escalation: NodeJS.Timeout | undefined;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
		}, 20000);
		const cleanup = () => {
			clearTimeout(timeout);
			clearTimeout(escalation);
		};
		child.once("error", (error) => {
			cleanup();
			fail(error);
		});
		child.once("close", (exitCode) => {
			cleanup();
			if (timedOut) fail(new Error(`CLI fixture timed out: ${stderr}\n${stdout}`));
			else done(exitCode);
		});
	});
	const transcript = join(directory, "events.jsonl");
	writeFileSync(transcript, stdout);
	const events = stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as NativeEvent);
	return {
		code,
		stderr,
		transcript,
		events,
		requests,
		worker: JSON.parse(readFileSync(workerPath, "utf8")) as Record<string, unknown>,
		frontendPid: child.pid,
		args,
	};
}

test("real CLI owned frontend propagates factory-completed through main and print to native transport", async () => {
	const result = await runFixture();
	expect(result.code, result.stderr).toBe(0);
	expect(result.worker).toMatchObject({
		ppid: result.frontendPid,
		execPath: process.execPath,
		entry: fixturePath,
		args: result.args,
		profile: "json",
		ipc: true,
	});
	expect(result.worker.pid).not.toBe(result.frontendPid);
	expect(result.worker.lease).toMatch(/^owned-/);
	expect(result.requests).toHaveLength(1);
	expect(result.requests[0]).toMatchObject({ path: "/v1/responses", body: { model: requestedModel, stream: true } });
	expect(result.requests[0].body.tools ?? []).toEqual([]);
	expect(result.events[0]).toMatchObject({ type: "session", jsonEventProfile: "factory-completed" });
	expect(result.events.map((event) => event.type)).not.toContain("message_update");
	const lifecycle = result.events.filter((event) =>
		["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"].includes(event.type),
	);
	expect(lifecycle.map((event) => event.type)).toEqual([
		"agent_start",
		"turn_start",
		"message_start",
		"message_end",
		"message_start",
		"message_end",
		"turn_end",
		"agent_end",
	]);
	const terminal = result.events.filter(
		(event) => event.type === "message_end" && event.message?.role === "assistant",
	);
	expect(terminal).toHaveLength(1);
	expect(terminal[0].message).toMatchObject({
		provider: "fixture",
		model: requestedModel,
		responseId: "resp_terminal",
		responseModel,
		responseModelSource: "provider-response",
		stopReason: "stop",
		content: [{ type: "text", text: chunks.join("") }],
		usage: { input: 2, output: 3, totalTokens: 5 },
	});
	expect(readOneironTransport(result.transcript)).toMatchObject({
		eventCount: result.events.length,
		messages: [
			{
				provider: "fixture",
				model: requestedModel,
				responseId: "resp_terminal",
				responseModel,
				responseModelSource: "provider-response",
				stopReason: "stop",
			},
		],
	});
}, 30000);

test("factory-completed retains native provider failure boundaries without successful identity", async () => {
	const result = await runFixture("failed");
	expect(result.requests).toHaveLength(1);
	expect(result.events.map((event) => event.type)).not.toContain("message_update");
	const terminal = result.events.filter(
		(event) => event.type === "message_end" && event.message?.role === "assistant",
	);
	expect(terminal).toHaveLength(1);
	expect(terminal[0].message).toMatchObject({
		provider: "fixture",
		model: requestedModel,
		responseId: "resp_created",
		stopReason: "error",
	});
	expect(terminal[0].message?.errorMessage).toContain("fixture provider failure");
	expect(terminal[0].message?.responseModel).toBeUndefined();
	expect(terminal[0].message?.responseModelSource).toBeUndefined();
	expect(result.events.slice(-2).map((event) => event.type)).toEqual(["turn_end", "agent_end"]);
	expect(readOneironTransport(result.transcript).messages).toEqual([
		{ provider: "fixture", model: requestedModel, responseId: "resp_created", stopReason: "error" },
	]);
}, 30000);

test("SIGTERM retains an incomplete assistant start and never invents completed boundaries", async () => {
	const result = await runFixture("cancelled");
	expect(result.code, result.stderr).toBe(143);
	expect(result.requests).toHaveLength(1);
	expect(result.events.map((event) => event.type)).not.toContain("message_update");
	expect(
		result.events.filter((event) => event.type === "message_start" && event.message?.role === "assistant"),
	).toHaveLength(1);
	expect(
		result.events.filter((event) => event.type === "message_end" && event.message?.role === "assistant"),
	).toHaveLength(0);
	expect(result.events.map((event) => event.type)).not.toContain("turn_end");
	expect(result.events.map((event) => event.type)).not.toContain("agent_end");
	expect(() => readOneironTransport(result.transcript)).toThrow(/Partial transport lifecycle/);
}, 30000);
