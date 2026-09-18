import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { DECISION_QUESTIONS_V8, DECISION_QUESTIONS_V8_SHA256 } from "../src/factory/adapters/decision-questions-v8.js";
import {
	createJevTypedDecisionCaller,
	JEV_DECISION_THRESHOLDS,
	JEV_REASON_LIMITS,
} from "../src/factory/adapters/jev-typed-decision.js";
import {
	codeDecisionBase,
	type DecisionReceipt,
	type FactoryDecision,
	recordDecision,
} from "../src/factory/decisions.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { manageFactoryWake } from "../src/factory/management-dispatch.js";
import { FactoryStore } from "../src/factory/store.js";
import type { FactoryAdapter } from "../src/factory/types.js";
import { fixtureRuntimePin } from "./factory-runtime-fixture.js";

const servers: Server[] = [],
	stores: FactoryStore[] = [],
	directories: string[] = [];
const neverText = () => {
	throw new Error("Typed requests must not use ManagementCaller");
};
const transport: FactoryAdapter = {
	async launch({ attempt, action }) {
		return {
			kind: "terminal",
			receipt: {
				attemptId: attempt.id,
				sourceFingerprint: action.sourceFingerprint,
				exitCode: 0,
				finishedAt: new Date().toISOString(),
			},
		};
	},
	async inspect() {
		throw new Error("No inspections");
	},
};
function noul(p: number) {
	return {
		model: "jev-1.13.0",
		answers: { q: { type: "noul", noul: p } },
		usage: { input_tokens: 10, output_tokens: 2 },
	};
}
function choice(confidence: number) {
	return {
		model: "jev-1.13.0",
		answers: {
			q: {
				type: "choice",
				choice: "move_to_mac_portable",
				confidence,
				probabilities: { move_to_mac_portable: 0.7, wait_current_slot: 0.2, move_to_free_linux_slot: 0.1 },
			},
		},
	};
}
function advice(decision = "adopt_dirty", reason = "Retained revision and authority are bound", model = "grok-4.6") {
	return {
		model,
		choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ decision, confidence: 0.9, reason }) } }],
		usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 } },
	};
}
async function fixture() {
	vi.stubEnv("TYPESAFE_JEV_API_KEY", "fixture-not-a-secret");
	vi.stubEnv("FACTORY_ADVISOR_API_KEY", "fixture-not-a-secret");
	vi.stubEnv("FACTORY_ADVISOR_MODEL", "grok-4.6");
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	let jev: unknown = noul(0.9),
		advisor: unknown = advice();
	let during: ((request: IncomingMessage, response: ServerResponse) => boolean) | undefined;
	const server = createServer((req, res) => {
		let text = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			text += chunk;
		});
		req.on("end", () => {
			requests.push({ path: req.url ?? "", body: JSON.parse(text) });
			if (during?.(req, res)) return;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(req.url === "/v1/systemone" ? jev : advisor));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No loopback port");
	const base = `http://127.0.0.1:${address.port}`;
	vi.stubEnv("FACTORY_ADVISOR_BASE_URL", `${base}/v1`);
	const directory = mkdtempSync(join(tmpdir(), "factory-jev-"));
	directories.push(directory);
	const store = new FactoryStore(join(directory, "factory.db"));
	stores.push(store);
	const engine = new FactoryEngine(store, transport, { enabled: true });
	engine.applyPlan({
		version: 1,
		tickets: [{ id: "t", owner: "owner" }],
		slots: [{ id: "s", host: "local" }],
		actions: [
			{
				id: "a",
				ticketId: "t",
				kind: "decision",
				dependencies: [],
				sourceFingerprint: "candidate",
				command: { argv: ["fixture"], cwd: directory },
				requirements: { runtime: fixtureRuntimePin },
			},
		],
	});
	await engine.tick();
	const state: FactoryDecision = {
		...codeDecisionBase(store.ledgerSequence(), "Structured facts"),
		type: "baseline_adoption",
		retained_revision: "revision",
		fingerprint: "candidate",
		dirty_paths_count: 1,
		authority_record: { path: "/fixture/authority", sha: "a".repeat(64) },
		authorship_proof: "unknown",
		known_defects: [],
		prior_green_candidate: null,
	};
	const create = (check: () => void) => createJevTypedDecisionCaller(check, { jevUrl: `${base}/v1/systemone` });
	const run = (decision: FactoryDecision = state) =>
		manageFactoryWake(engine, { directory, actionId: "a", typedDecision: decision }, neverText, create);
	return {
		base,
		directory,
		store,
		engine,
		state,
		requests,
		create,
		run,
		setJev: (value: unknown) => {
			jev = value;
		},
		setAdvisor: (value: unknown) => {
			advisor = value;
		},
		during: (fn: typeof during) => {
			during = fn;
		},
	};
}
function receipt(directory: string): DecisionReceipt {
	return JSON.parse(readFileSync(join(directory, "decision.json"), "utf8"));
}
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const server of servers.splice(0))
		await new Promise<void>((resolve, reject) => {
			server.closeAllConnections();
			server.close((error) => (error ? reject(error) : resolve()));
		});
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test.each([
	[0.9, "adopt_dirty"],
	[0.1, "restart_clean"],
	[0.65, "adopt_dirty"],
	[0.35, "restart_clean"],
])("Jev decides p=%s and records facts", async (p, outcome) => {
	const f = await fixture();
	f.setJev(noul(Number(p)));
	const result = await f.run(),
		saved = receipt(result.evidenceDirectory!);
	expect(result.kind).toBe("proposed");
	expect(saved.outcome).toBe(outcome);
	expect(saved.decision.decided_by).toBe("jev");
	expect(saved.decision.reason).toContain(`p=${p}`);
	expect(saved.decision.reason).toContain('"retained_revision":"revision"');
	expect(saved.jev).toMatchObject({ model: "jev-1.13.0", probability: p, usage: { input: 10, output: 2, total: 12 } });
	expect(saved.advisor).toBeUndefined();
	expect(saved.accounting).toMatchObject({ calls: 1, cost_usd: null, priced: false });
	expect(f.requests).toHaveLength(1);
	expect(f.requests[0].path).toBe("/v1/systemone");
	expect(f.requests[0].body.state).toBe(JSON.stringify(f.state));
	expect(f.requests[0].body.model).toBe("jev-latest");
	const questions = JSON.parse(DECISION_QUESTIONS_V8),
		q = questions.baseline_adoption;
	expect(f.requests[0].body.questions).toEqual({
		q: { type: "noul", instructions: { ...q.instructions, policy: q.policy }, criteria: q.criteria },
	});
	expect(saved.question_set).toEqual({
		version: "v8-structured-plus-rule",
		sha256: createHash("sha256").update(DECISION_QUESTIONS_V8).digest("hex"),
	});
	expect(saved.question_set?.sha256).toBe(DECISION_QUESTIONS_V8_SHA256);
	expect(DECISION_QUESTIONS_V8_SHA256).toBe("e8f3b387d380643d88f82b82763d8d79a53bdcadcab332f51e5a17d274394a65");
	expect(f.store.managementRequests()[0].result).toEqual(saved);
	expect(f.store.wakes().some((w) => w.reason.startsWith("profile_drift:"))).toBe(false);
});

