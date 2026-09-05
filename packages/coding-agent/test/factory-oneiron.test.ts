import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CommandAdapter, fingerprintCommand } from "../src/factory/adapters/command.js";
import {
	bindOneironEvidence,
	executeOneiron,
	inspectOneiron,
	type OneironManifest,
	type OneironPermit,
	type OneironReceipt,
	type OneironRuntime,
	prepareOneiron,
} from "../src/factory/adapters/oneiron.js";
import { inspectOneironCorpus, type OneironPin, oneironSha } from "../src/factory/adapters/oneiron-review.js";
import { defaultOneironWriterProfile, validateOneironWriterReceipt } from "../src/factory/adapters/oneiron-writer.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { createManagementPacket, proposeManagementDecision } from "../src/factory/management.js";
import { FactoryStore } from "../src/factory/store.js";

const roots: string[] = [];
const head = "a".repeat(40);
function frozenCorpus(commit = head) {
	return JSON.stringify({
		schema: "oneiron.wave6.github-bot-corpus.v1",
		repo: "org/repo",
		github_mutation: false,
		pins: { 855: commit },
		prs: [
			{
				number: 855,
				head_sha: commit,
				base_ref: "main",
				raw: { review_comments: [] },
				items: ["qodo-code-review[bot]", "chatgpt-codex-connector[bot]"].map((login, index) => {
					const body = "Reviewed code paths and tests. This exact change has no material contract violations.";
					return {
						key: `review:${index}`,
						id: index,
						sources: ["review"],
						author: { login },
						body,
						body_sha256: oneironSha(body),
						state: "COMMENTED",
						commit_id: commit,
					};
				}),
			},
		],
	});
}
function setup() {
	const directory = mkdtempSync(join(tmpdir(), "factory-oneiron-"));
	roots.push(directory);
	let counter = 0;
	const pin = (value: unknown): OneironPin => {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		const path = join(directory, `evidence-${counter++}.json`);
		writeFileSync(path, text);
		return { path, sha256: oneironSha(text) };
	};
	const source = {
		workspace: join(directory, "workspace"),
		head,
		tree: "b".repeat(40),
		branch: "w6/ticket",
		remoteUrl: "git@github.com:org/repo.git",
		fingerprint: `git:${"c".repeat(64)}`,
	};
	mkdirSync(source.workspace);
	const release = pin({ owner: "old-owner", released: true });
	const custody = pin({
		version: 1,
		state: "transferred",
		ticketId: "ONE-1914",
		owner: "factory-owner",
		sourceFingerprint: source.fingerprint,
		expiresAt: "2099-01-01",
		priorOwners: [{ id: "old-owner", release }],
		activeOwners: ["factory-owner"],
		liveProcesses: [],
		duplicateAuthorityDisabled: true,
		sharedGitClear: true,
	});
	const manifest: OneironManifest = {
		version: 1,
		ticketId: "ONE-1914",
		owner: "factory-owner",
		source,
		factoryDirectory: join(directory, "factory"),
		ownerPauseFile: join(directory, "OWNER-PAUSE"),
		custody,
		outputDirectory: join(directory, "output"),
		stage: {
			kind: "triage",
			repo: "org/repo",
			pr: 855,
			base: "main",
			corpus: pin(frozenCorpus()),
			priorFindings: pin([]),
			evidence: [],
		},
	};
	const runtimeDirectory = join(directory, "pinned-runtime");
	mkdirSync(runtimeDirectory);
	const runtimeNode = join(runtimeDirectory, "node");
	const runtimeCli = join(runtimeDirectory, "cli.js");
	writeFileSync(runtimeNode, "fixture Node");
	writeFileSync(runtimeCli, "fixture CLI");
	manifest.factoryRuntime = pin({
		version: 1,
		cliArgv: [runtimeNode, runtimeCli],
		files: [runtimeNode, runtimeCli].map((path) => ({ path, sha256: oneironSha(readFileSync(path)) })),
		capabilities: ["provider-response-model-v1"],
	});
	const manifestPath = join(directory, "manifest.json");
	const permitPath = join(directory, "permit.json");
	const seal = () => {
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const permit: OneironPermit = {
			version: 1,
			permission: "execute",
			manifestSha256: oneironSha(readFileSync(manifestPath)),
			ticketId: manifest.ticketId,
			stage: manifest.stage.kind,
			sourceFingerprint: manifest.source.fingerprint,
			custodySha256: manifest.custody.sha256,
			owner: manifest.owner,
			ownerAuthorization: release,
			expiresAt: "2099-01-01",
		};
		writeFileSync(permitPath, JSON.stringify(permit));
	};
	const runtime: OneironRuntime = {
		now: Date.now,
		status: vi.fn(async () => ({ paused: false, ownerPaused: false })),
		source: vi.fn(async () => ({ ...manifest.source })),
		run: vi.fn(async () => ""),
		call: vi.fn(async (_system, packet) => {
			const data = JSON.parse(packet) as {
				candidateCommit: string;
				sourceFingerprint: string;
				corpusSha256: string;
				items: Array<{ id: string; bodySha256: string }>;
			};
			return {
				model: "gpt-6-astra",
				responseModel: "gpt-6-astra",
				responseModelSource: "provider-response" as const,
				responseId: "resp_fixture",
				text: JSON.stringify({
					version: 1,
					candidateCommit: data.candidateCommit,
					sourceFingerprint: data.sourceFingerprint,
					corpusSha256: data.corpusSha256,
					findings: data.items.map((item) => ({
						id: item.id,
						bodySha256: item.bodySha256,
						classification: "informational",
						disposition: "dismissed",
						reason: "The completed review reports no material problem in these exact changed bytes.",
						evidenceRefs: [`sha256:${data.corpusSha256}`],
					})),
				}),
			};
		}),
	};
	seal();
	const execute = () => executeOneiron(manifestPath, permitPath, true, runtime);
	return { directory, manifest, manifestPath, permitPath, pin, seal, runtime, execute };
}
function writerProfileFixture(f: ReturnType<typeof setup>): OneironPin {
	return f.pin(defaultOneironWriterProfile(f.manifest.factoryRuntime!));
}
afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Oneiron preparation and execution gates", () => {
	test("prepares a concrete triage-only decision while paused and pending transfer, without executing", () => {
		const f = setup();
		writeFileSync(f.manifest.ownerPauseFile, "paused");
		f.manifest.custody = f.pin({ status: "CONDITIONAL_TRANSFER_PREPARED", adopted_claim: false });
		f.manifest.source.branch = "HEAD";
		f.seal();
		const prepared = prepareOneiron(f.manifest, {
			manifestPath: f.manifestPath,
			adapterArgv: [process.execPath, "adapter.js"],
			permitPath: f.permitPath,
			host: "arch",
			slotId: "light",
		});
		expect(prepared.inspection.executionAuthorized).toBe(false);
		expect(prepared.inspection.ownerPaused).toBe(true);
		expect(prepared.action?.command.argv).toContain(oneironSha(readFileSync(f.manifestPath)));
		expect(prepared.action?.kind).toBe("decision");
		expect(prepared.action?.command.timeoutMs).toBe(300000);
		expect(f.runtime.call).not.toHaveBeenCalled();
		expect(existsSync(f.manifest.outputDirectory)).toBe(false);
	});
	test("blocks external pause, local pause, missing permission, expired permit, ownership and CAS mismatch before effects", async () => {
		const f = setup();
		await expect(executeOneiron(f.manifestPath, f.permitPath, false, f.runtime)).rejects.toThrow(/--execute/);
		writeFileSync(f.manifest.ownerPauseFile, "pause");
		await expect(f.execute()).rejects.toThrow(/Owner pause/);
		rmSync(f.manifest.ownerPauseFile);
		vi.mocked(f.runtime.status).mockResolvedValueOnce({ paused: true, ownerPaused: false });
		await expect(f.execute()).rejects.toThrow(/Factory pause/);
		const permit = JSON.parse(readFileSync(f.permitPath, "utf8")) as OneironPermit;
		writeFileSync(f.permitPath, JSON.stringify({ ...permit, expiresAt: "2000-01-01" }));
		await expect(f.execute()).rejects.toThrow(/permit/);
		f.seal();
		vi.mocked(f.runtime.source).mockResolvedValueOnce({ ...f.manifest.source, head: "d".repeat(40) });
		await expect(f.execute()).rejects.toThrow(/CAS/);
		f.manifest.custody = f.pin({ version: 1, state: "pending-transfer" });
		f.seal();
		await expect(f.execute()).rejects.toThrow(/custody transfer/);
		expect(f.runtime.run).not.toHaveBeenCalled();
		expect(f.runtime.call).not.toHaveBeenCalled();
		expect(existsSync(f.manifest.outputDirectory)).toBe(false);
	});
	test("rejects stale prepared manifest, mutable evidence, dirty historical gate credit and reserved Linux slot", async () => {
		const f = setup();
		const hash = oneironSha(readFileSync(f.manifestPath));
		f.manifest.owner = "other";
		f.seal();
		await expect(executeOneiron(f.manifestPath, f.permitPath, true, f.runtime, hash)).rejects.toThrow(
			/manifest hash/,
		);
		f.manifest.owner = "factory-owner";
		f.seal();
		writeFileSync(f.manifest.custody.path, "changed");
		expect(() => inspectOneiron(f.manifest)).toThrow(/hash changed/);
		const g = setup();
		g.manifest.stage = {
			kind: "gate",
			wrapper: g.pin("wrapper"),
			capacity: g.pin({}),
			host: "arch",
			slot: 5,
			argv: ["cargo", "test", "--lib"],
		};
		expect(() => inspectOneiron(g.manifest)).toThrow(/capacity policy/);
	});
	test("triages once, preserves receipt, reuses completed exact work and never recycles an uncertain output", async () => {
		const f = setup();
		const receipt = (await f.execute()) as OneironReceipt;
		expect(receipt.stage).toBe("triage");
		expect(receipt.productAccepted).toBe(false);
		expect(receipt.result.reviewBlockers).toEqual([]);
		expect(f.runtime.call).toHaveBeenCalledTimes(1);
		await expect(f.execute()).rejects.toThrow(/EEXIST/);
		expect(f.runtime.call).toHaveBeenCalledTimes(1);
		f.manifest.completed = f.pin(receipt);
		f.seal();
		expect(await f.execute()).toEqual({ reused: f.manifest.completed });
		expect(f.runtime.call).toHaveBeenCalledTimes(1);
	});
	test("model drift, incomplete triage and source mutation cannot produce accepted receipts", async () => {
		const f = setup();
		vi.mocked(f.runtime.call).mockResolvedValueOnce({ model: "other", text: "{}" });
		await expect(f.execute()).rejects.toThrow(/model identity/);
		expect(existsSync(join(f.manifest.outputDirectory, "receipt.json"))).toBe(false);
		const g = setup();
		vi.mocked(g.runtime.source).mockImplementation(async () => ({
			...g.manifest.source,
			fingerprint: vi.mocked(g.runtime.call).mock.calls.length
				? `git:${"e".repeat(64)}`
				: g.manifest.source.fingerprint,
		}));
		await expect(g.execute()).rejects.toThrow(/changed source/);
	});
	test.each(["reason", "evidenceRefs", "invalid-json", "model-identity"])(
		"preserves exact triage request and raw response before %s validation fails",
		async (failure) => {
			const f = setup();
			const originalCall = vi.mocked(f.runtime.call).getMockImplementation()!;
			let rawResponse: Awaited<ReturnType<OneironRuntime["call"]>> | undefined;
			vi.mocked(f.runtime.call).mockImplementationOnce(async (system, packet, profile, requestId) => {
				const request = JSON.parse(readFileSync(join(f.manifest.outputDirectory, "triage-request.json"), "utf8"));
				expect(request).toMatchObject({
					requestId,
					system,
					packet,
					profile,
					sourceFingerprint: f.manifest.source.fingerprint,
				});
				expect(profile).toEqual({ provider: "cpa-r", model: "gpt-6-astra", effort: "low" });
				expect(system).toContain("at least 20 characters after trimming");
				expect(system).toContain("CURRENT packet.evidence[].ref");
				const response = await originalCall(system, packet, profile, requestId);
				const triage = JSON.parse(response.text) as { findings: Array<Record<string, unknown>> };
				if (failure === "reason") triage.findings[0]!.reason = "short";
				if (failure === "evidenceRefs") triage.findings[0]!.evidenceRefs = ["https://example.invalid/prior-ref"];
				rawResponse = {
					...response,
					model: failure === "model-identity" ? "other" : response.model,
					text: failure === "invalid-json" ? "{ malformed JSON\n" : JSON.stringify(triage),
					usage: { input: 111, output: 222 },
				};
				return rawResponse;
			});
			const rejection =
				failure === "reason"
					? /review:0.*reason.*20/
					: failure === "evidenceRefs"
						? /review:0.*evidenceRefs\[0\].*packet/
						: failure === "model-identity"
							? /model identity/
							: /JSON|property name/;
			await expect(f.execute()).rejects.toThrow(rejection);
			const requestBytes = readFileSync(join(f.manifest.outputDirectory, "triage-request.json"), "utf8");
			const saved = JSON.parse(readFileSync(join(f.manifest.outputDirectory, "triage-response.json"), "utf8"));
			expect(saved.response).toEqual(rawResponse);
			expect(saved.response).toMatchObject({
				responseModel: "gpt-6-astra",
				responseModelSource: "provider-response",
				responseId: "resp_fixture",
				usage: { input: 111, output: 222 },
			});
			expect(saved).toMatchObject({
				requestId: JSON.parse(requestBytes).requestId,
				requestSha256: oneironSha(requestBytes),
				manifestSha256: oneironSha(readFileSync(f.manifestPath)),
				sourceFingerprint: f.manifest.source.fingerprint,
			});
			expect(existsSync(join(f.manifest.outputDirectory, "receipt.json"))).toBe(false);
			expect(f.runtime.call).toHaveBeenCalledTimes(1);
			expect(f.runtime.run).not.toHaveBeenCalled();
			await expect(f.execute()).rejects.toThrow(/EEXIST/);
			expect(f.runtime.call).toHaveBeenCalledTimes(1);
			expect(readFileSync(join(f.manifest.outputDirectory, "triage-request.json"), "utf8")).toBe(requestBytes);
		},
	);
	test("supports exact gate, completed review acceptance, and readiness-only publication with pre/post checks", async () => {
		const f = setup();
		const triage = f.pin(await f.execute());
		const review = f.manifest.stage;
		const gateArgv = ["cargo", "test", "--lib"];
		f.manifest.outputDirectory = join(f.directory, "gate");
		f.manifest.stage = {
			kind: "gate",
			host: "arch",
			slot: 1,
			argv: gateArgv,
			wrapper: f.pin("pinned foreground wrapper"),
			capacity: f.pin({
				status: "PASS",
				sourceFingerprint: f.manifest.source.fingerprint,
				host: "arch",
				slot: 1,
				argv: gateArgv,
				expiresAt: "2099-01-01",
				duplicateFree: true,
				resourcesPassed: true,
			}),
		};
		f.seal();
		vi.mocked(f.runtime.run).mockImplementation(async (argv) => {
			if (argv[0] === "python3")
				writeFileSync(
					argv[argv.indexOf("--receipt") + 1]!,
					JSON.stringify({
						status: "COMPLETED",
						command_rc: 0,
						command: gateArgv,
						workspace_root: f.manifest.source.workspace,
						provenance: { pass: true },
					}),
				);
			return "";
		});
		const gate = f.pin(await f.execute());
		if (review.kind !== "triage") throw new Error("fixture stage");
		f.manifest.outputDirectory = join(f.directory, "acceptance");
		f.manifest.stage = { ...review, kind: "review-acceptance", triage, gates: [gate] };
		f.seal();
		expect(((await f.execute()) as OneironReceipt).result.acceptanceEligible).toBe(true);
		const title = "ONE-1914: deterministic retrieval";
		const body = "Why, what, invariants, verification and position.";
		f.manifest.outputDirectory = join(f.directory, "ready");
		f.manifest.stage = {
			kind: "publish-ready",
			repo: "org/repo",
			pr: 855,
			base: "main",
			gates: [gate],
			editorial: f.pin({ approved: true, ticketId: f.manifest.ticketId, head, title, bodySha256: oneironSha(body) }),
		};
		f.seal();
		let ready = false;
		vi.mocked(f.runtime.run).mockImplementation(async (argv) => {
			if (argv[0] === "git")
				return argv[1] === "show"
					? "Lexi <olety7@gmail.com>\nLexi <olety7@gmail.com>\nRepair retrieval invariants.\n"
					: "";
			if (argv[2] === "ready") {
				ready = true;
				return "";
			}
			return JSON.stringify({
				number: 855,
				headRefOid: head,
				headRefName: f.manifest.source.branch,
				baseRefName: "main",
				state: "OPEN",
				title,
				body,
				isDraft: !ready,
			});
		});
		const receipt = (await f.execute()) as OneironReceipt;
		expect(receipt.result.readinessOnly).toBe(true);
		expect(receipt.result.pushed).toBe(false);
		expect(receipt.result.merged).toBe(false);
		expect(vi.mocked(f.runtime.run).mock.calls.flat(2)).not.toContain("merge");
	});
	test.each(["claude-fable-5.1", "gpt-6-astra"])(
		"writer pins Astra and rejects gateway drift %s without self-report",
		async (observed) => {
			const f = setup();
			const triage = (await f.execute()) as OneironReceipt;
			const finding = (triage.result.triage as { findings: Array<{ classification: string; disposition: string }> })
				.findings[0]!;
			finding.classification = "material";
			finding.disposition = "open";
			f.manifest.outputDirectory = join(f.directory, "writer");
			f.manifest.stage = {
				kind: "writer",
				prompt: f.pin("Repair only the accepted material finding."),
				triage: f.pin(triage),
				writerProfile: writerProfileFixture(f),
			};
			f.seal();
			vi.mocked(f.runtime.run).mockResolvedValue(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						provider: "cpa-r",
						model: "gpt-6-astra",
						responseModel: observed,
						responseModelSource: "provider-response",
						responseId: "msg_factory_transport",
						stopReason: "stop",
					},
				}),
			);
			const result = (await f.execute()) as OneironReceipt;
			expect(result.result.requiresSourceRebind).toBe(true);
			expect(vi.mocked(f.runtime.run).mock.calls[0]![0]).toEqual(
				expect.arrayContaining([
					"--print",
					"--provider",
					"cpa-r",
					"--model",
					"gpt-6-astra",
					"--thinking",
					"xhigh",
					"--session-dir",
				]),
			);
			expect(result.result.writerProvenance).toMatchObject({
				requested: { model: "gpt-6-astra" },
				responseModels: [observed],
				identityAccepted: observed === "gpt-6-astra",
				upstreamIdentityAttested: false,
			});
			expect(vi.mocked(f.runtime.run).mock.calls[0]![0][0]).toBe(join(f.directory, "pinned-runtime", "node"));
			expect(vi.mocked(f.runtime.run).mock.calls[0]![2]).toMatchObject({
				PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "1",
				PRIME_AGENT_INTERNAL_OWNED_WORKER: "",
				PRIME_AGENT_INTERNAL_DAEMON_WORKER: "",
				PRIME_AGENT_INTERNAL_DAEMON_CATALOG: "",
			});
			const validate = () =>
				validateOneironWriterReceipt(f.manifest, result.result, result.manifestSha256, (pin) =>
					readFileSync(pin.path, "utf8"),
				);
			if (observed === "gpt-6-astra") expect(validate).not.toThrow();
			else expect(validate).toThrow(/unknown\/unapproved/);
			f.manifest.source.branch = "HEAD";
			expect(() => inspectOneiron(f.manifest)).toThrow(/attached/);
		},
	);
	test("collect uses pinned legacy helper through the foreground shim; completed corpus does not accept review", async () => {
		const f = setup();
		f.manifest.stage = {
			kind: "collect",
			repo: "org/repo",
			pr: 855,
			base: "main",
			helper: f.pin("legacy helper"),
			foregroundShim: f.pin("shim"),
		};
		f.seal();
		vi.mocked(f.runtime.run).mockImplementation(async (argv) => {
			const output = argv[argv.indexOf("--output-dir") + 1]!;
			mkdirSync(output);
			writeFileSync(join(output, "corpus.json"), frozenCorpus());
			return "";
		});
		const result = (await f.execute()) as OneironReceipt;
		expect(result.result.productAccepted).toBe(false);
		expect(result.result.corpus).toHaveProperty("sha256");
	});
});

