import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CommandAdapter, type CommandHost, fingerprintCommand } from "../src/factory/adapters/command.js";
import {
	bindOneironEvidence,
	type OneironManifest,
	type OneironPermit,
	type OneironReceipt,
	prepareOneiron,
} from "../src/factory/adapters/oneiron.js";
import { inspectOneironCorpus, type OneironPin, oneironSha } from "../src/factory/adapters/oneiron-review.js";
import { FactoryEngine } from "../src/factory/engine.js";
import type { ManagementPacket } from "../src/factory/management.js";
import {
	type ManagementCallerFactory,
	manageFactoryWake,
	watchFactoryManagement,
} from "../src/factory/management-dispatch.js";
import { hashFactoryRuntimeFile } from "../src/factory/runtime.js";
import { FactoryStore } from "../src/factory/store.js";

const roots: string[] = [];
const stores = new Set<FactoryStore>();
const originalPath = process.env.PATH;
const tsx = fileURLToPath(import.meta.resolve("tsx"));
const entry = resolve("src/factory/adapters/oneiron-entry.ts");
const factoryEntry = resolve("src/factory/cli-entry.ts");
function pin(directory: string, name: string, value: unknown): OneironPin {
	const path = join(directory, name);
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
	return { path, sha256: oneironSha(readFileSync(path)) };
}
function open(path: string): FactoryStore {
	const store = new FactoryStore(path);
	stores.add(store);
	return store;
}
function close(store: FactoryStore): void {
	store.close();
	stores.delete(store);
}

