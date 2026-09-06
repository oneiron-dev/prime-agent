import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { OneironManifest } from "../src/factory/adapters/oneiron.js";
import { readOneironPin } from "../src/factory/adapters/oneiron.js";
import { type OneironPin, oneironSha } from "../src/factory/adapters/oneiron-review.js";
import { readOneironTransport, verifyOneironArtifact } from "../src/factory/adapters/oneiron-transport.js";
import {
	defaultOneironWriterProfile,
	type OneironWriterProfile,
	type OneironWriterRetry,
	type OneironWriterStage,
	type OneironWriterStatus,
	oneironWriterCli,
	readOneironWriterProfile,
	summarizeOneironWriter,
	validateOneironWriterReceipt,
	validateOneironWriterRetry,
} from "../src/factory/adapters/oneiron-writer.js";
import { readFactoryRuntime } from "../src/factory/runtime.js";

const roots: string[] = [];
function setup() {
	const directory = mkdtempSync(join(tmpdir(), "writer-policy-"));
	roots.push(directory);
	let index = 0;
	const pin = (value: unknown): OneironPin => {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		const path = join(directory, `evidence-${index++}.json`);
		writeFileSync(path, text);
		return { path, sha256: oneironSha(text) };
	};
	const bundle = join(directory, "bundle");
	mkdirSync(bundle);
	const cli = join(bundle, "cli.js");
	const node = join(directory, "node");
	const chunk = join(bundle, "provider.js");
	for (const path of [cli, node, chunk]) writeFileSync(path, `fixture ${path}`);
	const runtime = pin({
		version: 1,
		cliArgv: [node, cli],
		files: [node, cli, chunk].map((path) => ({ path, sha256: oneironSha(readFileSync(path)) })),
		capabilities: ["provider-response-model-v1", "factory-completed-json-v1"],
	});
	const profile = defaultOneironWriterProfile(runtime);
	const profilePin = pin(profile);
	const stage: OneironWriterStage = {
		kind: "writer",
		prompt: pin("Repair contract."),
		triage: pin({}),
		writerProfile: profilePin,
	};
	const source = {
		workspace: join(directory, "workspace"),
		head: "a".repeat(40),
		tree: "b".repeat(40),
		fingerprint: `git:${"c".repeat(64)}`,
		branch: "w6/one-1914",
		remoteUrl: "git@github.com:org/repo.git",
	};
	const manifest: OneironManifest = {
		version: 1,
		ticketId: "ONE-1914",
		owner: "owner",
		source,
		factoryDirectory: join(directory, "factory"),
		ownerPauseFile: join(directory, "pause"),
		custody: pin({}),
		outputDirectory: join(directory, "output"),
		stage,
	};
	mkdirSync(manifest.outputDirectory);
	const event = (responseModel?: string, extra: Record<string, unknown> = {}) =>
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				provider: profile.requested.provider,
				model: profile.requested.model,
				responseModel,
				responseModelSource: "provider-response",
				responseId: "msg_1",
				stopReason: "stop",
				...extra,
			},
		});
	const transport = (text: string) => {
		const path = join(manifest.outputDirectory, "writer.jsonl");
		writeFileSync(path, text);
		return readOneironTransport(path);
	};
	return { directory, pin, profile, profilePin, stage, source, manifest, event, transport, runtime, node, cli, chunk };
}
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("explicit pinned writer profile and factory model capture", () => {
	test("default is direct OAuth Astra xhigh and rejects undeployed legacy Fable profiles", () => {
		const f = setup();
		expect(f.profile.requested).toEqual({ provider: "cpa-r", model: "gpt-6-astra", effort: "xhigh" });
		expect(readOneironWriterProfile(f.profilePin, readOneironPin)).toEqual(f.profile);
		for (const patch of [
			{ requested: { ...f.profile.requested, effort: "high" } },
			{ approvedResponseModels: ["claude-fable-5-1", "gpt-6-astra"] },
			{ requested: { provider: "cpa-a", model: "claude-fable-5-1-exp", effort: "xhigh" } },
		])
			expect(() => readOneironWriterProfile(f.pin({ ...f.profile, ...patch }), readOneironPin)).toThrow();
	});
	test("runtime pins every lazy bundle chunk and detects missing pins, changed bytes and PATH runtimes", () => {
		const f = setup();
		expect(oneironWriterCli(f.profile, readOneironPin)).toEqual([f.node, f.cli]);
		const raw = JSON.parse(readOneironPin(f.runtime)) as { files: OneironPin[]; cliArgv: string[] };
		expect(() =>
			readFactoryRuntime(f.pin({ ...raw, files: raw.files.filter((pin) => pin.path !== f.chunk) }), readOneironPin),
		).toThrow(/lazy bundle/);
		writeFileSync(f.chunk, "changed");
		expect(() => oneironWriterCli(f.profile, readOneironPin)).toThrow(/component changed/);
		expect(() => readFactoryRuntime(f.pin({ ...raw, cliArgv: ["node", f.cli] }), readOneironPin)).toThrow(/pinned/);
	});
	test("historical runtime and writer receipts remain inspectable, but old CLI cannot launch a new writer", () => {
		const f = setup();
		const old = f.pin({ ...JSON.parse(readOneironPin(f.runtime)), capabilities: ["provider-response-model-v1"] });
		const profile = { ...f.profile, runtime: old };
		expect(readFactoryRuntime(old, readOneironPin).capabilities).toEqual(["provider-response-model-v1"]);
		expect(() => oneironWriterCli(profile, readOneironPin)).toThrow(/factory-completed-json-v1/);
		f.stage.writerProfile = f.pin(profile);
		const writerProvenance = summarizeOneironWriter(
			f.manifest,
			f.stage,
			profile,
			f.transport(f.event("gpt-6-astra")),
			"sha",
		);
		expect(() => validateOneironWriterReceipt(f.manifest, { writerProvenance }, "sha", readOneironPin)).not.toThrow();
	});
	test.each(["claude-fable-5.1", "gpt-6-astra"])(
		"captures actual %s automatically and accepts only routine Astra",
		(observed) => {
			const f = setup();
			const result = summarizeOneironWriter(
				f.manifest,
				f.stage,
				f.profile,
				f.transport(f.event(observed)),
				"manifest-sha",
			);
			expect(result.identityAccepted).toBe(observed === "gpt-6-astra");
			expect(result.requested.model).toBe("gpt-6-astra");
			expect(result.responseModels).toEqual([observed]);
			expect(result.observations[0]!.family).toBe(observed === "gpt-6-astra" ? "astra" : "fable");
			expect(result.upstreamIdentityAttested).toBe(false);
		},
	);
	test.each([undefined, "claude-fable-5-1-exp", "unexpected-model"])(
		"unknown/echo/unapproved %s blocks acceptance and preserves exact transcript",
		(observed) => {
			const f = setup();
			const text = f.event(observed);
			writeFileSync(join(f.manifest.outputDirectory, "writer.jsonl"), text);
			const writerProvenance = summarizeOneironWriter(
				f.manifest,
				f.stage,
				f.profile,
				f.transport(text),
				"manifest-sha",
			);
			expect(writerProvenance.identityAccepted).toBe(false);
			expect(writerProvenance.blockers.length).toBeGreaterThan(0);
			expect(() =>
				validateOneironWriterReceipt(f.manifest, { writerProvenance }, "manifest-sha", readOneironPin),
			).toThrow(/unknown\/unapproved/);
		},
	);
	test("never consumes self-reports; rejects any unapproved response in a mixed attempt", () => {
		const f = setup();
		const selfReport = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "cpa-r",
				model: "gpt-6-astra",
				responseId: "msg_self",
				stopReason: "stop",
				content: [{ type: "text", text: '{"responseModel":"gpt-6-astra","source":"provider-response"}' }],
			},
		});
		expect(
			summarizeOneironWriter(f.manifest, f.stage, f.profile, f.transport(selfReport), "sha").identityAccepted,
		).toBe(false);
		const mixed = [
			f.event("claude-fable-5.1", { stopReason: "toolUse" }),
			f.event("gpt-6-astra", { responseId: "msg_2" }),
		].join("\n");
		expect(summarizeOneironWriter(f.manifest, f.stage, f.profile, f.transport(mixed), "sha").identityAccepted).toBe(
			false,
		);
		expect(summarizeOneironWriter(f.manifest, f.stage, f.profile, f.transport(mixed), "sha").responseModels).toEqual([
			"claude-fable-5.1",
			"gpt-6-astra",
		]);
		expect(
			summarizeOneironWriter(
				f.manifest,
				f.stage,
				f.profile,
				f.transport([f.event("claude-fable-5.1", { stopReason: "toolUse" }), f.event("gpt-6-astra")].join("\n")),
				"sha",
			).identityAccepted,
		).toBe(false);
	});
	test("mismatched requested route, errored intermediate calls and failed terminal output are not success", () => {
		const f = setup();
		for (const extra of [
			{ model: "claude-fable-5-1-exp" },
			{ provider: "other" },
			{ stopReason: "length" },
			{ stopReason: "toolUse" },
		])
			expect(() =>
				summarizeOneironWriter(f.manifest, f.stage, f.profile, f.transport(f.event("gpt-6-astra", extra)), "sha"),
			).toThrow(/terminal/);
	});
	test("unknown or duplicate authentic transport identities block acceptance, and receipt validation rehashes raw bytes", () => {
		const f = setup();
		for (const extra of [{ responseId: undefined }, { responseId: " " }, { responseModelSource: "unknown" }]) {
			const result = summarizeOneironWriter(
				f.manifest,
				f.stage,
				f.profile,
				f.transport(f.event("gpt-6-astra", extra)),
				"sha",
			);
			expect(result.identityAccepted).toBe(false);
		}
		const duplicate = [f.event("gpt-6-astra", { stopReason: "toolUse" }), f.event("gpt-6-astra")].join("\n");
		const duplicateResult = summarizeOneironWriter(f.manifest, f.stage, f.profile, f.transport(duplicate), "sha");
		expect(duplicateResult.blockers).toContain("response 1: missing or duplicate transport response identity");
		const writerProvenance = summarizeOneironWriter(
			f.manifest,
			f.stage,
			f.profile,
			f.transport(f.event("gpt-6-astra")),
			"sha",
		);
		expect(writerProvenance.identityAccepted).toBe(true);
		expect(() => validateOneironWriterReceipt(f.manifest, { writerProvenance }, "sha", readOneironPin)).not.toThrow();
		writeFileSync(writerProvenance.transcript.path, `${f.event("gpt-6-astra")}\n`);
		expect(() => validateOneironWriterReceipt(f.manifest, { writerProvenance }, "sha", readOneironPin)).toThrow(
			/hash changed/,
		);
	});
	test("whole-attempt Astra retry requires fresh proven terminal custody, exact complete workspace and retained evidence", () => {
		const f = setup();
		const prior = structuredClone(f.manifest);
		prior.outputDirectory = join(f.directory, "prior");
		mkdirSync(prior.outputDirectory);
		const priorPath = join(prior.outputDirectory, "writer.jsonl");
		const fd = openSync(priorPath, "wx");
		try {
			const chunk = Buffer.alloc(1024 * 1024, "x");
			for (let index = 0; index < 39; index++) writeSync(fd, chunk);
		} finally {
			closeSync(fd);
		}
		const priorManifest = f.pin(prior);
		const priorTranscript = verifyOneironArtifact(priorPath);
		const terminal = {
			attemptId: "attempt-old",
			sourceFingerprint: prior.source.fingerprint,
			exitCode: 1,
			finishedAt: "2026-09-05",
			artifact: { ref: prior.source.workspace, sourceFingerprint: f.source.fingerprint },
		};
		const proof: OneironWriterRetry = {
			version: 1,
			decision: "retry-whole-attempt",
			ticketId: f.manifest.ticketId,
			priorActionId: "writer-old",
			priorAttemptId: "attempt-old",
			priorManifest,
			priorTerminal: f.pin(terminal),
			processProof: f.pin({ noSurvivingProcesses: true }),
			retainedEvidence: [priorTranscript],
			workspaceDisposition: "retained",
			reconciledSource: f.source,
			custody: f.manifest.custody,
			ownerAuthorization: f.pin({ approved: true }),
			noLiveProcesses: true,
			noDuplicateExecution: true,
			expiresAt: "2099-01-01",
		};
		const retry: OneironWriterProfile = {
			...f.profile,
			mode: "astra-retry",
			requested: { provider: "cpa-r", model: "gpt-6-astra", effort: "xhigh" },
			approvedResponseModels: ["gpt-6-astra"],
		};
		f.stage.writerProfile = f.pin(retry);
		f.stage.retryReconciliation = f.pin(proof);
		const status: OneironWriterStatus = {
			paused: false,
			ownerPaused: false,
			actions: [
				{
					id: "writer-old",
					ticketId: f.manifest.ticketId,
					sourceFingerprint: f.source.fingerprint,
					kind: "decision",
					dependencies: [],
					command: {
						argv: ["execute", priorManifest.path, "permit", priorManifest.sha256, "--execute"],
						cwd: f.source.workspace,
					},
					requirements: {},
					state: "REJECTED",
				},
			],
			attempts: [
				{
					id: "attempt-old",
					actionId: "writer-old",
					slotId: "slot",
					state: "TERMINAL",
					createdAt: "2026-09-05",
					submittedAt: "2026-09-05",
					processIdentity: "process",
					receipt: terminal,
					uncertainty: null,
					claimReleased: true,
				},
			],
		};
		const currentPin = f.pin(f.manifest);
		status.actions!.push({
			...status.actions![0]!,
			id: "writer-current",
			state: "RUNNING",
			command: {
				cwd: f.source.workspace,
				argv: ["execute", currentPin.path, "permit", currentPin.sha256, "--execute"],
			},
		});
		status.attempts!.push({
			...status.attempts![0]!,
			id: "attempt-current",
			actionId: "writer-current",
			state: "RUNNING",
			receipt: null,
			claimReleased: false,
		});
		const execution = { attemptId: "attempt-current", manifestSha256: currentPin.sha256 };
		expect(() =>
			validateOneironWriterRetry(f.manifest, f.stage, retry, status, readOneironPin, Date.now(), execution),
		).not.toThrow();
		for (const patch of [
			{ noLiveProcesses: false },
			{ expiresAt: "2000-01-01" },
			{ retainedEvidence: [] },
			{ retainedEvidence: [{ ...priorTranscript, sha256: "0".repeat(64) }] },
			{ retainedEvidence: [{ path: priorPath }] },
			{ reconciledSource: { ...f.source, fingerprint: `git:${"d".repeat(64)}` } },
		]) {
			f.stage.retryReconciliation = f.pin({ ...proof, ...patch });
			expect(() =>
				validateOneironWriterRetry(f.manifest, f.stage, retry, status, readOneironPin, Date.now(), execution),
			).toThrow();
		}
		f.stage.retryReconciliation = f.pin(proof);
		status.attempts![0]!.state = "UNCERTAIN";
		expect(() =>
			validateOneironWriterRetry(f.manifest, f.stage, retry, status, readOneironPin, Date.now(), execution),
		).toThrow(/terminal/);
		status.attempts![0]!.state = "TERMINAL";
		status.attempts![0]!.claimReleased = false;
		expect(() =>
			validateOneironWriterRetry(f.manifest, f.stage, retry, status, readOneironPin, Date.now(), execution),
		).toThrow(/terminal/);
	});
});