test.each(["one large field", "combined field budget"])("large valid states stay with Jev: %s", async (mode) => {
	const f = await fixture();
	const state: FactoryDecision = {
		...f.state,
		reason: "Previous judgment",
		known_defects: Array.from({ length: 400 }, () => "d".repeat(72)),
		...(mode === "combined field budget"
			? {
					retained_revision: "r".repeat(6000),
					fingerprint: "f".repeat(6000),
					authority_record: { path: "p".repeat(6000), sha: "s".repeat(6000) },
					authorship_proof: "a".repeat(6000),
					prior_green_candidate: "g".repeat(6000),
				}
			: {}),
	};
	expect(Buffer.byteLength(JSON.stringify(state))).toBeGreaterThan(30_000);
	const result = await f.run(state),
		saved = receipt(result.evidenceDirectory!);
	expect(result.kind).toBe("proposed");
	expect(saved.outcome).toBe("adopt_dirty");
	expect(saved.decision.decided_by).toBe("jev");
	expect(saved.decision.reason).toMatch(/^p=0.9; fields=/);
	expect(saved.decision.reason).toMatch(/…\[truncated \d+ chars\]/);
	expect(saved.decision.reason).not.toContain("Previous judgment");
	expect(saved.decision.reason).not.toContain("invalid response");
	expect(saved.decision.reason.length).toBeLessThanOrEqual(JEV_REASON_LIMITS.totalChars);
	if (mode === "combined field budget") expect(saved.decision.reason).toMatch(/…\[truncated \d+ chars\]$/);
	else expect(saved.decision.reason).toContain('"prior_green_candidate":null');
	expect(f.requests).toHaveLength(1);
	expect(f.requests[0].body.state).toBe(JSON.stringify(state));
	expect(saved.advisor).toBeUndefined();
});

