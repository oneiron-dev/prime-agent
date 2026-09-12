import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import {
	createOneironRuntime,
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

const transport = vi.hoisted(() => ({ auth: vi.fn(), complete: vi.fn() }));
vi.mock("@earendil-works/pi-ai", () => ({ completeSimple: transport.complete }));
vi.mock("../src/core/auth-storage.js", () => ({ AuthStorage: { create: () => ({}) } }));
vi.mock("../src/core/model-registry.js", () => ({
	ModelRegistry: {
		create: () => ({
			getError: () => undefined,
			find: () => ({ id: "gpt-6-astra" }),
			getApiKeyAndHeaders: transport.auth,
		}),
	},
}));

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "reviewed-head-"));
	roots.push(directory);
	const workspace = join(directory, "workspace");
	mkdirSync(workspace);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "repair");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "commit.gpgsign", "false");
	git("remote", "add", "origin", "git@github.com:org/repo.git");
	const commit = (content: string) => {
		writeFileSync(join(workspace, "source.txt"), content);
		git("add", ".");
		git("commit", "-m", content);
		return git("rev-parse", "HEAD");
	};
	const reviewedHead = commit("reviewed");
	const candidateCommit = commit("candidate");
	let count = 0;
	const pin = (value: unknown): OneironPin => {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		const path = join(directory, `pin-${count++}.json`);
		writeFileSync(path, text);
		return { path, sha256: oneironSha(text) };
	};
	const corpusAt = (head: string) =>
		JSON.stringify({
			schema: "oneiron.wave6.github-bot-corpus.v1",
			repo: "org/repo",
			github_mutation: false,
			pins: { 855: head },
			prs: [
				{
					number: 855,
					head_sha: head,
					base_ref: "main",
					raw: { review_comments: [] },
					items: ["qodo-code-review[bot]", "chatgpt-codex-connector[bot]"].map((login, index) => {
						const body =
							"This exact reviewed source has a material concern that still requires a bounded repair.";
						return {
							key: `review:${index}`,
							id: index,
							sources: ["review"],
							author: { login },
							body,
							body_sha256: oneironSha(body),
							state: "COMMENTED",
							commit_id: head,
						};
					}),
				},
			],
		});
	const corpus = pin(corpusAt(reviewedHead));
	const runtime = createOneironRuntime();
	const release = pin({ released: true });
	const manifest: OneironManifest = {
		version: 1,
		ticketId: "ONE-1914",
		owner: "fixture",
		source: {
			workspace,
			head: candidateCommit,
			tree: git("rev-parse", "HEAD^{tree}"),
			branch: "repair",
			remoteUrl: git("remote", "get-url", "origin"),
			fingerprint: "",
		},
		factoryDirectory: join(directory, "factory"),
		ownerPauseFile: join(directory, "PAUSE"),
		custody: release,
		outputDirectory: join(directory, "output"),
		stage: {
			kind: "triage",
			repo: "org/repo",
			pr: 855,
			base: "main",
			corpus,
			reviewedHead,
			priorFindings: pin([]),
			evidence: [],
		},
	};
	manifest.source = await runtime.source(manifest);
	manifest.custody = pin({
		version: 1,
		state: "transferred",
		ticketId: manifest.ticketId,
		owner: manifest.owner,
		sourceFingerprint: manifest.source.fingerprint,
		expiresAt: "2099-01-01",
		priorOwners: [{ id: "prior", release }],
		activeOwners: [manifest.owner],
		liveProcesses: [],
		duplicateAuthorityDisabled: true,
		sharedGitClear: true,
	});
	const runtimeDir = join(directory, "runtime");
	mkdirSync(runtimeDir);
	const node = join(runtimeDir, "node");
	const cli = join(runtimeDir, "cli.js");
	writeFileSync(node, "fixture");
	writeFileSync(cli, "fixture");
	manifest.factoryRuntime = pin({
		version: 1,
		cliArgv: [node, cli],
		files: [node, cli].map((path) => ({ path, sha256: oneironSha(readFileSync(path)) })),
		capabilities: ["provider-response-model-v1", "factory-completed-json-v1", "oneiron-triage-reviewed-head-v1"],
	});
	runtime.status = vi.fn(async () => ({ paused: false, ownerPaused: false }));
	runtime.call = vi.fn(async (_system, packet) => {
		const data = JSON.parse(packet);
		return {
			model: "gpt-6-astra",
			responseModel: "gpt-6-astra",
			responseModelSource: "provider-response" as const,
			responseId: "resp_fixture",
			text: JSON.stringify({
				version: 1,
				candidateCommit: data.candidateCommit,
				reviewedHead: data.reviewedHead,
				sourceFingerprint: data.sourceFingerprint,
				corpusSha256: data.corpusSha256,
				findings: [...data.items, ...data.prior].map((item: { id: string; bodySha256: string }) => ({
					id: item.id,
					bodySha256: item.bodySha256,
					classification: "material",
					disposition: "open",
					reason: "The supplied concern remains an unresolved repair obligation.",
					evidenceRefs: [data.evidence[0].ref],
				})),
			}),
		};
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
	seal();
	return {
		directory,
		manifest,
		manifestPath,
		permitPath,
		runtime,
		pin,
		seal,
		git,
		commit,
		corpusAt,
		reviewedHead,
		candidateCommit,
		execute: () => executeOneiron(manifestPath, permitPath, true, runtime),
	};
}

test("native Git ancestor corpus triages the current candidate without crediting historical reviewers", async () => {
	const f = await fixture();
	const stage = f.manifest.stage;
	if (stage.kind !== "triage") throw new Error("fixture");
	const bytes = readFileSync(stage.corpus.path, "utf8");
	const original = inspectOneironCorpus(bytes, {
		repo: stage.repo,
		pr: stage.pr,
		base: stage.base,
		head: f.reviewedHead,
	});
	const receipt = (await f.execute()) as OneironReceipt;
	expect(receipt.input).toEqual(f.manifest.source);
	expect(receipt.output).toEqual(f.manifest.source);
	expect(receipt.result.triage).toMatchObject({
		candidateCommit: f.candidateCommit,
		reviewedHead: f.reviewedHead,
		sourceFingerprint: f.manifest.source.fingerprint,
		corpusSha256: stage.corpus.sha256,
	});
	const packet = JSON.parse(vi.mocked(f.runtime.call).mock.calls[0]![1]);
	expect(packet.items).toEqual(original.items);
	expect(packet.completedReviewers).toEqual([]);
	expect(packet.historicalCompletedReviewers).toEqual(["codex", "qodo"]);
	expect(receipt.result.reviewBlockers).toEqual(
		expect.arrayContaining([
			"qodo: no substantive completed exact-commit review",
			"codex: no substantive completed exact-commit review",
		]),
	);
	const lineage = receipt.result.lineage as OneironPin;
	const proof = readFileSync(lineage.path, "utf8");
	expect(oneironSha(proof)).toBe(lineage.sha256);
	expect(JSON.parse(proof)).toMatchObject({
		candidateCommit: f.candidateCommit,
		reviewedHead: f.reviewedHead,
		source: f.manifest.source,
		relation: "ancestor",
	});
	expect(packet.lineage).toEqual(lineage);
	expect(packet.evidence.map((item: { ref: string }) => item.ref)).not.toContain(`sha256:${lineage.sha256}`);
	expect(readFileSync(stage.corpus.path, "utf8")).toBe(bytes);
	expect(inspectOneiron(f.manifest).review?.completedReviewers).toEqual([]);
});

test.each([false, true])("native exact-current triage keeps the natural default (explicit=%s)", async (explicit) => {
	const f = await fixture();
	const stage = f.manifest.stage;
	if (stage.kind !== "triage") throw new Error("fixture");
	stage.corpus = f.pin(f.corpusAt(f.candidateCommit));
	if (explicit) stage.reviewedHead = f.candidateCommit;
	else delete stage.reviewedHead;
	const oldRuntime = JSON.parse(readFileSync(f.manifest.factoryRuntime!.path, "utf8"));
	oldRuntime.capabilities = ["provider-response-model-v1"];
	f.manifest.factoryRuntime = f.pin(oldRuntime);
	f.seal();
	const receipt = (await f.execute()) as OneironReceipt;
	expect(receipt.result.triage).toMatchObject({ candidateCommit: f.candidateCommit, reviewedHead: f.candidateCommit });
	const packet = JSON.parse(vi.mocked(f.runtime.call).mock.calls[0]![1]);
	expect(packet.completedReviewers).toEqual(["codex", "qodo"]);
	expect(packet.historicalCompletedReviewers).toEqual([]);
	expect(JSON.parse(readFileSync((receipt.result.lineage as OneironPin).path, "utf8")).relation).toBe("same");
});

test("ancestor admission alone requires the new capability; historical inspection/reuse stays readable", async () => {
	const f = await fixture();
	const receipt = (await f.execute()) as OneironReceipt;
	const oldRuntime = JSON.parse(readFileSync(f.manifest.factoryRuntime!.path, "utf8"));
	oldRuntime.capabilities = ["provider-response-model-v1"];
	f.manifest.factoryRuntime = f.pin(oldRuntime);
	f.manifest.completed = f.pin(receipt);
	f.seal();
	expect(inspectOneiron(f.manifest).reuse).toEqual(f.manifest.completed);
	expect(await f.execute()).toEqual({ reused: f.manifest.completed });
	delete f.manifest.completed;
	f.manifest.outputDirectory = join(f.directory, "unsupported");
	f.seal();
	await expect(f.execute()).rejects.toThrow(/capability oneiron-triage-reviewed-head-v1/);
	expect(f.runtime.call).toHaveBeenCalledTimes(1);
	expect(existsSync(f.manifest.outputDirectory)).toBe(false);
});

test.each(["unrelated", "reversed", "missing", "tree-object", "graft", "replace-ref"])(
	"actual Git rejects %s lineage before model inference",
	async (kind) => {
		const f = await fixture();
		const stage = f.manifest.stage;
		if (stage.kind !== "triage") throw new Error("fixture");
		let reviewed = f.reviewedHead;
		if (kind === "missing") reviewed = "f".repeat(40);
		if (kind === "tree-object") reviewed = f.git("rev-parse", `${f.reviewedHead}^{tree}`);
		if (kind === "unrelated" || kind === "replace-ref") {
			f.git("checkout", "--orphan", "unrelated");
			reviewed = f.commit("unrelated");
			f.git("checkout", "repair");
			if (kind === "replace-ref") f.git("replace", reviewed, f.reviewedHead);
		}
		if (kind === "reversed") {
			reviewed = f.candidateCommit;
			f.git("checkout", "--detach", f.reviewedHead);
			f.manifest.source = await f.runtime.source(f.manifest);
			const custody = JSON.parse(readFileSync(f.manifest.custody.path, "utf8"));
			custody.sourceFingerprint = f.manifest.source.fingerprint;
			f.manifest.custody = f.pin(custody);
		}
		if (kind === "graft")
			writeFileSync(
				join(f.manifest.source.workspace, ".git/info/grafts"),
				`${f.candidateCommit} ${f.reviewedHead}\n`,
			);
		stage.reviewedHead = reviewed;
		stage.corpus = f.pin(f.corpusAt(reviewed));
		f.seal();
		await expect(f.execute()).rejects.toThrow(/ancestor|Foreground command exited|grafts/);
		expect(f.runtime.call).not.toHaveBeenCalled();
		expect(existsSync(join(f.manifest.outputDirectory, "receipt.json"))).toBe(false);
	},
);

test.each(["pin", "head", "base", "repo", "body", "reviewedHead"])(
	"rejects %s corpus/manifest mismatch before model",
	async (kind) => {
		const f = await fixture();
		const stage = f.manifest.stage;
		if (stage.kind !== "triage") throw new Error("fixture");
		const corpus = JSON.parse(readFileSync(stage.corpus.path, "utf8"));
		if (kind === "pin") corpus.pins[855] = f.candidateCommit;
		if (kind === "head") corpus.prs[0].head_sha = f.candidateCommit;
		if (kind === "base") corpus.prs[0].base_ref = "other";
		if (kind === "repo") corpus.repo = "other/repo";
		if (kind === "body") corpus.prs[0].items[0].body = "modified without new hash";
		if (kind === "reviewedHead") stage.reviewedHead = "--all";
		stage.corpus = f.pin(corpus);
		f.seal();
		await expect(f.execute()).rejects.toThrow(/mismatch|integrity|full reviewedHead/);
		expect(f.runtime.call).not.toHaveBeenCalled();
		expect(existsSync(f.manifest.outputDirectory)).toBe(false);
	},
);

test.each(["source", "branch", "remote", "head", "tree", "fingerprint", "pause", "custody"])(
	"fails closed on %s drift after lineage and before model",
	async (kind) => {
		const f = await fixture();
		const nativeRun = f.runtime.run;
		f.runtime.run = async (argv, cwd, env) => {
			const output = await nativeRun(argv, cwd, env);
			if (argv.includes("merge-base")) {
				if (kind === "source") writeFileSync(join(cwd, "source.txt"), "dirty candidate");
				if (kind === "branch") f.git("checkout", "-b", "different");
				if (kind === "remote") f.git("remote", "set-url", "origin", "https://example.invalid/other.git");
				if (kind === "head") f.commit("new candidate");
				if (kind === "tree" || kind === "fingerprint") {
					const source = f.runtime.source;
					f.runtime.source = async (m) => ({
						...(await source(m)),
						[kind]: kind === "tree" ? "a".repeat(40) : `git:${"a".repeat(64)}`,
					});
				}
				if (kind === "pause") writeFileSync(f.manifest.ownerPauseFile, "paused");
				if (kind === "custody") writeFileSync(f.manifest.custody.path, "changed");
			}
			return output;
		};
		await expect(f.execute()).rejects.toThrow(/CAS|pause|hash changed/);
		expect(f.runtime.call).not.toHaveBeenCalled();
		expect(existsSync(join(f.manifest.outputDirectory, "receipt.json"))).toBe(false);
	},
);

test.each(["swap", "candidate", "reviewedHead", "missing-reviewedHead", "fingerprint", "corpus", "raw-invalid"])(
	"preserves the raw %s response and rejects mismatched triage identity",
	async (kind) => {
		const f = await fixture();
		const call = f.runtime.call;
		let raw = "";
		f.runtime.call = vi.fn<OneironRuntime["call"]>(async (...args) => {
			const response = await call(...args);
			const data = JSON.parse(response.text);
			if (kind === "swap") [data.candidateCommit, data.reviewedHead] = [data.reviewedHead, data.candidateCommit];
			if (kind === "candidate") data.candidateCommit = f.reviewedHead;
			if (kind === "reviewedHead") data.reviewedHead = f.candidateCommit;
			if (kind === "missing-reviewedHead") delete data.reviewedHead;
			if (kind === "fingerprint") data.sourceFingerprint = `git:${"a".repeat(64)}`;
			if (kind === "corpus") data.corpusSha256 = "a".repeat(64);
			raw = kind === "raw-invalid" ? "{invalid triage\n" : JSON.stringify(data);
			return { ...response, text: raw };
		});
		await expect(f.execute()).rejects.toThrow(/identity mismatch|JSON|property name/);
		const saved = JSON.parse(readFileSync(join(f.manifest.outputDirectory, "triage-response.json"), "utf8"));
		expect(saved.response.text).toBe(raw);
		expect(saved).toMatchObject({ candidateCommit: f.candidateCommit, reviewedHead: f.reviewedHead });
		expect(existsSync(join(f.manifest.outputDirectory, "receipt.json"))).toBe(false);
	},
);

test("historical completion cannot satisfy current review acceptance, even with current full-source green gates", async () => {
	const f = await fixture();
	const stage = f.manifest.stage;
	if (stage.kind !== "triage") throw new Error("fixture");
	const receipt = (await f.execute()) as OneironReceipt;
	const proof = f.pin({
		fixtureOnly: true,
		evidenceKind: "UNIT MOCK",
		status: "COMPLETED",
		command_rc: 0,
		workspace_root: f.manifest.source.workspace,
		command: ["cargo", "test", "fixture"],
		provenance: { pass: true },
	});
	const gateManifest: OneironManifest = {
		...f.manifest,
		outputDirectory: join(f.directory, "unit-mock-gate"),
		stage: {
			kind: "gate",
			wrapper: f.pin({ evidenceKind: "UNIT MOCK wrapper; never executed" }),
			capacity: f.pin({ evidenceKind: "UNIT MOCK capacity" }),
			host: "arch",
			slot: 1,
			argv: ["cargo", "test", "fixture"],
		},
	};
	const gateManifestPin = f.pin(gateManifest);
	const gateAction = prepareOneiron(gateManifest, {
		manifestPath: gateManifestPin.path,
		permitPath: join(f.directory, "unit-mock-gate-permit.json"),
		adapterArgv: [
			process.execPath,
			fileURLToPath(new URL("../src/factory/adapters/oneiron-entry.ts", import.meta.url)),
		],
		host: "local",
		slotId: "unit-mock-gate-slot",
	}).action!;
	vi.mocked(f.runtime.status).mockResolvedValue({
		paused: false,
		ownerPaused: false,
		actions: [{ ...gateAction, description: "UNIT MOCK historical Cargo action; never executed", state: "ACCEPTED" }],
	});
	const gate = f.pin({
		...receipt,
		stage: "gate",
		manifestSha256: gateManifestPin.sha256,
		stageSha256: oneironSha(JSON.stringify(gateManifest.stage)),
		result: { commandRc: 0, provenancePassed: true, proof },
	});
	f.manifest.outputDirectory = join(f.directory, "acceptance");
	// Excess JSON fields must not opt acceptance into the triage-only extension.
	f.manifest.stage = { ...stage, kind: "review-acceptance", triage: f.pin(receipt), gates: [gate] };
	f.seal();
	await expect(f.execute()).rejects.toThrow(/Only triage/);
	const { reviewedHead: _historical, ...exactStage } = stage;
	f.manifest.stage = { ...exactStage, kind: "review-acceptance", triage: f.pin(receipt), gates: [gate] };
	f.seal();
	await expect(f.execute()).rejects.toThrow(/Corpus pin mismatch/);
	// Even a newly collected exact-current corpus cannot launder the old-corpus triage result.
	f.manifest.stage.corpus = f.pin(f.corpusAt(f.candidateCommit));
	f.seal();
	await expect(f.execute()).rejects.toThrow(/Triage source\/corpus identity mismatch/);
	expect(f.runtime.call).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
	"writer keeps full-source guard with new ancestor triage (old-source=%s)",
	async (oldSource) => {
		const f = await fixture();
		const receipt = (await f.execute()) as OneironReceipt;
		if (oldSource) {
			f.commit("later candidate");
			f.manifest.source = await f.runtime.source(f.manifest);
			const custody = JSON.parse(readFileSync(f.manifest.custody.path, "utf8"));
			custody.sourceFingerprint = f.manifest.source.fingerprint;
			f.manifest.custody = f.pin(custody);
		}
		f.manifest.outputDirectory = join(f.directory, "writer");
		f.manifest.stage = {
			kind: "writer",
			triage: f.pin(receipt),
			prompt: f.pin("Repair only the open material concerns at the current source."),
			writerProfile: f.pin(defaultOneironWriterProfile(f.manifest.factoryRuntime!)),
		};
		f.seal();
		f.runtime.runWriter = vi.fn(async (_argv, _cwd, path) => {
			writeFileSync(
				path,
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						provider: "cpa-r",
						model: "gpt-6-astra",
						responseModel: "gpt-6-astra",
						responseModelSource: "provider-response",
						responseId: "resp_writer",
						stopReason: "stop",
					},
				}),
				{ flag: "wx" },
			);
		});
		if (oldSource) {
			await expect(f.execute()).rejects.toThrow(/Repair writer requires accepted remaining material triage/);
			expect(f.runtime.runWriter).not.toHaveBeenCalled();
		} else {
			const writer = (await f.execute()) as OneironReceipt;
			expect(writer.input).toEqual(f.manifest.source);
			expect(writer.result.requiresSourceRebind).toBe(true);
			expect(f.runtime.runWriter).toHaveBeenCalledTimes(1);
			expect(vi.mocked(f.runtime.runWriter).mock.calls[0]![0]).toEqual(
				expect.arrayContaining(["--json-event-profile", "factory-completed", "--thinking", "xhigh"]),
			);
			expect(() =>
				validateOneironWriterReceipt(f.manifest, writer.result, writer.manifestSha256, (pin) =>
					readFileSync(pin.path, "utf8"),
				),
			).not.toThrow();
		}
	},
);

