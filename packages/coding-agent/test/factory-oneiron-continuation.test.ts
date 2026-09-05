import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyOwnedSessionWorkerInvocation, createOwnedWorkerLaunchSpec } from "../src/cli/owned-session-worker.js";
import { createAllToolDefinitions } from "../src/core/tools/index.js";
import { CommandAdapter } from "../src/factory/adapters/command.js";
import {
	executeOneiron,
	type OneironManifest,
	type OneironReceipt,
	type OneironSource,
	type OneironStage,
	prepareOneiron,
} from "../src/factory/adapters/oneiron.js";
import {
	OneironContinuation,
	type OneironContinuationConfig,
	type OneironCoordinatorEffortOverride,
	type OneironSuccessor,
	type OneironSuccessorPacket,
	oneironContinuationUnit,
	readOneironContinuationStatus,
	selectOneironCoordinatorDecision,
} from "../src/factory/adapters/oneiron-continuation.js";
import { type OneironFinding, type OneironPin, oneironSha } from "../src/factory/adapters/oneiron-review.js";
import { defaultOneironWriterProfile } from "../src/factory/adapters/oneiron-writer.js";
import { FactoryEngine } from "../src/factory/engine.js";
import type { ManagementPacket, ManagementReconciliation } from "../src/factory/management.js";
import type { ManagementCallerFactory } from "../src/factory/management-dispatch.js";
import { hashFactoryRuntimeFile } from "../src/factory/runtime.js";
import { FactoryStore } from "../src/factory/store.js";
import type { AttemptContext, FactoryAdapter, Inspection } from "../src/factory/types.js";