test("band uses the same criteria and retains advisor reason, effort, usage and price", async () => {
	const f = await fixture();
	f.setJev(noul(0.5));
	const result = await f.run(),
		saved = receipt(result.evidenceDirectory!);
	expect(saved.decision.reason).toBe("Retained revision and authority are bound");
	expect(saved.decision.decided_by).toBe("advisor");
	expect(saved.advisor).toMatchObject({
		model: "grok-4.6",
		effort: "medium",
		decision: "adopt_dirty",
		confidence: 0.9,
		usage: { input: 15, output: 4, cache_read: 5, cache_write: 0, total: 24 },
	});
	expect(saved.advisor?.cost_usd).not.toBeNull();
	expect(saved.accounting.calls).toBe(2);
	expect(saved.accounting.cost_usd).toBeNull();
	expect(saved.wall_clock_ms).toBeGreaterThanOrEqual(0);
	expect(f.requests[1]).toMatchObject({
		path: "/v1/chat/completions",
		body: { model: "grok-4.6", reasoning_effort: "medium" },
	});
	const messages = f.requests[1].body.messages as Array<{ content: string }>;
	expect(JSON.parse(messages[1].content)).toMatchObject({
		state: f.requests[0].body.state,
		questions: f.requests[0].body.questions,
	});
});

test.each(
	(["writer_terminal_accept", "test_gate_accept", "scope"] as const).flatMap((type) =>
		[0.1, 0.3, 0.5, 0.65, 0.9].map((p) => ({ type, p })),
	),
)("$type p=$p leaves only confident yes with Jev", async ({ type, p }) => {
	const f = await fixture();
	f.setJev(noul(p));
	const outcome = type === "scope" ? "in_scope" : "accept";
	f.setAdvisor(advice(outcome, "Advisor checked the family criteria"));
	const state: FactoryDecision =
		type === "writer_terminal_accept"
			? f.store.typedDecisions().find((r) => r.decision.type === type)!.decision
			: type === "test_gate_accept"
				? {
						...codeDecisionBase(f.store.ledgerSequence(), "Gate facts"),
						type,
						gate_kind: "process",
						attempt_id: f.store.attempts()[0].id,
						candidate_fingerprint: "candidate",
						receipt_fingerprint: "candidate",
						exit_code: 0,
						wrapper_rc: 0,
						tests: { run: 1, passed: 1, failed: 0, skipped: 0 },
						provenance_pass: true,
						source_unchanged: true,
						criteria: { min_tests: 1, forbidden_replay_of: null, required_pin: null },
						is_replay: false,
					}
				: {
						...codeDecisionBase(f.store.ledgerSequence(), "Scope facts"),
						type,
						target_repo: "/fixture/repo",
						changed_paths: ["src/fix.ts"],
						allowlist: { id: "approved", sha: "a".repeat(64), verdict_for_repo: true },
						amendment_record: "none",
						blueprint_scope_paths: ["src"],
						delegation_covers_path_expansion: false,
					};
	const result = await f.run({ ...state, ledger_sequence: f.store.ledgerSequence() });
	const byJev = p >= JEV_DECISION_THRESHOLDS.yes;
	expect(result.kind).toBe("proposed");
	expect(result.typedDecision?.outcome).toBe(outcome);
	expect(result.typedDecision?.decision.decided_by).toBe(byJev ? "jev" : "advisor");
	expect(result.typedDecision?.decision.reason).toContain(
		byJev ? `p=${p}; fields=` : "Advisor checked the family criteria",
	);
	expect(f.requests).toHaveLength(byJev ? 1 : 2);
});