async function nativeFixture() {
	const f = await fixture();
	mkdirSync(f.manifest.factoryDirectory);
	const cli = join(f.directory, "runtime", "cli.js");
	writeFileSync(cli, `console.log(JSON.stringify({paused:false,ownerPaused:false}));`);
	const files = [
		process.execPath,
		cli,
		fileURLToPath(new URL("../src/factory/adapters/oneiron.ts", import.meta.url)),
		process.argv[1]!,
	];
	f.manifest.factoryRuntime = f.pin({
		version: 1,
		cliArgv: [process.execPath, cli],
		files: files.map((path) => ({ path, sha256: oneironSha(readFileSync(path)) })),
		capabilities: ["provider-response-model-v1", "oneiron-triage-reviewed-head-v1"],
	});
	f.seal();
	transport.auth.mockReset();
	transport.complete.mockReset();
	transport.auth.mockResolvedValue({ ok: true, apiKey: "fixture-not-a-secret" });
	transport.complete.mockImplementation(async (_model, context) => {
		const response = await f.runtime.call(
			context.systemPrompt,
			context.messages[0].content,
			{ provider: "cpa-r", model: "gpt-6-astra", effort: "low" },
			"fixture-provider",
		);
		return {
			...response,
			content: [{ type: "text", text: response.text }],
			stopReason: "stop",
			usage: { input: 1, output: 1 },
		};
	});
	return { ...f, nativeExecute: () => executeOneiron(f.manifestPath, f.permitPath, true) };
}