async function fixture() {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "factory-oneiron-seam-")));
	roots.push(directory);
	const workspace = join(directory, "workspace");
	const factoryDirectory = join(directory, "factory");
	const bin = join(directory, "bin");
	for (const path of [workspace, factoryDirectory, bin]) mkdirSync(path);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", workspace, ...args], {
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
		}).trim();
	git("init", "-q", "-b", "fixture-seam");
	writeFileSync(join(workspace, "source.txt"), "isolated test source; no product change\n");
	git("add", "source.txt");
	git(
		"-c",
		"user.name=Factory Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"fixture",
	);
	git("remote", "add", "origin", "https://example.invalid/factory-seam.git");
	const host: CommandHost = { type: "local", runnerRoot: join(directory, "runner") };
	const source = {
		workspace,
		head: git("rev-parse", "HEAD"),
		tree: git("rev-parse", "HEAD^{tree}"),
		branch: git("rev-parse", "--abbrev-ref", "HEAD"),
		remoteUrl: git("remote", "get-url", "origin"),
		fingerprint: await fingerprintCommand(host, workspace),
	};
	const ownerPauseFile = join(directory, "OWNER-PAUSE.json");
	const expiresAt = new Date(Date.now() + 60000).toISOString();
	const ownerAuthorization = pin(directory, "authorization.json", {
		fixtureOnly: true,
		permission: "execute deterministic fixture stage",
	});
	const release = pin(directory, "release.json", { fixtureOnly: true, owner: "fixture-prior", released: true });
	const custody = pin(directory, "custody.json", {
		version: 1,
		state: "transferred",
		ticketId: "FIXTURE-1",
		owner: "fixture-owner",
		sourceFingerprint: source.fingerprint,
		expiresAt,
		priorOwners: [{ id: "fixture-prior", release }],
		activeOwners: ["fixture-owner"],
		liveProcesses: [],
		duplicateAuthorityDisabled: true,
		sharedGitClear: true,
	});
	// Synthetic local policy inputs, not claims of actual paid/GitHub reviews or a live gate.
	const body =
		"Fixture review of exact source contracts completed; no material defect is present in this synthetic example.";
	const corpus = pin(directory, "corpus.json", {
		schema: "oneiron.wave6.github-bot-corpus.v1",
		repo: "fixture/seam",
		github_mutation: false,
		pins: { 1: source.head },
		prs: [
			{
				number: 1,
				head_sha: source.head,
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
					commit_id: source.head,
				})),
			},
		],
	});
	const report = inspectOneironCorpus(readFileSync(corpus.path, "utf8"), {
		repo: "fixture/seam",
		pr: 1,
		head: source.head,
		base: "main",
	});
	const receiptBase = {
		version: 1 as const,
		ticketId: "FIXTURE-1",
		stageSha256: "a".repeat(64),
		manifestSha256: "b".repeat(64),
		input: source,
		output: source,
		custody,
		finishedAt: new Date().toISOString(),
		outcome: "stage-completed" as const,
		productAccepted: false as const,
	};
	const triage = pin(directory, "triage.json", {
		...receiptBase,
		stage: "triage",
		result: {
			triage: {
				version: 1,
				candidateCommit: source.head,
				sourceFingerprint: source.fingerprint,
				corpusSha256: report.corpusSha256,
				findings: report.items.map((item) => ({
					id: item.id,
					bodySha256: item.bodySha256,
					classification: "informational",
					disposition: "dismissed",
					reason: "This fixture contains a completed review without a material finding.",
					evidenceRefs: [`sha256:${corpus.sha256}`],
				})),
			},
		},
	});
	const gate = pin(directory, "gate.json", {
		...receiptBase,
		stage: "gate",
		result: { commandRc: 0, provenancePassed: true },
	});
	const pinnedCli = join(bin, "factory-cli.mjs");
	const statusArgs = ["--import", tsx, factoryEntry, "status", factoryDirectory];
	writeFileSync(
		pinnedCli,
		`import {execFileSync} from "node:child_process"; if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(["factory", "status", factoryDirectory]))})throw Error("fixture forbids non-status calls"); process.stdout.write(execFileSync(${JSON.stringify(process.execPath)},${JSON.stringify(statusArgs)}));`,
	);
	const factoryRuntime = pin(directory, "factory-runtime.json", {
		version: 1,
		cliArgv: [process.execPath, pinnedCli],
		files: [process.execPath, pinnedCli, entry, resolve("src/factory/adapters/oneiron.ts")].map((path) => ({
			path,
			sha256: hashFactoryRuntimeFile(path),
		})),
		capabilities: ["provider-response-model-v1"],
	});
	const manifest: OneironManifest = {
		version: 1,
		ticketId: "FIXTURE-1",
		owner: "fixture-owner",
		source,
		factoryDirectory,
		factoryRuntime,
		ownerPauseFile,
		custody,
		outputDirectory: join(directory, "output"),
		stage: {
			kind: "review-acceptance",
			repo: "fixture/seam",
			pr: 1,
			base: "main",
			corpus,
			priorFindings: pin(directory, "prior-findings.json", []),
			evidence: [],
			triage,
			gates: [gate],
		},
	};
	const manifestPin = pin(directory, "manifest.json", manifest);
	const permit: OneironPermit = {
		version: 1,
		permission: "execute",
		manifestSha256: manifestPin.sha256,
		ticketId: manifest.ticketId,
		stage: manifest.stage.kind,
		sourceFingerprint: source.fingerprint,
		custodySha256: custody.sha256,
		owner: manifest.owner,
		ownerAuthorization,
		expiresAt,
	};
	const permitPin = pin(directory, "permit.json", permit);
	const prepared = prepareOneiron(manifest, {
		manifestPath: manifestPin.path,
		adapterArgv: [process.execPath, "--import", tsx, entry],
		permitPath: permitPin.path,
		host: "local",
		slotId: "fixture-slot",
	});
	if (!prepared.action) throw new Error("Fixture must execute a fresh stage");
	prepared.action.command.timeoutMs = 15000;
	// Status uses the explicitly pinned fixture CLI above, never PATH-selected installed Prime.
	pin(factoryDirectory, "config.json", { version: 1, hosts: { local: host }, pauseFile: ownerPauseFile });
	const db = join(factoryDirectory, "factory.db");
	const store = open(db);
	const adapter = new CommandAdapter({ local: host }, { pauseFile: ownerPauseFile });
	const engine = new FactoryEngine(store, adapter, { enabled: true, pauseFile: ownerPauseFile });
	engine.applyPlan({
		version: 1,
		tickets: [{ id: manifest.ticketId, owner: manifest.owner }],
		slots: [{ id: "fixture-slot", host: "local" }],
		actions: [prepared.action],
		roles: { ticketOwner: { provider: "fixture", model: "mock-acceptance", effort: "low" } },
	});
	return {
		directory,
		manifest,
		manifestPin,
		permitPin,
		host,
		db,
		store,
		adapter,
		engine,
		action: prepared.action,
		git,
	};
}