test.each([0.6, 0.65, 0.9])("choice confidence %s routes without reducing its three options", async (confidence) => {
	const f = await fixture();
	f.setJev(choice(confidence));
	f.setAdvisor(advice("move_to_mac_portable"));
	const state = f.store.typedDecisions().find((r) => r.decision.type === "build_host")!.decision;
	const result = await f.run({ ...state, ledger_sequence: f.store.ledgerSequence() });
	expect(result.typedDecision?.outcome).toBe("move_to_mac_portable");
	expect(result.typedDecision?.jev?.probabilities).toHaveProperty("wait_current_slot", 0.2);
	expect(f.requests).toHaveLength(confidence < 0.65 ? 2 : 1);
});

test.each([
	null,
	"unparseable",
	{ prompt_tokens: "twenty", completion_tokens: 4 },
	{ prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: "invalid" },
	{ prompt_tokens: -1, completion_tokens: 4 },
])("malformed advisor usage %j leaves its decision intact with unknown accounting", async (usage) => {
	const f = await fixture();
	f.setJev(noul(0.5));
	f.setAdvisor({ ...advice(), usage });
	const result = await f.run(),
		saved = receipt(result.evidenceDirectory!);
	expect(result.kind).toBe("proposed");
	expect(saved.outcome).toBe("adopt_dirty");
	expect(saved.decision.decided_by).toBe("advisor");
	expect(saved.decision.probability_or_confidence).toBe(0.9);
	expect(saved.decision.reason).toBe("Retained revision and authority are bound");
	expect(saved.advisor).toMatchObject({ decision: "adopt_dirty", confidence: 0.9, usage: null, cost_usd: null });
	expect(saved.accounting).toMatchObject({ calls: 2, usage: null, cost_usd: null, priced: false });
	expect(f.requests).toHaveLength(2);
});

test.each(["", "/v1", "/v1/"])("advisor URL trims whitespace and normalizes suffix %j", async (suffix) => {
	const f = await fixture();
	f.setJev(noul(0.5));
	vi.stubEnv("FACTORY_ADVISOR_BASE_URL", ` \t${f.base}${suffix} \n`);
	const result = await f.run();
	expect(result.kind).toBe("proposed");
	expect(result.typedDecision?.decision.decided_by).toBe("advisor");
	expect(f.requests.map((r) => r.path)).toEqual(["/v1/systemone", "/v1/chat/completions"]);
});

test.each([undefined, "", " \t "])("advisor URL %j is unconfigured without an advisor request", async (base) => {
	const f = await fixture();
	f.setJev(noul(0.5));
	vi.stubEnv("FACTORY_ADVISOR_BASE_URL", base);
	const result = await f.run();
	expect(result.kind).toBe("deferred");
	expect(result.typedDecision?.decision.reason).toContain("Advisor unconfigured");
	expect(result.typedDecision?.accounting.calls).toBe(1);
	expect(f.requests.map((r) => r.path)).toEqual(["/v1/systemone"]);
});

test("advisor timeout defers durably and opens a dispatcher wake", async () => {
	const f = await fixture();
	f.setJev(noul(0.5));
	f.during((req) => req.url === "/v1/chat/completions");
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms === 60_000 ? 20 : ms));
	const result = await f.run(),
		saved = receipt(result.evidenceDirectory!);
	expect(spy).toHaveBeenCalledWith(10_000);
	expect(spy).toHaveBeenCalledWith(60_000);
	expect(result.kind).toBe("deferred");
	expect(saved.outcome).toBe("DEFERRED");
	expect(saved.advisor).toMatchObject({ decision: "DEFERRED", confidence: null, usage: null, cost_usd: null });
	expect(saved.accounting).toMatchObject({ calls: 2, usage: null, cost_usd: null });
	expect(saved.decision.reason).toContain("Advisor Request failed or timed out");
	expect(saved.applied).toBe(false);
	expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
	expect(f.store.managementRequests()[0].state).toBe("DEFERRED");
	expect(f.store.wakes().some((w) => w.reason.includes("typed_decision_deferred:") && w.resolvedAt === null)).toBe(
		true,
	);
	const reopened = new FactoryStore(join(f.directory, "factory.db"));
	stores.push(reopened);
	expect(reopened.managementRequests()[0].result).toEqual(saved);
});