test("default native execution uses real Git/status and retains automatic transport metadata", async () => {
	const f = await nativeFixture();
	const receipt = (await f.nativeExecute()) as OneironReceipt;
	expect(receipt.output).toEqual(f.manifest.source);
	expect(receipt.result.servingIdentity).toMatchObject({
		responseModel: "gpt-6-astra",
		source: "provider-response",
		responseId: "resp_fixture",
	});
	expect(receipt.result.modelIdentitySource).toBe("sdk");
	expect(receipt.result.effort).toBe("low");
	expect(transport.complete).toHaveBeenCalledTimes(1);
	expect(transport.complete.mock.calls[0]![2]).toMatchObject({ reasoning: "low", maxTokens: 2000, maxRetries: 0 });
}, 15000);

test.each([
	"source",
	"head",
	"branch",
	"remote",
	"pause",
	"factory-pause",
	"custody",
	"corpus",
	"manifest",
	"permit",
	"lineage",
	"graft",
])(
	"native post-credential seam rejects %s drift before calling provider",
	async (kind) => {
		const f = await nativeFixture();
		transport.auth.mockImplementation(async () => {
			await Promise.resolve();
			if (kind === "source") writeFileSync(join(f.manifest.source.workspace, "source.txt"), "credential-time drift");
			if (kind === "head") f.commit("credential-time commit");
			if (kind === "branch") f.git("checkout", "-b", "credential-branch");
			if (kind === "remote") f.git("remote", "set-url", "origin", "https://example.invalid/changed");
			if (kind === "pause") writeFileSync(f.manifest.ownerPauseFile, "pause");
			if (kind === "factory-pause") {
				// The status input changes, not the pinned executable bytes.
				const data = join(f.directory, "factory-state.json");
				writeFileSync(data, JSON.stringify({ paused: true, ownerPaused: false }));
			}
			if (kind === "custody") writeFileSync(f.manifest.custody.path, "changed");
			if (kind === "corpus" && f.manifest.stage.kind === "triage")
				writeFileSync(f.manifest.stage.corpus.path, "changed");
			if (kind === "manifest") writeFileSync(f.manifestPath, "changed");
			if (kind === "permit") writeFileSync(f.permitPath, "changed");
			if (kind === "lineage")
				writeFileSync(
					join(f.manifest.outputDirectory, "triage-lineage.json"),
					JSON.stringify({
						relation: "ancestor",
						candidateCommit: f.reviewedHead,
						reviewedHead: f.candidateCommit,
						ancestry: true,
					}),
				);
			if (kind === "graft")
				writeFileSync(
					join(f.manifest.source.workspace, ".git/info/grafts"),
					`${f.candidateCommit} ${f.reviewedHead}\n`,
				);
			return { ok: true, apiKey: "fixture-not-a-secret" };
		});
		if (kind === "factory-pause") {
			const state = join(f.directory, "factory-state.json");
			writeFileSync(state, JSON.stringify({ paused: false, ownerPaused: false }));
			const cli = join(f.directory, "runtime", "cli.js");
			writeFileSync(cli, `console.log(require("node:fs").readFileSync(${JSON.stringify(state)}, "utf8"));`);
			const pin = JSON.parse(readFileSync(f.manifest.factoryRuntime!.path, "utf8"));
			pin.files = pin.files.map((entry: OneironPin) => ({
				path: entry.path,
				sha256: oneironSha(readFileSync(entry.path)),
			}));
			f.manifest.factoryRuntime = f.pin(pin);
			f.seal();
		}
		await expect(f.nativeExecute()).rejects.toThrow(/CAS|pause|hash changed|authorization changed|grafts/);
		expect(transport.complete).not.toHaveBeenCalled();
		expect(existsSync(join(f.manifest.outputDirectory, "triage-response.json"))).toBe(false);
		expect(existsSync(join(f.manifest.outputDirectory, "triage-request.json"))).toBe(true);
		expect(existsSync(join(f.manifest.outputDirectory, "receipt.json"))).toBe(false);
	},
	15000,
);