function awaitTerminal(directory: string): Promise<void> {
	const path = join(directory, "terminal.json");
	if (existsSync(path)) return Promise.resolve();
	return new Promise((resolveReady, reject) => {
		const watcher = watch(directory, () => {
			if (existsSync(path)) finish();
		});
		const timer = setTimeout(() => finish(new Error(`No terminal receipt: ${directory}`)), 20000);
		const finish = (error?: Error) => {
			watcher.close();
			clearTimeout(timer);
			if (error) reject(error);
			else resolveReady();
		};
		watcher.once("error", finish);
		if (existsSync(path)) finish();
	});
}
async function execute(f: Awaited<ReturnType<typeof fixture>>) {
	const tick = await f.engine.tick();
	expect(tick.launched).toHaveLength(1);
	const attemptId = tick.launched[0];
	const runnerDirectory = join(f.host.runnerRoot, attemptId);
	await awaitTerminal(runnerDirectory);
	expect((await f.engine.tick()).launched).toEqual([]);
	const attempt = f.store.attempts()[0];
	expect(attempt.state).toBe("TERMINAL");
	expect(attempt.receipt?.exitCode, readFileSync(join(runnerDirectory, "stderr.log"), "utf8")).toBe(0);
	const receiptPath = join(f.manifest.outputDirectory, "receipt.json");
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as OneironReceipt;
	const receiptPin = { path: receiptPath, sha256: oneironSha(readFileSync(receiptPath)) };
	return { attempt, runnerDirectory, receipt, receiptPin };
}
function mockAcceptance() {
	const invoke = vi.fn(async (packetText: string) => {
		const packet = JSON.parse(packetText) as ManagementPacket;
		const stage = JSON.parse(packet.evidence[0].content) as OneironReceipt;
		expect(stage.stage).toBe("review-acceptance");
		expect(stage.result.acceptanceEligible).toBe(true);
		expect(stage.productAccepted).toBe(false);
		return {
			model: "mock-acceptance",
			text: JSON.stringify({
				version: 1,
				actionId: packet.action.id,
				attemptId: packet.attempt?.id,
				planRevision: packet.planRevision,
				decision: "accept",
				reason:
					"The deterministic fixture review-acceptance stage has exact-source proof; this is not product publication.",
				evidenceRefs: [packet.evidence[0].ref],
			}),
		};
	});
	const create: ManagementCallerFactory = (beforeRequest) => async (_system, packet) => {
		beforeRequest();
		return invoke(packet);
	};
	return { invoke, create };
}
function writeBinding(f: Awaited<ReturnType<typeof fixture>>, receiptPin: OneironPin) {
	const binding = bindOneironEvidence(f.engine.status(), f.action.id, f.manifest, receiptPin);
	const path = join(f.manifest.factoryDirectory, "management-evidence");
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, `${binding.wakeId}.json`), JSON.stringify(binding));
	return binding;
}
afterEach(() => {
	process.env.PATH = originalPath;
	for (const store of stores) store.close();
	stores.clear();
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Oneiron foreground command to durable automatic management seam", () => {
	test.each(["dot-prefix", "symlink-alias"])(
		"preparation rejects %s output paths inside the source workspace",
		async (kind) => {
			const f = await fixture();
			const alias = join(f.directory, "workspace-alias");
			symlinkSync(f.manifest.source.workspace, alias);
			const outputDirectory =
				kind === "dot-prefix" ? join(f.manifest.source.workspace, "..stage-output") : join(alias, "stage-output");
			const manifest = { ...f.manifest, outputDirectory };
			const manifestPin = pin(f.directory, "unsafe-output-manifest.json", manifest);
			expect(() =>
				prepareOneiron(manifest, {
					manifestPath: manifestPin.path,
					adapterArgv: [process.execPath, "--import", tsx, entry],
					permitPath: f.permitPin.path,
					host: "local",
					slotId: "fixture-slot",
				}),
			).toThrow(/outside/);
			expect(existsSync(manifest.outputDirectory)).toBe(false);
			expect(f.store.attempts()).toEqual([]);
		},
	);
	test("runs the real project stage and runner, binds exact evidence, accepts once and survives store reopen", async () => {
		const f = await fixture();
		const model = mockAcceptance();
		const options = { directory: f.manifest.factoryDirectory, automatic: true, apply: true };
		const { attempt, runnerDirectory, receipt, receiptPin } = await execute(f);
		expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
		expect(f.store.attempts(true)).toEqual([]);
		expect(attempt.receipt?.sourceFingerprint).toBe(f.manifest.source.fingerprint);
		expect(attempt.receipt?.artifact).toEqual({
			ref: f.manifest.source.workspace,
			sourceFingerprint: f.manifest.source.fingerprint,
		});
		expect(receipt.manifestSha256).toBe(f.manifestPin.sha256);
		expect(receipt.stageSha256).toBe(oneironSha(JSON.stringify(f.manifest.stage)));
		expect(receipt.input).toEqual(f.manifest.source);
		expect(receipt.output).toEqual(f.manifest.source);
		expect(receipt.custody).toEqual(f.manifest.custody);
		expect(JSON.parse(readFileSync(join(runnerDirectory, "manifest.json"), "utf8")).command.argv).toEqual(
			f.action.command.argv,
		);
		expect(JSON.parse(readFileSync(join(runnerDirectory, "stdout.log"), "utf8"))).toEqual(receipt);
		expect(f.git("status", "--porcelain")).toBe("");
		expect(await fingerprintCommand(f.host, f.manifest.source.workspace)).toBe(f.manifest.source.fingerprint);
		expect((await manageFactoryWake(f.engine, options, model.create)).kind).toBe("idle");
		expect(model.invoke).not.toHaveBeenCalled();
		const binding = writeBinding(f, receiptPin);
		expect(binding).toMatchObject({
			actionId: f.action.id,
			attemptId: attempt.id,
			planRevision: 1,
			wakeId: f.store.wakes()[0].id,
		});
		expect(binding.evidence[0]).toEqual({
			ref: `sha256:${receiptPin.sha256}`,
			content: JSON.stringify(receipt),
			sha256: oneironSha(JSON.stringify(receipt)),
		});
		const results: string[] = [];
		expect(
			await watchFactoryManagement(
				f.engine,
				{ ...options, maxRequests: 1, maxPasses: 1, intervalMs: 50 },
				model.create,
				(result) => results.push(result.kind),
			),
		).toEqual({ admitted: 1, passes: 1 });
		expect(results).toEqual(["applied"]);
		const request = f.store.managementRequests()[0];
		expect(request.state).toBe("APPLIED");
		expect(request.evidenceSha256).toBe(
			oneironSha(JSON.stringify([{ ref: binding.evidence[0].ref, sha256: binding.evidence[0].sha256 }])),
		);
		expect(readdirSync(join(options.directory, "decisions", request.id)).sort()).toEqual([
			"proposal.json",
			"request.json",
			"response.json",
		]);
		close(f.store);
		const recovered = open(f.db);
		const replacement = new FactoryEngine(recovered, new CommandAdapter({ local: f.host }), {
			enabled: true,
			pauseFile: f.manifest.ownerPauseFile,
		});
		expect(recovered.actions()[0].state).toBe("ACCEPTED");
		expect(recovered.wakes()[0].resolvedAt).not.toBeNull();
		expect(recovered.tickets()[0].state).toBe("RETIRED");
		expect((await replacement.tick()).launched).toEqual([]);
		expect((await manageFactoryWake(replacement, options, model.create)).kind).toBe("idle");
		expect((await f.adapter.launch(recovered.context(attempt.id))).kind).toBe("terminal");
		expect(recovered.attempts()).toHaveLength(1);
		expect(recovered.managementRequests()).toHaveLength(1);
		expect(recovered.events().filter((event) => event.kind === "action_decided")).toHaveLength(1);
		expect(readdirSync(f.host.runnerRoot)).toEqual([attempt.id]);
		expect(model.invoke).toHaveBeenCalledTimes(1);
	}, 30000);

	test("rejects substituted manifest, receipt, custody, and non-writer source evidence before management", async () => {
		const f = await fixture();
		const { receipt, receiptPin } = await execute(f);
		const status = f.engine.status();
		const bind = (value: unknown) =>
			bindOneironEvidence(status, f.action.id, f.manifest, pin(f.directory, "substituted-receipt.json", value));
		for (const change of [
			{ version: 2 },
			{ outcome: "failed" },
			{ productAccepted: true },
			{ stage: "gate" },
			{ manifestSha256: "c".repeat(64) },
			{ stageSha256: "c".repeat(64) },
			{ custody: { ...receipt.custody, sha256: "c".repeat(64) } },
			{ custody: { ...receipt.custody, path: `${receipt.custody.path}.other` } },
			{ input: { ...receipt.input, head: "c".repeat(40) } },
			{ output: { ...receipt.output, fingerprint: `git:${"c".repeat(64)}` } },
			{ output: { ...receipt.output, head: "c".repeat(40) } },
			{ output: { ...receipt.output, branch: "other-branch" } },
		])
			expect(() => bind({ ...receipt, ...change }), JSON.stringify(change)).toThrow();
		expect(() =>
			bindOneironEvidence(status, f.action.id, { ...f.manifest, owner: "other-owner" }, receiptPin),
		).toThrow(/manifest/);
		const manifestBytes = readFileSync(f.manifestPin.path);
		writeFileSync(f.manifestPin.path, `${manifestBytes.toString()} `);
		expect(() => bindOneironEvidence(status, f.action.id, f.manifest, receiptPin)).toThrow(/manifest/);
		writeFileSync(f.manifestPin.path, manifestBytes);
		writeFileSync(f.manifest.custody.path, "changed custody bytes");
		expect(() => bindOneironEvidence(status, f.action.id, f.manifest, receiptPin)).toThrow(/hash changed/);
		expect(f.store.managementRequests()).toEqual([]);
		expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
	}, 30000);

	test.each(["local", "external"])(
		"%s paused fixture launches nothing and admits no inference",
		async (kind) => {
			const f = await fixture();
			if (kind === "external") writeFileSync(f.manifest.ownerPauseFile, "fixture owner pause\n");
			else f.engine.pause("fixture owner pause");
			const model = mockAcceptance();
			expect(await f.engine.tick()).toEqual({ launched: [], reconciled: [], paused: true });
			const results: string[] = [];
			expect(
				await watchFactoryManagement(
					f.engine,
					{ directory: f.manifest.factoryDirectory, apply: true, maxRequests: 1, maxPasses: 1, intervalMs: 50 },
					model.create,
					(result) => results.push(result.kind),
				),
			).toEqual({ admitted: 0, passes: 1 });
			expect(results).toEqual(["paused"]);
			expect(f.store.attempts()).toEqual([]);
			expect(f.store.managementRequests()).toEqual([]);
			expect(existsSync(f.host.runnerRoot)).toBe(false);
			expect(existsSync(f.manifest.outputDirectory)).toBe(false);
			expect(model.invoke).not.toHaveBeenCalled();
			if (kind === "external") expect(readFileSync(f.manifest.ownerPauseFile, "utf8")).toBe("fixture owner pause\n");
			else expect(f.store.isPaused()).toBe(true);
		},
		30000,
	);

	test("a paused completed fixture cannot consume even correctly bound pending evidence", async () => {
		const f = await fixture();
		const { receiptPin } = await execute(f);
		writeBinding(f, receiptPin);
		writeFileSync(f.manifest.ownerPauseFile, "fixture owner pause\n");
		const model = mockAcceptance();
		expect(
			(
				await manageFactoryWake(
					f.engine,
					{ directory: f.manifest.factoryDirectory, automatic: true, apply: true },
					model.create,
				)
			).kind,
		).toBe("paused");
		expect((await f.engine.tick()).launched).toEqual([]);
		expect(f.store.attempts()).toHaveLength(1);
		expect(f.store.managementRequests()).toEqual([]);
		expect(f.store.wakes()[0].resolvedAt).toBeNull();
		expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
		expect(readFileSync(f.manifest.ownerPauseFile, "utf8")).toBe("fixture owner pause\n");
		expect(model.invoke).not.toHaveBeenCalled();
	}, 30000);

	test("rejects a post-prepare manifest change in the foreground child before stage execution", async () => {
		const f = await fixture();
		writeFileSync(f.manifestPin.path, `${readFileSync(f.manifestPin.path, "utf8")} `);
		const tick = await f.engine.tick();
		expect(tick.launched).toHaveLength(1);
		const runnerDirectory = join(f.host.runnerRoot, tick.launched[0]);
		await awaitTerminal(runnerDirectory);
		await f.engine.tick();
		expect(f.store.attempts()[0].receipt?.exitCode).toBe(1);
		expect(readFileSync(join(runnerDirectory, "stderr.log"), "utf8")).toContain("Prepared manifest hash changed");
		expect(existsSync(f.manifest.outputDirectory)).toBe(false);
		const model = mockAcceptance();
		expect(
			(
				await manageFactoryWake(
					f.engine,
					{ directory: f.manifest.factoryDirectory, automatic: true, apply: true },
					model.create,
				)
			).kind,
		).toBe("idle");
		expect(model.invoke).not.toHaveBeenCalled();
		expect(f.store.managementRequests()).toEqual([]);
	}, 30000);
});