test("unconfigured key is read once and every call defers without HTTP", async () => {
	const f = await fixture();
	vi.stubEnv("TYPESAFE_JEV_API_KEY", "");
	const caller = f.create(() => {});
	expect(caller.status).toBe("unconfigured");
	vi.stubEnv("TYPESAFE_JEV_API_KEY", "fixture-later");
	for (let i = 0; i < 2; i++) expect((await caller.call(f.state)).inference.outcome).toBe("DEFERRED");
	vi.stubEnv("TYPESAFE_JEV_API_KEY", "");
	const result = await f.run();
	expect(result.kind).toBe("deferred");
	expect(result.typedDecision?.decision.reason).toContain("unconfigured");
	expect(f.requests).toHaveLength(0);
	expect(f.store.wakes()).toHaveLength(2);
});

test.each(["once", "always", "400", "401", "429", "500"])("bounded network retry: %s", async (mode) => {
	const f = await fixture();
	f.during((req, res) => {
		if (mode === "once" && f.requests.length > 1) return false;
		if (mode === "once" || mode === "always") req.socket.destroy();
		else {
			res.writeHead(Number(mode));
			res.end("Never retain untrusted error body");
		}
		return true;
	});
	const result = await f.run();
	expect(f.requests).toHaveLength(mode === "once" || mode === "always" ? 2 : 1);
	expect(result.kind).toBe(mode === "once" ? "proposed" : "deferred");
	expect(result.typedDecision?.decision.reason).not.toContain("untrusted error body");
});

test.each(["jev", "advisor"])("journal movement during %s refuses recording", async (stage) => {
	const f = await fixture();
	f.setJev(noul(stage === "advisor" ? 0.5 : 0.9));
	f.during((req) => {
		if (req.url === (stage === "jev" ? "/v1/systemone" : "/v1/chat/completions")) {
			f.store.pause("concurrent event");
			f.store.resume();
		}
		return false;
	});
	const before = f.store.typedDecisions().length,
		result = await f.run();
	expect(result.kind).toBe("error");
	expect(result.error).toContain("journal moved");
	expect(f.store.typedDecisions()).toHaveLength(before);
	expect(f.store.managementRequests()[0].state).toBe("ERROR");
	expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
});

test("invalid or stale objects never reach HTTP", async () => {
	const f = await fixture();
	await expect(f.run({ ...f.state, extra: true } as FactoryDecision)).rejects.toThrow("Invalid factory decision");
	await expect(f.run({ ...f.state, ledger_sequence: 0 })).rejects.toThrow("ledger_sequence changed");
	expect(f.requests).toHaveLength(0);
	expect(f.store.managementRequests()).toHaveLength(0);
});

test("missing calibration is deferred rather than inventing a question", async () => {
	const f = await fixture();
	const state: FactoryDecision = {
		...codeDecisionBase(f.store.ledgerSequence(), "Review facts"),
		type: "review_tier",
		changed_files: 1,
		changed_lines: 2,
		hunks: 1,
		seams_touched: [],
		blueprint_risk_tag: null,
		prior_bot_findings: 0,
		test_delta: { added: 1, removed: 0 },
		docs_only: false,
		choice: "bots_only",
	};
	const result = await f.run(state);
	expect(result.kind).toBe("deferred");
	expect(f.requests).toHaveLength(0);
	expect(result.typedDecision?.decision.reason).toContain("No calibrated v8 question for review_tier");
});

test("advisor model drift is recorded without applying", async () => {
	const f = await fixture();
	f.setJev(noul(0.5));
	f.setAdvisor(advice("adopt_dirty", "Retained bytes", "different-model"));
	const result = await f.run();
	expect(result.kind).toBe("drift");
	expect(f.store.managementRequests()[0].state).toBe("DRIFT");
	expect(result.typedDecision?.applied).toBe(false);
	expect(f.store.wakes().some((w) => w.reason === `profile_drift: ${result.requestId}`)).toBe(true);
});