test("carried operator and cross-repo obligations stay intact; lineage is not repair evidence", async () => {
	const f = await fixture();
	const stage = f.manifest.stage;
	if (stage.kind !== "triage") throw new Error("fixture");
	const prior = [
		{
			id: "operator:failed-native-gate",
			bodySha256: oneironSha("real native failure fixture"),
			classification: "material",
			disposition: "open",
			reason: "Native gate failure requires a separate prerequisite repair.",
			evidenceRefs: ["sha256:historical"],
		},
		{
			id: "other/repo#45:original-bot:1",
			bodySha256: oneironSha("old debt"),
			classification: "debt",
			disposition: "open",
			reason: "Prior cross-repository debt must remain in the ledger.",
			evidenceRefs: ["sha256:old"],
		},
	];
	stage.priorFindings = f.pin(prior);
	stage.evidence = [f.pin("Current native gate failed; this is operator evidence, not a bot item.")];
	f.seal();
	const receipt = (await f.execute()) as OneironReceipt;
	const packet = JSON.parse(vi.mocked(f.runtime.call).mock.calls[0]![1]);
	expect(packet.prior).toEqual(prior);
	expect(packet.items).toHaveLength(2);
	expect((receipt.result.triage as { findings: { id: string }[] }).findings.map((item) => item.id)).toEqual(
		expect.arrayContaining(prior.map((item) => item.id)),
	);
	f.manifest.outputDirectory = join(f.directory, "malicious-response");
	f.seal();
	const call = f.runtime.call;
	f.runtime.call = async (...args) => {
		const response = await call(...args);
		const data = JSON.parse(response.text);
		const p = JSON.parse(args[1]);
		data.findings[0] = {
			...data.findings[0],
			disposition: "fixed",
			resolvedAtCommit: f.candidateCommit,
			evidenceRefs: [`sha256:${p.lineage.sha256}`],
		};
		return { ...response, text: JSON.stringify(data) };
	};
	await expect(f.execute()).rejects.toThrow(/evidenceRefs.*not a current/);
});