describe("Oneiron real journal and foreground command-runner integration", () => {
	test("executes a mocked-model triage in a real supervised process and binds a bounded management decision", async () => {
		const f = setup();
		const cwd = f.manifest.source.workspace;
		execFileSync("git", ["init", "-q", "--initial-branch=fixture", cwd]);
		writeFileSync(join(cwd, "source"), "fixture");
		execFileSync("git", ["-C", cwd, "add", "source"]);
		execFileSync("git", [
			"-C",
			cwd,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"fixture",
		]);
		const host = { type: "local" as const, runnerRoot: join(f.directory, "attempts") };
		const actualHead = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		f.manifest.source = {
			...f.manifest.source,
			head: actualHead,
			tree: execFileSync("git", ["-C", cwd, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
			branch: "fixture",
			fingerprint: await fingerprintCommand(host, cwd),
		};
		const custody = JSON.parse(readFileSync(f.manifest.custody.path, "utf8")) as Record<string, unknown>;
		custody.sourceFingerprint = f.manifest.source.fingerprint;
		f.manifest.custody = f.pin(custody);
		if (f.manifest.stage.kind !== "triage") throw new Error("fixture");
		f.manifest.stage.corpus = f.pin(frozenCorpus(actualHead));
		f.seal();
		const report = inspectOneironCorpus(readFileSync(f.manifest.stage.corpus.path, "utf8"), {
			repo: "org/repo",
			pr: 855,
			head: actualHead,
			base: "main",
		});
		const triage = {
			version: 1,
			candidateCommit: actualHead,
			sourceFingerprint: f.manifest.source.fingerprint,
			corpusSha256: report.corpusSha256,
			findings: report.items.map((item) => ({
				id: item.id,
				bodySha256: item.bodySha256,
				classification: "informational",
				disposition: "dismissed",
				reason: "Completed review found no material defect in this specific candidate.",
				evidenceRefs: [`sha256:${report.corpusSha256}`],
			})),
		};
		const fixture = join(f.directory, "stage.mjs");
		writeFileSync(
			fixture,
			`import { executeOneiron } from ${JSON.stringify(resolve("src/factory/adapters/oneiron.ts"))}; const runtime={now:Date.now,status:async()=>({paused:false,ownerPaused:false}),source:async()=>(${JSON.stringify(f.manifest.source)}),run:async()=>{throw Error('No external effects allowed')},call:async()=>({model:'gpt-6-astra',responseModel:'gpt-6-astra',responseModelSource:'provider-response',responseId:'resp_fixture',text:${JSON.stringify(JSON.stringify(triage))}})}; await executeOneiron(${JSON.stringify(f.manifestPath)},${JSON.stringify(f.permitPath)},true,runtime);`,
		);
		const prepared = prepareOneiron(f.manifest, {
			manifestPath: f.manifestPath,
			adapterArgv: [process.execPath, "--import", resolve("../../node_modules/tsx/dist/loader.mjs"), fixture],
			permitPath: f.permitPath,
			host: "arch",
			slotId: "light",
		});
		const store = new FactoryStore(join(f.directory, "journal.db"));
		try {
			const engine = new FactoryEngine(store, new CommandAdapter({ arch: host }), {
				enabled: true,
				pauseFile: f.manifest.ownerPauseFile,
			});
			engine.applyPlan({
				version: 1,
				tickets: [{ id: f.manifest.ticketId, owner: f.manifest.owner }],
				slots: [{ id: "light", host: "arch" }],
				actions: [prepared.action!],
			});
			engine.resume();
			await engine.tick();
			await vi.waitFor(
				async () => {
					await engine.tick();
					expect(engine.status().actions[0]!.state).toBe("AWAITING_DECISION");
				},
				{ timeout: 15000, interval: 50 },
			);
			const receiptPath = join(f.manifest.outputDirectory, "receipt.json");
			const pin = { path: receiptPath, sha256: oneironSha(readFileSync(receiptPath)) };
			const binding = bindOneironEvidence(engine.status(), prepared.action!.id, f.manifest, pin);
			const packet = createManagementPacket(engine.status(), prepared.action!.id, binding.evidence);
			const decision = await proposeManagementDecision(packet, { provider: "mock", model: "mock" }, async () => ({
				model: "mock",
				text: JSON.stringify({
					version: 1,
					actionId: packet.action.id,
					attemptId: packet.attempt!.id,
					planRevision: packet.planRevision,
					decision: "accept",
					reason:
						"Structured triage covers every supplied item. This accepts the triage stage, not product publication.",
					evidenceRefs: [binding.evidence[0]!.ref],
				}),
			}));
			engine.decide(prepared.action!.id, decision.proposal.decision as "accept", {
				actor: "mock-owner",
				reason: decision.proposal.reason,
				ref: binding.evidence[0]!.ref,
			});
			expect(engine.status().actions[0]!.state).toBe("ACCEPTED");
			expect(engine.status().actions).toHaveLength(1);
			expect(store.events(0).length).toBeGreaterThan(3);
			const changed = structuredClone(f.manifest);
			changed.source.head = head;
			expect(() =>
				bindOneironEvidence(
					{ ...engine.status(), actions: [{ ...engine.status().actions[0]!, state: "AWAITING_DECISION" }] },
					prepared.action!.id,
					changed,
					pin,
				),
			).toThrow();
		} finally {
			store.close();
		}
	}, 20000);
});