test("Jev model drift retains probability and deciding fields without applying", async () => {
	const f = await fixture();
	f.setJev({ ...noul(0.9), model: "different-model" });
	const lookup = vi.spyOn(f.store, "openWakeIdForReason");
	const result = await f.run(),
		saved = receipt(result.evidenceDirectory!);
	expect(result.kind).toBe("drift");
	expect(saved.outcome).toBe("DRIFT");
	expect(saved.decision).toMatchObject({
		decided_by: "jev",
		probability_or_confidence: 0.9,
		requested_profile: "jev-latest",
		served_profile: "different-model",
	});
	expect(saved.decision.reason).toContain("p=0.9; Jev response model drift; fields=");
	expect(saved.decision.reason).toContain('"retained_revision":"revision"');
	expect(saved.jev).toMatchObject({ model: "different-model", probability: 0.9 });
	expect(saved.advisor).toBeUndefined();
	expect(saved.applied).toBe(false);
	expect(f.store.managementRequests()[0].state).toBe("DRIFT");
	expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
	expect(lookup).toHaveBeenCalledWith(`profile_drift: ${result.requestId}`);
	expect(result.kind === "drift" && result.wakeId).toBe(
		f.store.openWakeIdForReason(`profile_drift: ${result.requestId}`),
	);
	expect(f.store.openWakeIdForReason("profile_drift: missing")).toBeUndefined();
	expect(f.requests).toHaveLength(1);
});

test("invalid probabilities and advisor decisions fail closed", async () => {
	const f = await fixture();
	f.setJev(noul(2));
	expect((await f.create(() => {}).call(f.state)).inference.outcome).toBe("DEFERRED");
	f.setJev(noul(0.5));
	f.setAdvisor(advice("unlisted-option"));
	expect((await f.create(() => {}).call(f.state)).inference.outcome).toBe("DEFERRED");
});

test("deferred receipt accounting can be recorded through the shared writer", async () => {
	const f = await fixture();
	vi.stubEnv("TYPESAFE_JEV_API_KEY", "");
	const result = await f.create(() => {}).call(f.state);
	const saved = recordDecision(f.store, "a", result.decision, {
		inference: result.inference,
		accounting: result.accounting,
	});
	expect(saved.outcome).toBe("DEFERRED");
	expect(saved.decision.decided_by).toBe("none");
	expect(f.store.typedDecisions().at(-1)).toEqual(saved);
});

test("journal movement immediately before the receipt transaction refuses commit", async () => {
	const f = await fixture();
	const commit = f.store.commitTypedDecision.bind(f.store);
	vi.spyOn(f.store, "commitTypedDecision").mockImplementation((...args) => {
		f.store.pause("between HTTP and transaction");
		f.store.resume();
		return commit(...args);
	});
	const result = await f.run();
	expect(result.kind).toBe("error");
	expect(result.error).toContain("journal moved");
	expect(f.store.managementRequests()[0].result).toBeNull();
});

test("manage --typed-object reaches the unconfigured deferred path without an SDK call", async () => {
	const f = await fixture();
	writeFileSync(join(f.directory, "config.json"), JSON.stringify({ version: 1, hosts: {} }));
	const path = join(f.directory, "typed.json");
	writeFileSync(path, JSON.stringify(f.state));
	const entry = fileURLToPath(new URL("../src/factory/manage-entry.ts", import.meta.url));
	const child = spawn(process.execPath, ["--import", "tsx", entry, f.directory, "a", "--typed-object", path], {
		env: { ...process.env, TYPESAFE_JEV_API_KEY: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "",
		error = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (text: string) => {
		output += text;
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (text: string) => {
		error += text;
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	expect(code, error).toBe(0);
	expect(JSON.parse(output)).toMatchObject({ kind: "deferred", typedDecision: { outcome: "DEFERRED" } });
	expect(f.requests).toHaveLength(0);
	expect(f.store.managementRequests()[0].state).toBe("DEFERRED");
});