test("native admission rejects a prior lineage pin as repair evidence before provider inference", async () => {
	const f = await nativeFixture();
	const first = (await f.nativeExecute()) as OneironReceipt;
	const stage = f.manifest.stage;
	if (stage.kind !== "triage") throw new Error("fixture");
	stage.evidence = [first.result.lineage as OneironPin];
	f.manifest.outputDirectory = join(f.directory, "carried-lineage");
	f.seal();
	transport.auth.mockClear();
	transport.complete.mockClear();
	transport.complete.mockImplementation(async (_model, context) => {
		const packet = JSON.parse(context.messages[0].content);
		const response = await f.runtime.call(
			context.systemPrompt,
			context.messages[0].content,
			{ provider: "cpa-r", model: "gpt-6-astra", effort: "low" },
			"fixture-provider",
		);
		const triage = JSON.parse(response.text);
		triage.findings = triage.findings.map((finding: Record<string, unknown>) => ({
			...finding,
			disposition: "fixed",
			resolvedAtCommit: packet.candidateCommit,
			evidenceRefs: [`sha256:${packet.lineage.sha256}`],
		}));
		return { ...response, content: [{ type: "text", text: JSON.stringify(triage) }], stopReason: "stop", usage: {} };
	});
	await expect(f.nativeExecute()).rejects.toThrow(/lineage.*identity-only/);
	expect(transport.auth).not.toHaveBeenCalled();
	expect(transport.complete).not.toHaveBeenCalled();
	expect(existsSync(join(f.manifest.outputDirectory, "receipt.json"))).toBe(false);
}, 15000);