// Publication/network is mocked. Real Oneiron stages, binder, manager, engine and SQLite journal run below.
vi.mock("../src/factory/adapters/oneiron-publication.js", () => ({
	publishOneiron: vi.fn(async () => ({ requiresCurrentHeadReview: true, fixturePublication: true })),
}));
const roots: string[] = [];
const closers: Array<() => void> = [];
function pin(directory: string, name: string, value: unknown): OneironPin {
	const path = join(directory, name);
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
	return { path, sha256: oneironSha(readFileSync(path)) };
}
function rawPin(path: string, text: string): OneironPin {
	writeFileSync(path, text);
	return { path, sha256: oneironSha(text) };
}
function parse<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}
function modelEvent(model = "gpt-6-astra", responseModel = model, provider = "cpa-r"): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			provider,
			model,
			responseModel,
			responseModelSource: "provider-response",
			responseId: "transport-response-1",
			stopReason: "stop",
		},
	});
}
async function fixture(nativeCoordinator = false, initialEffort?: Omit<OneironCoordinatorEffortOverride, "actionId">) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "oneiron-continuation-")));
	roots.push(directory);
	const workspace = join(directory, "product");
	const factoryDirectory = join(directory, "factory");
	const controllerWorkspace = join(directory, "coordinator");
	const bundle = join(directory, "bundle");
	for (const path of [workspace, factoryDirectory, controllerWorkspace, bundle]) mkdirSync(path);
	writeFileSync(join(workspace, "source.txt"), "original source\n");
	const node = nativeCoordinator
		? { path: process.execPath, sha256: hashFactoryRuntimeFile(process.execPath) }
		: rawPin(join(bundle, "node-fixture"), "fake Node for mocked runtime only");
	const cli = rawPin(
		join(bundle, "cli.js"),
		nativeCoordinator
			? `const fs = require("node:fs");
if (process.env.PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND !== "1" || process.env.PRIME_AGENT_INTERNAL_OWNED_WORKER === "1") throw new Error("Fixture refuses missing/incorrect owned frontend routing env");
const packet = JSON.parse(process.argv.at(-1).split("\\nPacket: ").at(-1));
fs.appendFileSync(${JSON.stringify(join(directory, "native-launches.log"))}, packet.requestId + "\\n");
setTimeout(() => {
 const next = JSON.parse(fs.readFileSync(${JSON.stringify(join(directory, "native-next.json"))}, "utf8"));
 fs.writeFileSync(packet.responsePath, JSON.stringify({version:1,requestId:packet.requestId,planRevision:packet.planRevision,reason:"Real runner fake CLI fixture response, no paid inference or live publication.",evidence:[packet.authorization],next}));
 console.log(${JSON.stringify(modelEvent())});
}, 250);`
			: "// fake native coordinator CLI, replaced by adapter seam",
	);
	const adapter = rawPin(join(directory, "adapter.js"), "// fixture prepared adapter pin");
	const continuationEntry = rawPin(join(directory, "continuation-entry.js"), "// fixture continuation entry pin");
	const runtime = pin(directory, "runtime.json", {
		version: 1,
		cliArgv: [node.path, cli.path],
		files: [node, cli, adapter, continuationEntry],
		capabilities: ["provider-response-model-v1"],
	});
	const authorization = pin(directory, "authorization.json", {
		fixtureOnly: true,
		ownerAuthorized: "bounded signed commit/rebind and bot request; no product authorship/merge/close",
	});
	const instructions = pin(directory, "helpers.json", {
		fixtureOnly: true,
		commitHelper: "fixture signed commit",
		reviewHelper: "fixture exact-head bot request",
		closureActor: "fixture-coordinator",
	});
	const config: OneironContinuationConfig = {
		version: 1,
		id: "fixture",
		ticketId: "FIXTURE-1",
		initialActionId: "pending",
		factoryDirectory,
		ownerPauseFile: join(directory, "OWNER-PAUSE"),
		coordinator: {
			actor: "fixture-coordinator",
			runtime,
			workspace: controllerWorkspace,
			host: "controller",
			runnerRoot: join(directory, "runners"),
			authorization,
			instructions,
			timeoutMs: 30000,
		},
		adapterArgv: [node.path, adapter.path],
		adapterPins: [adapter],
		supervisor: {
			actor: "systemd:oneiron-fixture.service",
			unit: "oneiron-fixture.service",
			argv: [node.path, join(directory, "continuation-entry.js")],
			configPath: join(directory, "continuation.json"),
		},
	};
	let source: OneironSource = {
		workspace,
		head: "a".repeat(40),
		tree: "b".repeat(40),
		branch: "fixture-feature",
		remoteUrl: "https://example.invalid/fixture.git",
		fingerprint: `git:${"a".repeat(64)}`,
	};
	const originalSource = { ...source };
	const newSource = { ...source, head: "c".repeat(40), tree: "d".repeat(40), fingerprint: `git:${"c".repeat(64)}` };
	const expiresAt = new Date(Date.now() + 3600000).toISOString();
	const release = pin(directory, "release.json", { fixtureOnly: true, released: true });
	let count = 0;
	const manifests: OneironManifest[] = [];
	const receipts: OneironPin[] = [];
	function corpus(candidate: OneironSource) {
		const body =
			"Fixture exact-head independent review completed. Preserve the material finding until repaired on the current candidate.";
		return {
			schema: "oneiron.wave6.github-bot-corpus.v1",
			repo: "fixture/repo",
			github_mutation: false,
			pins: { 1: candidate.head },
			prs: [
				{
					number: 1,
					head_sha: candidate.head,
					base_ref: "main",
					raw: { review_comments: [] },
					items: ["qodo-code-review[bot]", "chatgpt-codex-connector[bot]"].map((login, index) => ({
						key: `review:${index}`,
						id: index,
						author: { login },
						body,
						body_sha256: oneironSha(body),
						sources: ["review"],
						state: "COMMENTED",
						commit_id: candidate.head,
					})),
				},
			],
		};
	}
	const repair = pin(directory, "repair-proof.json", {
		fixtureOnly: true,
		head: newSource.head,
		repaired: "material finding current-candidate evidence",
	});
	const prior = pin(directory, "prior.json", []);
	const initialCorpus = pin(directory, "initial-corpus.json", corpus(source));
	function make(stage: OneironStage, candidate = source) {
		const index = count++;
		const custody = pin(directory, `custody-${index}.json`, {
			version: 1,
			state: "transferred",
			ticketId: config.ticketId,
			owner: config.coordinator.actor,
			sourceFingerprint: candidate.fingerprint,
			expiresAt,
			priorOwners: [{ id: "old-fixture", release }],
			activeOwners: [config.coordinator.actor],
			liveProcesses: [],
			duplicateAuthorityDisabled: true,
			sharedGitClear: true,
		});
		const manifest: OneironManifest = {
			version: 1,
			ticketId: config.ticketId,
			owner: config.coordinator.actor,
			source: { ...candidate },
			factoryDirectory,
			factoryRuntime: runtime,
			ownerPauseFile: config.ownerPauseFile,
			custody,
			outputDirectory: join(directory, `stage-${index}`),
			stage,
		};
		const manifestPin = pin(directory, `manifest-${index}.json`, manifest);
		const permit = pin(directory, `permit-${index}.json`, {
			version: 1,
			permission: "execute",
			manifestSha256: manifestPin.sha256,
			ticketId: config.ticketId,
			stage: stage.kind,
			sourceFingerprint: candidate.fingerprint,
			custodySha256: custody.sha256,
			owner: config.coordinator.actor,
			ownerAuthorization: authorization,
			expiresAt,
		});
		manifests.push(manifest);
		return { kind: "stage" as const, manifest: manifestPin, permit, host: "controller", slotId: "slot1" };
	}
	const initial = make({
		kind: "triage",
		repo: "fixture/repo",
		pr: 1,
		base: "main",
		corpus: initialCorpus,
		priorFindings: prior,
		evidence: [repair],
	});
	const initialManifest = manifests[0];
	const first = prepareOneiron(initialManifest, {
		manifestPath: initial.manifest.path,
		permitPath: initial.permit.path,
		adapterArgv: config.adapterArgv,
		host: "controller",
		slotId: "slot1",
	}).action!;
	config.initialActionId = first.id;
	if (initialEffort) config.coordinator.effortOverrides = [{ actionId: first.id, ...initialEffort }];
	pin(directory, "continuation.json", config);
	const store = new FactoryStore(join(factoryDirectory, "factory.db"));
	let storeClosed = false;
	closers.push(() => {
		if (!storeClosed) store.close();
	});
	const stageCalls: string[] = [];
	const stageAdapter: FactoryAdapter = {
		async launch(context) {
			const args = context.action.command.argv;
			const manifest = parse<OneironManifest>(args.at(-4)!);
			source = { ...manifest.source };
			stageCalls.push(manifest.stage.kind);
			const result = await executeOneiron(
				args.at(-4)!,
				args.at(-3)!,
				true,
				{
					now: Date.now,
					status: async () => ({ ...engine.status(), ownerPaused: false }),
					source: async () => ({ ...source }),
					call: async (_system, packet, profile) => {
						expect(profile).toEqual({ provider: "cpa-r", model: "gpt-6-astra", effort: "low" });
						const input = JSON.parse(packet) as {
							candidateCommit: string;
							sourceFingerprint: string;
							corpusSha256: string;
							items: Array<{ id: string; bodySha256: string }>;
							prior: OneironFinding[];
							evidence: Array<{ ref: string }>;
						};
						const changed = input.candidateCommit === newSource.head;
						return {
							model: "gpt-6-astra",
							responseModel: "gpt-6-astra",
							responseModelSource: "provider-response",
							responseId: "triage-fixture-response",
							text: JSON.stringify({
								version: 1,
								candidateCommit: input.candidateCommit,
								sourceFingerprint: input.sourceFingerprint,
								corpusSha256: input.corpusSha256,
								findings: input.items.map((item) => ({
									id: item.id,
									bodySha256: item.bodySha256,
									classification: "material",
									disposition: changed ? "fixed" : "open",
									reason:
										"Fixture preserves material obligations and resolves only against the repaired current candidate.",
									evidenceRefs: [input.evidence[changed ? 1 : 0].ref],
									...(changed ? { resolvedAtCommit: input.candidateCommit } : {}),
								})),
							}),
						};
					},
					run: async (argv) => {
						if (argv.includes("--print")) {
							writeFileSync(join(workspace, "source.txt"), "repaired fixture source\n");
							source = { ...source, fingerprint: `git:${"e".repeat(64)}` };
							const profile =
								manifest.stage.kind === "writer"
									? parse<{ requested: { model: string; provider: string } }>(
											manifest.stage.writerProfile.path,
										)
									: null;
							expect(argv[argv.indexOf("--thinking") + 1]).toBe("xhigh");
							expect(profile!.requested.provider).toBe("cpa-r");
							expect(profile!.requested.model).toBe("gpt-6-astra");
							return modelEvent(profile!.requested.model, "gpt-6-astra", profile!.requested.provider);
						}
						if (argv.includes("--receipt")) {
							const receiptPath = argv[argv.indexOf("--receipt") + 1];
							writeFileSync(
								receiptPath,
								JSON.stringify({
									status: "COMPLETED",
									command_rc: 0,
									workspace_root: workspace,
									command: ["cargo", "test", "fixture"],
									provenance: { pass: true },
									source_unchanged: true,
								}),
							);
							return "";
						}
						if (argv.includes("--output-dir")) {
							const output = argv[argv.indexOf("--output-dir") + 1];
							mkdirSync(output);
							pin(output, "corpus.json", corpus(source));
							return "";
						}
						throw new Error(`Unexpected live effect ${argv}`);
					},
				},
				args.at(-2),
			);
			expect("reused" in result).toBe(false);
			const receiptPath = join(manifest.outputDirectory, "receipt.json");
			receipts.push({ path: receiptPath, sha256: oneironSha(readFileSync(receiptPath)) });
			return {
				kind: "terminal",
				receipt: {
					attemptId: context.attempt.id,
					sourceFingerprint: context.action.sourceFingerprint,
					finishedAt: new Date().toISOString(),
					exitCode: 0,
					artifact: { ref: workspace, sourceFingerprint: source.fingerprint },
				},
			};
		},
		async inspect() {
			throw new Error("Fixture stages terminate inline");
		},
	};
	const engine = new FactoryEngine(store, stageAdapter, { enabled: true, pauseFile: config.ownerPauseFile });
	engine.applyPlan({
		version: 1,
		tickets: [{ id: config.ticketId, owner: config.coordinator.actor }],
		slots: [{ id: "slot1", host: "controller" }],
		actions: [first],
		roles: {
			ticketOwner: { provider: "fixture", model: "mock-manager", effort: "low" },
			coordinator: { provider: "cpa-r", model: "gpt-6-astra", effort: "medium" },
		},
	});
	let decision: "accept" | "defer" = "accept";
	const managementCalls = vi.fn();
	const management: ManagementCallerFactory = (before) => async (_system, text) => {
		before();
		managementCalls();
		const packet = JSON.parse(text) as ManagementPacket;
		return {
			model: "mock-manager",
			responseModel: "mock-manager",
			responseModelSource: "provider-response",
			responseId: "management-fixture-response",
			text: JSON.stringify({
				version: 1,
				actionId: packet.action.id,
				attemptId: packet.attempt?.id,
				planRevision: packet.planRevision,
				decision,
				reason: "Fixture verifies bounded stage evidence only, never product closure.",
				evidenceRefs: [packet.evidence[0].ref],
			}),
		};
	};
	let next: (packet: OneironSuccessorPacket) => OneironSuccessor["next"] = () => {
		throw new Error("No fixture successor configured");
	};
	let futureDecision: OneironCoordinatorEffortOverride | undefined;
	const coordinatorLaunches = vi.fn();
	let pendingContext: AttemptContext | undefined;
	let inspection: Inspection | undefined;
	const fakeCoordinator: FactoryAdapter = {
		async launch(context) {
			coordinatorLaunches(context);
			pendingContext = context;
			return { kind: "running", processIdentity: "fixture-coordinator-process" };
		},
		async inspect(context) {
			if (inspection) return inspection;
			const output = join(factoryDirectory, "continuation", config.id, context.attempt.id);
			const packet = parse<OneironSuccessorPacket>(join(output, "packet.json"));
			const response: OneironSuccessor = {
				version: 1,
				requestId: packet.requestId,
				planRevision: packet.planRevision,
				reason: "Fixture coordinator pins one exact next stage and retains every review obligation.",
				evidence: [repair],
				coordinatorDecision: futureDecision,
				next: next(packet),
			};
			writeFileSync(packet.responsePath, JSON.stringify(response));
			const runner = join(config.coordinator.runnerRoot, context.attempt.id);
			mkdirSync(runner, { recursive: true });
			writeFileSync(join(runner, "stdout.log"), modelEvent());
			return {
				kind: "terminal",
				receipt: {
					attemptId: context.attempt.id,
					sourceFingerprint: context.action.sourceFingerprint,
					exitCode: 0,
					finishedAt: "2026-09-05T00:00:00.000Z",
				},
			};
		},
	};
	const coordinator: FactoryAdapter = nativeCoordinator
		? new CommandAdapter(
				{ controller: { type: "local", runnerRoot: config.coordinator.runnerRoot } },
				{ pauseFile: config.ownerPauseFile },
			)
		: fakeCoordinator;
	const verifyRebind = vi.fn(async (manifest: OneironManifest) => {
		expect(manifest.source).toEqual(newSource);
		source = { ...newSource };
	});
	let continuation = new OneironContinuation(engine, config, coordinator, management, verifyRebind);
	closers.push(() => continuation.close());
	return {
		directory,
		workspace,
		factoryDirectory,
		config,
		runtime,
		node,
		cli,
		source: originalSource,
		newSource,
		engine,
		store,
		stageAdapter,
		stageCalls,
		manifests,
		receipts,
		make,
		first,
		repair,
		prior,
		initialCorpus,
		management,
		managementCalls,
		coordinator,
		coordinatorLaunches,
		verifyRebind,
		get continuation() {
			return continuation;
		},
		setNext(value: typeof next) {
			next = value;
		},
		setFutureDecision(value: OneironCoordinatorEffortOverride | undefined) {
			futureDecision = value;
		},
		setDecision(value: typeof decision) {
			decision = value;
		},
		setInspection(value: Inspection | undefined) {
			inspection = value;
		},
		getContext() {
			return pendingContext!;
		},
		restart() {
			continuation.close();
			continuation = new OneironContinuation(engine, config, coordinator, management, verifyRebind);
		},
		closeStore() {
			store.close();
			storeClosed = true;
		},
	};
}
afterEach(() => {
	for (const close of closers.splice(0).reverse()) close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function accepted(f: Awaited<ReturnType<typeof fixture>>) {
	expect((await f.engine.tick()).launched).toHaveLength(1);
	const result = await f.continuation.step();
	expect(
		result.kind,
		JSON.stringify({
			result,
			status: f.store.status(),
			packet: result.requestId ? parse(join(result.output, "packet.json")) : null,
		}),
	).toBe("managed");
}
async function successor(f: Awaited<ReturnType<typeof fixture>>) {
	expect((await f.continuation.step()).kind).toBe("coordinator");
	f.restart();
	return f.continuation.step();
}
function gate(f: Awaited<ReturnType<typeof fixture>>, source = f.source) {
	const wrapper = pin(f.directory, `wrapper-${f.manifests.length}.json`, { fixtureOnly: true });
	const capacity = pin(f.directory, `capacity-${f.manifests.length}.json`, {
		status: "PASS",
		sourceFingerprint: source.fingerprint,
		host: "arch",
		slot: 1,
		argv: ["cargo", "test", "fixture"],
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
		duplicateFree: true,
		resourcesPassed: true,
	});
	return f.make(
		{ kind: "gate", wrapper, capacity, host: "arch", slot: 1, argv: ["cargo", "test", "fixture"] },
		source,
	);
}
describe("durable Oneiron continuation", () => {
	test("real journal and stages advance repaired candidate through binding/apply/rebind/gates/publication/changed-head review, once across restart", async () => {
		const f = await fixture();
		let triage: OneironPin;
		let gateReceipt: OneironPin;
		let changedCorpus: OneironPin;
		let reviewPrior = f.prior;
		f.setNext((packet) => {
			const receipt = parse<OneironReceipt>(packet.receipt!.path);
			switch (receipt.stage) {
				case "triage":
					triage = packet.receipt!;
					if (receipt.input.head === f.source.head) {
						reviewPrior = pin(
							f.directory,
							"carried-findings.json",
							(receipt.result.triage as { findings: OneironFinding[] }).findings,
						);
						return f.make({
							kind: "writer",
							triage,
							prompt: f.repair,
							writerProfile: pin(f.directory, "writer-profile.json", defaultOneironWriterProfile(f.runtime)),
						});
					}
					return f.make(
						{
							kind: "review-acceptance",
							repo: "fixture/repo",
							pr: 1,
							base: "main",
							corpus: changedCorpus,
							priorFindings: reviewPrior,
							evidence: [f.repair],
							triage,
							gates: [gateReceipt],
						},
						f.newSource,
					);
				case "writer": {
					const next = gate(f, f.newSource);
					return {
						...next,
						rebind: pin(f.directory, "signed-rebind.json", {
							version: 1,
							writerReceipt: packet.receipt,
							outputFingerprint: receipt.output.fingerprint,
							sourceFingerprint: f.newSource.fingerprint,
							signedCommitVerified: true,
							clean: true,
							processReconciled: true,
							retainedEvidence: [packet.receipt, f.repair],
							authorization: f.config.coordinator.authorization,
						}),
					};
				}
				case "gate":
					gateReceipt = packet.receipt!;
					return f.make(
						{
							kind: "publish-update",
							repo: "fixture/repo",
							pr: 1,
							base: "main",
							expectedRemoteHead: f.source.head,
							gates: [gateReceipt],
							editorial: f.repair,
							pushGuard: f.repair,
							nativeTool: f.repair,
							dependencyAudit: f.repair,
						},
						f.newSource,
					);
				case "publish-update":
					return {
						...f.make(
							{
								kind: "collect",
								repo: "fixture/repo",
								pr: 1,
								base: "main",
								helper: f.repair,
								foregroundShim: f.repair,
							},
							f.newSource,
						),
						reviewRequest: pin(f.directory, "review-request.json", {
							version: 1,
							head: f.newSource.head,
							repo: "fixture/repo",
							pr: 1,
							reviewers: ["qodo", "codex"],
							refs: ["fixture-only exact-head request"],
						}),
					};
				case "collect":
					changedCorpus = receipt.result.corpus as OneironPin;
					return f.make(
						{
							kind: "triage",
							repo: "fixture/repo",
							pr: 1,
							base: "main",
							corpus: changedCorpus,
							priorFindings: reviewPrior,
							evidence: [f.repair],
						},
						f.newSource,
					);
				case "review-acceptance":
					return {
						kind: "closure-handoff",
						actor: f.config.coordinator.actor,
						acceptance: packet.receipt!,
						instructions: f.config.coordinator.instructions,
					};
				default:
					throw new Error("Unexpected stage");
			}
		});
		for (let stage = 0; stage < 7; stage++) {
			await accepted(f);
			const result = await successor(f);
			expect(result.kind).toBe(stage === 6 ? "closure-handoff" : "imported");
		}
		expect(f.stageCalls).toEqual([
			"triage",
			"writer",
			"gate",
			"publish-update",
			"collect",
			"triage",
			"review-acceptance",
		]);
		expect(f.managementCalls).toHaveBeenCalledTimes(7);
		expect(f.coordinatorLaunches).toHaveBeenCalledTimes(7);
		expect(f.verifyRebind).toHaveBeenCalledTimes(1);
		expect(readFileSync(join(f.workspace, "source.txt"), "utf8")).toContain("repaired");
		expect(f.store.attempts()).toHaveLength(7);
		expect(f.store.events().filter((event) => event.kind === "action_decided")).toHaveLength(7);
		expect(f.store.status().planRevision).toBe(7);
		const db = new DatabaseSync(join(f.factoryDirectory, "factory.db"), { readOnly: true });
		expect(db.prepare("SELECT COUNT(*) AS n FROM oneiron_continuation_bindings").get()?.n).toBe(7);
		db.close();
		f.restart();
		const terminal = await f.continuation.step();
		expect(terminal.kind).toBe("closure-handoff");
		expect(f.continuation.supervise(terminal, 1)).toMatchObject({
			exitCode: 0,
			nextActor: "fixture-coordinator",
			nextCommand: [],
		});
		expect((await f.engine.tick()).launched).toEqual([]);
		expect(f.coordinatorLaunches).toHaveBeenCalledTimes(7);
	});

	test("triage cannot claim product closure or skip to publication", async () => {
		const f = await fixture();
		await accepted(f);
		f.setNext((packet) => ({
			kind: "closure-handoff",
			actor: f.config.coordinator.actor,
			acceptance: packet.receipt!,
			instructions: f.repair,
		}));
		await expect(successor(f)).rejects.toThrow(/Only accepted review-acceptance/);
		expect(f.store.status().planRevision).toBe(1);
	});

	test("finite session rearm is pinned and deliberate; unchanged waits launch no model", async () => {
		const f = await fixture();
		await accepted(f);
		const waitPath = join(f.directory, "external-evidence.json");
		f.setNext(() => ({
			kind: "wait",
			actor: "fixture-exact-head-collector",
			path: waitPath,
			observedSha256: null,
			instructions: f.repair,
		}));
		expect((await successor(f)).kind).toBe("waiting");
		const pending = await f.continuation.step();
		const handoff = f.continuation.supervise(pending, 60);
		expect(handoff.exitCode).toBe(75);
		expect(handoff.nextCommand).toContain("watch");
		expect(oneironContinuationUnit(f.config)).toContain("Restart=on-failure");
		expect(oneironContinuationUnit(f.config)).toContain("RestartPreventExitStatus=78");
		f.restart();
		for (let index = 0; index < 3; index++) expect((await f.continuation.step()).kind).toBe("waiting");
		expect(f.coordinatorLaunches).toHaveBeenCalledTimes(1);
		pin(f.directory, "external-evidence.json", { completed: true, exactHead: f.source.head });
		f.setNext(() => gate(f));
		expect((await f.continuation.step()).kind).toBe("coordinator");
		expect(f.coordinatorLaunches).toHaveBeenCalledTimes(2);
		const packet = parse<OneironSuccessorPacket>(
			join(f.factoryDirectory, "continuation", f.config.id, f.getContext().attempt.id, "packet.json"),
		);
		expect(packet.triggerEvidence?.path).toBe(waitPath);
		expect(packet.refreshOnly).toBe(false);
	});

	test("global revision CAS uses refresh-only response; committed import survives lost cursor ack", async () => {
		const f = await fixture();
		await accepted(f);
		f.setNext(() =>
			f.make({
				kind: "collect",
				repo: "fixture/repo",
				pr: 1,
				base: "main",
				helper: f.repair,
				foregroundShim: f.repair,
			}),
		);
		await f.continuation.step();
		f.engine.applyPlan({ version: 1, tickets: [{ id: "OTHER", owner: "other" }], slots: [], actions: [] }, 1);
		expect((await f.continuation.step()).reason).toContain("refresh-only");
		await f.continuation.step();
		const current = f.getContext();
		const packet = parse<OneironSuccessorPacket>(
			join(f.factoryDirectory, "continuation", f.config.id, current.attempt.id, "packet.json"),
		);
		expect(packet.refreshOnly).toBe(true);
		f.setNext(() => packet.previousResponse!.next);
		const spy = vi.spyOn(f.engine, "applyPlan").mockImplementationOnce((plan, revision, id) => {
			f.store.applyPlan(plan, revision, id);
			throw new Error("fixture crash after atomic import");
		});
		await expect(f.continuation.step()).rejects.toThrow(/crash after atomic import/);
		spy.mockRestore();
		const revision = f.store.status().planRevision;
		f.restart();
		expect((await f.continuation.step()).kind).toBe("imported");
		expect(f.store.status().planRevision).toBe(revision);
		expect(f.coordinatorLaunches).toHaveBeenCalledTimes(2);
	});

	test("missing binding and deferred judgment gain one durable diagnostic coordinator, not owner idle", async () => {
		const f = await fixture();
		await f.engine.tick();
		f.setDecision("defer");
		f.setNext(() => ({
			kind: "wait",
			actor: "fixture-evidence-producer",
			path: join(f.directory, "new-evidence.json"),
			observedSha256: null,
			instructions: f.repair,
		}));
		expect((await f.continuation.step()).kind).toBe("coordinator");
		expect(f.managementCalls).toHaveBeenCalledTimes(1);
		const packet = parse<OneironSuccessorPacket>(
			join(f.factoryDirectory, "continuation", f.config.id, f.getContext().attempt.id, "packet.json"),
		);
		expect(packet.outcome).toBe("AWAITING_DECISION");
		expect(packet.allowedNextStages).toEqual([]);
		expect(packet.requiredWork).toContain("Judgment deferred");
		expect((await f.continuation.step()).kind).toBe("waiting");
		f.engine.applyPlan({ version: 1, tickets: [{ id: "OTHER", owner: "other" }], actions: [], slots: [] }, 1);
		f.restart();
		await f.continuation.step();
		expect(f.managementCalls).toHaveBeenCalledTimes(1);
		expect(f.coordinatorLaunches).toHaveBeenCalledTimes(1);
	});

	test("hardcrashed management claim is retained and reconciled through core before fresh evidence management", async () => {
		const f = await fixture();
		await f.engine.tick();
		const status = f.store.status();
		const wake = status.wakes[0];
		const attempt = status.attempts[0];
		f.store.claimManagement({
			id: "crashed-judgment",
			wakeId: wake.id,
			actionId: wake.actionId,
			attemptId: attempt.id,
			planRevision: 1,
			evidenceSha256: "f".repeat(64),
		});
		expect(() =>
			f.engine.applyPlan({ version: 1, tickets: [{ id: "OTHER", owner: "other" }], actions: [], slots: [] }, 1),
		).toThrow(/judgment|management/i);
		const actor = pin(f.directory, "actor-stopped.json", {
			version: 1,
			requestId: "crashed-judgment",
			actorIdentity: "fixture-old-manager",
			stopped: true,
			authorityRevoked: true,
		});
		const provider = pin(f.directory, "provider.json", {
			version: 1,
			requestId: "crashed-judgment",
			disposition: "not-submitted",
		});
		const proof: ManagementReconciliation = {
			version: 1,
			requestId: "crashed-judgment",
			wakeId: wake.id,
			attemptId: attempt.id,
			planRevision: 1,
			priorActor: {
				identity: "fixture-old-manager",
				stopped: true,
				authorityRevoked: true,
				ref: actor.path,
				sha256: actor.sha256,
			},
			providerRequest: { disposition: "not-submitted", ref: provider.path, sha256: provider.sha256 },
			artifacts: [],
		};
		f.setNext(() => ({
			kind: "resume-judgment",
			supplementalEvidence: [f.repair],
			recovery: { requestId: "crashed-judgment", reconciliation: pin(f.directory, "reconcile.json", proof) },
		}));
		expect((await f.continuation.step()).kind).toBe("coordinator");
		expect(f.managementCalls).toHaveBeenCalledTimes(0);
		expect((await f.continuation.step()).kind).toBe("managed");
		expect(f.store.managementRequests()[0].state).toBe("RECONCILED");
		expect((await f.continuation.step()).kind).toBe("managed");
		expect(f.store.managementRequests()).toHaveLength(2);
		expect(f.store.managementRequests()[1].state).toBe("APPLIED");
	});

	test("uncertain dispatched coordinator never replays; explicit no-submission/full-custody proof is required", async () => {
		const f = await fixture();
		await accepted(f);
		f.setNext(() => gate(f));
		await f.continuation.step();
		const context = f.getContext();
		f.setInspection({ kind: "uncertain", reason: "runner unreachable; provider execution unknown" });
		f.restart();
		for (let index = 0; index < 3; index++) expect((await f.continuation.step()).kind).toBe("blocked");
		expect(f.coordinatorLaunches).toHaveBeenCalledTimes(1);
		const actor = pin(f.directory, "recovered-actor.json", {
			requestId: context.attempt.id,
			identity: "fixture-old-controller",
			stopped: true,
			authorityRevoked: true,
		});
		const provider = pin(f.directory, "recovered-provider.json", {
			requestId: context.attempt.id,
			disposition: "not-submitted",
		});
		const workspace = pin(f.directory, "recovered-workspace.json", {
			requestId: context.attempt.id,
			path: context.action.command.cwd,
			fullWorkspaceReconciled: true,
			noEffects: true,
		});
		const proof = pin(f.directory, "outbox-recovery.json", {
			version: 1,
			requestId: context.attempt.id,
			authorization: f.config.coordinator.authorization,
			priorActor: actor,
			providerRequest: provider,
			workspace,
			artifacts: [f.repair],
			disposition: "not-submitted",
		});
		f.continuation.reconcile(context.attempt.id, proof);
		f.setInspection(undefined);
		expect((await f.continuation.step()).kind).toBe("coordinator");
		expect(f.coordinatorLaunches).toHaveBeenCalledTimes(2);
		expect(f.getContext().attempt.id).not.toBe(context.attempt.id);
		expect(readOneironContinuationStatus(join(f.factoryDirectory, "factory.db")).requests).toHaveLength(2);
	});

	test("real existing CommandAdapter supervises native-argv fake CLI and consumes terminal response after controller restart without duplicate launch", async () => {
		const f = await fixture(true);
		await accepted(f);
		const next = f.make({
			kind: "collect",
			repo: "fixture/repo",
			pr: 1,
			base: "main",
			helper: f.repair,
			foregroundShim: f.repair,
		});
		pin(f.directory, "native-next.json", next);
		const admitted = await f.continuation.step();
		expect(admitted.kind).toBe("coordinator");
		const supported = Object.keys(createAllToolDefinitions(f.directory));
		expect(supported).toEqual(["ipython"]);
		const command = parse<{ command: { argv: string[]; env: Record<string, string> } }>(
			join(f.config.coordinator.runnerRoot, admitted.requestId!, "manifest.json"),
		).command;
		expect(command.argv[command.argv.indexOf("--tools") + 1]).toBe("ipython");
		expect(command.argv[command.argv.indexOf("--thinking") + 1]).toBe("medium");
		expect(command.env.PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND).toBe("1");
		expect(classifyOwnedSessionWorkerInvocation(command.argv.slice(2), false, command.env)).toBe("json");
		const ownedWorker = createOwnedWorkerLaunchSpec(command.argv.slice(2), command.argv[0], [], command.argv[1]);
		expect(ownedWorker.command).toBe(command.argv[0]);
		expect(ownedWorker.args).toEqual(command.argv.slice(1));
		f.restart();
		const terminalPath = join(f.config.coordinator.runnerRoot, admitted.requestId!, "terminal.json");
		if (!existsSync(terminalPath))
			await new Promise<void>((resolveReady, reject) => {
				const watcher = watch(join(f.config.coordinator.runnerRoot, admitted.requestId!), () => {
					if (existsSync(terminalPath)) done();
				});
				const timer = setTimeout(() => done(new Error("No fixture coordinator terminal receipt")), 10000);
				const done = (error?: Error) => {
					watcher.close();
					clearTimeout(timer);
					if (error) reject(error);
					else resolveReady();
				};
				if (existsSync(terminalPath)) done();
			});
		const state = readOneironContinuationStatus(join(f.factoryDirectory, "factory.db"));
		expect(state.requests).toEqual(
			expect.arrayContaining([expect.objectContaining({ processState: "terminal-unconsumed" })]),
		);
		expect((await f.continuation.step()).kind).toBe("imported");
		expect(readFileSync(join(f.directory, "native-launches.log"), "utf8").trim().split("\n")).toEqual([
			admitted.requestId,
		]);
		const provenance = parse<{ requested: { model: string }; source: string }>(
			join(admitted.output, "model-provenance.json"),
		);
		expect(provenance).toMatchObject({
			requested: { model: "gpt-6-astra", effort: "medium" },
			coordinatorDecision: { decisionClass: "routine", source: "default" },
			source: "provider-response",
		});
		f.restart();
		expect((await f.continuation.step()).kind).toBe("waiting");
		expect(readdirSync(f.config.coordinator.runnerRoot)).toEqual([admitted.requestId]);
	}, 20000);

	test("stop during management authentication/response blocks application and coordinator launch", async () => {
		const f = await fixture();
		await f.engine.tick();
		let stopped = false;
		const manager: ManagementCallerFactory = (before) => async (_system, text) => {
			before();
			stopped = true;
			const packet = JSON.parse(text) as ManagementPacket;
			return {
				model: "mock-manager",
				text: JSON.stringify({
					version: 1,
					actionId: packet.action.id,
					attemptId: packet.attempt?.id,
					planRevision: packet.planRevision,
					decision: "accept",
					reason: "Fixture response finishes after supervisor stop; it must not apply.",
					evidenceRefs: [packet.evidence[0].ref],
				}),
			};
		};
		const stoppedConsumer = new OneironContinuation(
			f.engine,
			f.config,
			f.coordinator,
			manager,
			f.verifyRebind,
			() => stopped,
		);
		try {
			await expect(stoppedConsumer.step()).rejects.toThrow(/pause blocks continuation/);
			expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
			expect(f.store.managementRequests()[0].state).toBe("PROPOSED");
			expect(f.coordinatorLaunches).not.toHaveBeenCalled();
		} finally {
			stoppedConsumer.close();
		}
	});

	test("missing stage receipt gets one explicit diagnostic outbox and a durable external-evidence wait", async () => {
		const f = await fixture();
		await f.engine.tick();
		// Only a disposable fixture artifact is removed to simulate controller-visible missing evidence.
		rmSync(join(f.manifests[0].outputDirectory, "receipt.json"));
		const waitPath = join(f.directory, "reconciled-receipt.json");
		f.setNext(() => ({
			kind: "wait",
			actor: "fixture-retained-artifact-reconciler",
			path: waitPath,
			observedSha256: null,
			instructions: f.repair,
		}));
		const result = await f.continuation.step();
		expect(result.kind).toBe("coordinator");
		expect(parse<OneironSuccessorPacket>(join(result.output, "packet.json")).requiredWork).toContain(
			"missing/invalid binding",
		);
		expect((await f.continuation.step()).kind).toBe("waiting");
		f.restart();
		expect((await f.continuation.step()).kind).toBe("waiting");
		expect(f.managementCalls).not.toHaveBeenCalled();
		expect(f.coordinatorLaunches).toHaveBeenCalledTimes(1);
	});

	test("failed-stage rejection recovers exact committed effect after lost outbox acknowledgement", async () => {
		const f = await fixture();
		const claim = f.store.claim(f.first.id, "slot1")!;
		f.store.markSubmitted(claim.attempt.id);
		const terminal = {
			attemptId: claim.attempt.id,
			sourceFingerprint: f.source.fingerprint,
			exitCode: 1,
			finishedAt: new Date().toISOString(),
		};
		f.store.complete(terminal);
		f.setNext(() => ({
			kind: "reject-failed-stage",
			terminalReceipt: pin(f.directory, "failed-terminal.json", terminal),
		}));
		expect((await f.continuation.step()).kind).toBe("coordinator");
		const crash = vi.spyOn(f.engine, "decide").mockImplementationOnce((...args) => {
			f.store.decide(...args);
			throw new Error("crash after rejection commit");
		});
		await expect(f.continuation.step()).rejects.toThrow(/crash after rejection/);
		crash.mockRestore();
		f.restart();
		expect((await f.continuation.step()).reason).toContain("Recovered exact committed");
		expect(f.store.actions()[0].state).toBe("REJECTED");
		expect(f.store.events().filter((event) => event.kind === "action_decided")).toHaveLength(1);
		expect(f.coordinatorLaunches).toHaveBeenCalledTimes(1);
	});

	test("late coordinator result cannot act after explicit outbox authority revocation", async () => {
		const f = await fixture();
		await accepted(f);
		f.setNext(() =>
			f.make({
				kind: "collect",
				repo: "fixture/repo",
				pr: 1,
				base: "main",
				helper: f.repair,
				foregroundShim: f.repair,
			}),
		);
		await f.continuation.step();
		const context = f.getContext();
		const inspect = f.coordinator.inspect;
		let finish!: (value: Inspection) => void;
		const delayed = vi.spyOn(f.coordinator, "inspect").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const inFlight = f.continuation.step();
		const actor = pin(f.directory, "late-actor.json", {
			requestId: context.attempt.id,
			identity: "old-fixture",
			stopped: true,
			authorityRevoked: true,
		});
		const provider = pin(f.directory, "late-provider.json", {
			requestId: context.attempt.id,
			disposition: "not-submitted",
		});
		const workspace = pin(f.directory, "late-workspace.json", {
			requestId: context.attempt.id,
			path: context.action.command.cwd,
			fullWorkspaceReconciled: true,
			noEffects: true,
		});
		f.continuation.reconcile(
			context.attempt.id,
			pin(f.directory, "late-recovery.json", {
				version: 1,
				requestId: context.attempt.id,
				authorization: f.config.coordinator.authorization,
				priorActor: actor,
				providerRequest: provider,
				workspace,
				artifacts: [f.repair],
				disposition: "not-submitted",
			}),
		);
		finish(await inspect(context));
		await expect(inFlight).rejects.toThrow(/authority changed/);
		delayed.mockRestore();
		expect(f.store.status().planRevision).toBe(1);
		expect(f.store.actions()).toHaveLength(1);
	});

	test("failed primary Astra writer without project receipt can reject then import and execute one reconciled Astra whole-attempt retry", async () => {
		const f = await fixture();
		await accepted(f);
		const triage = f.receipts[0];
		f.setNext(() =>
			f.make({
				kind: "writer",
				triage,
				prompt: f.repair,
				writerProfile: pin(f.directory, "primary-profile.json", defaultOneironWriterProfile(f.runtime)),
			}),
		);
		expect((await successor(f)).kind).toBe("imported");
		const writer = f.store.actions().at(-1)!;
		const claim = f.store.claim(writer.id, "slot1")!;
		f.store.markSubmitted(claim.attempt.id);
		const priorManifest = { path: writer.command.argv.at(-4)!, sha256: writer.command.argv.at(-2)! };
		const manifest = parse<OneironManifest>(priorManifest.path);
		mkdirSync(manifest.outputDirectory);
		const intent = pin(manifest.outputDirectory, "intent.json", {
			fixtureOnly: true,
			failedBeforeProjectReceipt: true,
		});
		const terminal = {
			attemptId: claim.attempt.id,
			sourceFingerprint: f.source.fingerprint,
			exitCode: 1,
			finishedAt: new Date().toISOString(),
			artifact: { ref: f.workspace, sourceFingerprint: f.source.fingerprint },
		};
		f.store.complete(terminal);
		const terminalPin = pin(f.directory, "failed-writer-terminal.json", terminal);
		f.setNext(() => ({ kind: "reject-failed-stage", terminalReceipt: terminalPin }));
		expect((await f.continuation.step()).kind).toBe("coordinator");
		expect((await f.continuation.step()).kind).toBe("managed");
		expect(existsSync(join(manifest.outputDirectory, "receipt.json"))).toBe(false);
		f.setNext((packet) => {
			expect(packet.outcome).toBe("REJECTED");
			expect(packet.receipt).toBeNull();
			const profile = pin(f.directory, "retry-profile.json", {
				version: 1,
				mode: "astra-retry",
				requested: { provider: "cpa-r", model: "gpt-6-astra", effort: "xhigh" },
				approvedResponseModels: ["gpt-6-astra"],
				runtime: f.runtime,
			});
			const next = f.make({
				kind: "writer",
				triage,
				prompt: f.repair,
				writerProfile: profile,
				retryReconciliation: f.repair,
			});
			const retry = parse<OneironManifest>(next.manifest.path);
			const processProof = pin(f.directory, "retry-process-proof.json", {
				fixtureOnly: true,
				priorStopped: true,
				fullWorkspaceReconciled: true,
			});
			const reconciliation = pin(f.directory, "retry-reconciliation.json", {
				version: 1,
				decision: "retry-whole-attempt",
				ticketId: f.config.ticketId,
				priorActionId: writer.id,
				priorAttemptId: claim.attempt.id,
				priorManifest,
				priorTerminal: terminalPin,
				processProof,
				retainedEvidence: [intent, terminalPin, triage],
				workspaceDisposition: "restored",
				reconciledSource: f.source,
				custody: retry.custody,
				ownerAuthorization: f.config.coordinator.authorization,
				noLiveProcesses: true,
				noDuplicateExecution: true,
				expiresAt: new Date(Date.now() + 60000).toISOString(),
			});
			const pinnedManifest = pin(f.directory, "retry-final-manifest.json", {
				...retry,
				stage: { ...retry.stage, retryReconciliation: reconciliation },
			});
			const permit = pin(f.directory, "retry-final-permit.json", {
				...parse<Record<string, unknown>>(next.permit.path),
				manifestSha256: pinnedManifest.sha256,
			});
			return { ...next, manifest: pinnedManifest, permit };
		});
		expect((await successor(f)).kind).toBe("imported");
		const launch = f.stageAdapter.launch;
		const admitted = vi.spyOn(f.stageAdapter, "launch").mockImplementationOnce(async (context) => {
			const previous = process.env.PRIME_FACTORY_ATTEMPT_ID;
			process.env.PRIME_FACTORY_ATTEMPT_ID = context.attempt.id;
			try {
				return await launch(context);
			} finally {
				if (previous === undefined) delete process.env.PRIME_FACTORY_ATTEMPT_ID;
				else process.env.PRIME_FACTORY_ATTEMPT_ID = previous;
			}
		});
		await accepted(f);
		admitted.mockRestore();
		expect(f.store.attempts()).toHaveLength(3);
		expect(f.store.actions().at(-1)?.state).toBe("ACCEPTED");
	});

	test("coordinator effort defaults medium and accepts only exact named scopes, including verified future-stage instructions", async () => {
		const reason = "Named fixture decision requires wider evidence reconciliation for this exact action.";
		for (const [decisionClass, effort] of [
			["broader-replanning", "high"],
			["cross-ticket-conflict", "high"],
			["unresolved-architecture", "xhigh"],
			["unresolved-correctness", "xhigh"],
		] as const) {
			const f = await fixture(false, { decisionClass, reason });
			await accepted(f);
			f.setNext(() => ({
				kind: "wait",
				actor: "fixture-evidence-producer",
				path: join(f.directory, "next-evidence.json"),
				observedSha256: null,
				instructions: f.repair,
			}));
			const admitted = await f.continuation.step();
			const packet = parse<OneironSuccessorPacket>(join(admitted.output, "packet.json"));
			expect(packet.coordinatorDecision).toMatchObject({
				requestedProfile: { provider: "cpa-r", model: "gpt-6-astra", effort },
				scopeActionId: f.first.id,
				decisionClass,
				reason,
				source: "config-action",
				sourceRequestId: null,
			});
			const argv = f.getContext().action.command.argv;
			expect(argv[argv.indexOf("--thinking") + 1]).toBe(effort);
			f.restart();
			expect((await f.continuation.step()).kind).toBe("waiting");
			expect(parse<Record<string, unknown>>(join(admitted.output, "model-provenance.json"))).toMatchObject({
				requested: { effort },
				coordinatorDecision: packet.coordinatorDecision,
			});
			expect(
				selectOneironCoordinatorDecision("unmatched-future-action", f.config.coordinator.effortOverrides)
					.requestedProfile.effort,
			).toBe("medium");
		}
		const scoped: OneironCoordinatorEffortOverride = {
			actionId: "exact-action",
			decisionClass: "broader-replanning",
			reason,
		};
		expect(() => selectOneironCoordinatorDecision("exact-action", [scoped, scoped])).toThrow(/unique/);
		expect(() => selectOneironCoordinatorDecision("exact-action", [{ ...scoped, reason: "" }])).toThrow(
			/bounded reason/,
		);
		expect(() =>
			selectOneironCoordinatorDecision("exact-action", [
				{ ...scoped, decisionClass: "routine" } as unknown as OneironCoordinatorEffortOverride,
			]),
		).toThrow(/named decision class/);
		expect(() =>
			selectOneironCoordinatorDecision("exact-action", [
				{ ...scoped, effort: "xhigh" } as OneironCoordinatorEffortOverride,
			]),
		).toThrow(/no raw effort/);
		expect(() =>
			selectOneironCoordinatorDecision("exact-action", [scoped], {
				requestId: "prior",
				decision: { ...scoped, decisionClass: "unresolved-correctness" },
			}),
		).toThrow(/conflict/);

		const f = await fixture();
		await accepted(f);
		const next = f.make({
			kind: "collect",
			repo: "fixture/repo",
			pr: 1,
			base: "main",
			helper: f.repair,
			foregroundShim: f.repair,
		});
		const nextAction = prepareOneiron(parse<OneironManifest>(next.manifest.path), {
			manifestPath: next.manifest.path,
			permitPath: next.permit.path,
			adapterArgv: f.config.adapterArgv,
			host: next.host,
			slotId: next.slotId,
		}).action!;
		f.setNext(() => next);
		f.setFutureDecision({ actionId: nextAction.id, decisionClass: "cross-ticket-conflict", reason });
		const imported = await successor(f);
		expect(imported.kind).toBe("imported");
		const previousRequestId = imported.requestId;
		f.setFutureDecision(undefined);
		await accepted(f);
		f.setNext(() => ({
			kind: "wait",
			actor: "fixture-conflict-evidence",
			path: join(f.directory, "conflict-result.json"),
			observedSha256: null,
			instructions: f.repair,
		}));
		const admitted = await f.continuation.step();
		const packet = parse<OneironSuccessorPacket>(join(admitted.output, "packet.json"));
		expect(packet.coordinatorDecision).toMatchObject({
			requestedProfile: { effort: "high" },
			decisionClass: "cross-ticket-conflict",
			reason,
			source: "successor-instruction",
			sourceRequestId: previousRequestId,
		});
		f.restart();
		expect((await f.continuation.step()).kind).toBe("waiting");
		expect(parse<Record<string, unknown>>(join(admitted.output, "model-provenance.json"))).toMatchObject({
			requested: { effort: "high" },
			coordinatorDecision: packet.coordinatorDecision,
		});

		const invalid = await fixture();
		await accepted(invalid);
		invalid.setNext(() =>
			invalid.make({
				kind: "collect",
				repo: "fixture/repo",
				pr: 1,
				base: "main",
				helper: invalid.repair,
				foregroundShim: invalid.repair,
			}),
		);
		invalid.setFutureDecision({ ...scoped, actionId: "not-the-prepared-successor" });
		await expect(successor(invalid)).rejects.toThrow(/exact prepared successor/);
		expect(invalid.store.status().planRevision).toBe(1);
	});

	test.each(["local", "external"])(
		"%s pause retains all fences, admits no stage, manager or coordinator",
		async (kind) => {
			const f = await fixture();
			if (kind === "local") f.engine.pause("fixture pause");
			else writeFileSync(f.config.ownerPauseFile, "owner pause\n");
			expect((await f.continuation.step()).kind).toBe("paused");
			expect((await f.engine.tick()).launched).toEqual([]);
			expect(f.managementCalls).not.toHaveBeenCalled();
			expect(f.coordinatorLaunches).not.toHaveBeenCalled();
		},
	);
});
