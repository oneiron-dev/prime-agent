import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashFactoryRuntimeFile, readFactoryRuntime } from "../runtime.js";
import type { ActionRecord, AttemptRecord } from "../types.js";
import type { OneironManifest, OneironSource } from "./oneiron.js";
import { type OneironPin, oneironSha } from "./oneiron-review.js";

export interface OneironWriterProfile {
	version: 1;
	mode: "primary" | "astra-retry";
	requested: { provider: "cpa-r"; model: "gpt-6-astra"; effort: "xhigh" };
	/** Qualified model family reported by the gateway response, not cryptographic upstream identity. */
	approvedResponseModels: string[];
	runtime: OneironPin;
}
export interface OneironWriterStage {
	kind: "writer";
	prompt: OneironPin;
	triage: OneironPin;
	writerProfile: OneironPin;
	retryReconciliation?: OneironPin;
}
export interface OneironWriterStatus {
	paused: boolean;
	ownerPaused: boolean;
	actions?: ActionRecord[];
	attempts?: AttemptRecord[];
}
export interface OneironWriterRetry {
	version: 1;
	decision: "retry-whole-attempt";
	ticketId: string;
	priorActionId: string;
	priorAttemptId: string;
	priorManifest: OneironPin;
	priorTerminal: OneironPin;
	processProof: OneironPin;
	retainedEvidence: OneironPin[];
	workspaceDisposition: "retained" | "restored";
	reconciledSource: OneironSource;
	custody: OneironPin;
	ownerAuthorization: OneironPin;
	noLiveProcesses: true;
	noDuplicateExecution: true;
	expiresAt: string;
}
export interface OneironWriterProvenance {
	version: 1;
	requested: OneironWriterProfile["requested"];
	profile: OneironPin;
	runtime: OneironPin;
	transcript: OneironPin;
	manifestSha256: string;
	sourceFingerprint: string;
	sessionDirectory: string;
	identityAccepted: boolean;
	responseModels: string[];
	observations: Array<{
		responseId: string | null;
		requestedSelector: string;
		responseModel: string | null;
		source: "provider-response" | "unknown";
		family: "fable" | "astra" | "unknown";
	}>;
	blockers: string[];
	upstreamIdentityAttested: false;
}
type ReadPin = (pin: OneironPin) => string;
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const RESPONSE_MODELS = ["gpt-6-astra"];
export function defaultOneironWriterProfile(runtime: OneironPin): OneironWriterProfile {
	return {
		version: 1,
		mode: "primary",
		requested: { provider: "cpa-r", model: "gpt-6-astra", effort: "xhigh" },
		approvedResponseModels: [...RESPONSE_MODELS],
		runtime,
	};
}
export function readOneironWriterProfile(pin: OneironPin, read: ReadPin): OneironWriterProfile {
	const profile = JSON.parse(read(pin)) as OneironWriterProfile;
	check(
		profile.version === 1 && profile.requested?.effort === "xhigh",
		"Writer requires an explicit pinned xhigh profile",
	);
	check(
		["primary", "astra-retry"].includes(profile.mode) &&
			profile.requested.provider === "cpa-r" &&
			profile.requested.model === "gpt-6-astra",
		"Routine writer requires direct cpa-r/gpt-6-astra primary or explicit reconciled Astra retry",
	);
	const approved = RESPONSE_MODELS;
	check(
		Array.isArray(profile.approvedResponseModels) &&
			profile.approvedResponseModels.length === approved.length &&
			new Set(profile.approvedResponseModels).size === approved.length &&
			profile.approvedResponseModels.every((name) => approved.includes(name)),
		"Writer response-model policy contains unapproved or missing identities",
	);
	return profile;
}
export function oneironWriterCli(profile: OneironWriterProfile, read: ReadPin): string[] {
	return [...readFactoryRuntime(profile.runtime, read).cliArgv];
}
function sameSource(a: OneironSource, b: OneironSource): boolean {
	return ["workspace", "head", "tree", "branch", "remoteUrl", "fingerprint"].every(
		(key) => a[key as keyof OneironSource] === b[key as keyof OneironSource],
	);
}

/** Explicit retry of a whole reconciled attempt. Never an automatic fallback or missing-PID retry. */
export function validateOneironWriterRetry(
	m: OneironManifest,
	stage: OneironWriterStage,
	profile: OneironWriterProfile,
	status: OneironWriterStatus,
	read: ReadPin,
	now: number,
	execution?: { attemptId: string | undefined; manifestSha256: string },
): void {
	if (profile.mode === "primary") {
		check(!stage.retryReconciliation, "Primary writer cannot disguise a retry grant");
		return;
	}
	check(stage.retryReconciliation, "Astra retry requires explicit process/workspace/evidence reconciliation");
	const proof = JSON.parse(read(stage.retryReconciliation)) as OneironWriterRetry;
	check(
		proof.version === 1 &&
			proof.decision === "retry-whole-attempt" &&
			proof.ticketId === m.ticketId &&
			sameSource(proof.reconciledSource, m.source) &&
			proof.custody.path === m.custody.path &&
			proof.custody.sha256 === m.custody.sha256 &&
			proof.noLiveProcesses === true &&
			proof.noDuplicateExecution === true &&
			["retained", "restored"].includes(proof.workspaceDisposition) &&
			Date.parse(proof.expiresAt) > now,
		"Writer retry reconciliation is stale or source/custody mismatched",
	);
	const action = status.actions?.find((item) => item.id === proof.priorActionId);
	const attempts = status.attempts?.filter((item) => item.actionId === proof.priorActionId);
	const attempt = attempts?.at(-1);
	check(
		action?.ticketId === m.ticketId &&
			attempt?.id === proof.priorAttemptId &&
			attempt.state === "TERMINAL" &&
			attempt.claimReleased &&
			attempt.receipt &&
			(attempt.receipt.exitCode !== 0 || action.state === "REJECTED"),
		"Astra retry requires the current prior unsuccessful terminal attempt with released claims; uncertain or accepted work cannot replay",
	);
	const prior = JSON.parse(read(proof.priorManifest)) as OneironManifest;
	const terminal = JSON.parse(read(proof.priorTerminal)) as AttemptRecord["receipt"];
	check(
		prior.stage.kind === "writer" &&
			prior.ticketId === m.ticketId &&
			proof.priorManifest.sha256 === action.command.argv.at(-2) &&
			action.sourceFingerprint === prior.source.fingerprint &&
			JSON.stringify(terminal) === JSON.stringify(attempt.receipt) &&
			prior.outputDirectory !== m.outputDirectory,
		"Astra retry must preserve the exact prior manifest/terminal and use a fresh output/session directory",
	);
	const previousProfile = readOneironWriterProfile(prior.stage.writerProfile, read);
	check(
		previousProfile.mode === "primary",
		"Only one explicit reconciled retry of a primary Astra attempt is allowed",
	);
	const current = status.attempts?.find((item) => item.id === execution?.attemptId);
	const currentAction = status.actions?.find((item) => item.id === current?.actionId);
	check(
		current &&
			current.id !== attempt.id &&
			["SUBMITTED", "RUNNING"].includes(current.state) &&
			!current.claimReleased &&
			currentAction?.ticketId === m.ticketId &&
			currentAction.sourceFingerprint === m.source.fingerprint &&
			currentAction.command.cwd === m.source.workspace &&
			currentAction.command.argv.at(-5) === "execute" &&
			currentAction.command.argv.at(-1) === "--execute" &&
			currentAction.command.argv.at(-2) === execution?.manifestSha256 &&
			status.attempts?.filter((item) => item.actionId === currentAction.id).at(-1)?.id === current.id,
		"Astra retry needs its own unique runner-bound executing attempt",
	);
	const executingManifest = JSON.parse(
		read({ path: currentAction.command.argv.at(-4)!, sha256: execution!.manifestSha256 }),
	) as OneironManifest;
	check(
		JSON.stringify(executingManifest) === JSON.stringify(m),
		"Astra retry executing manifest/output identity mismatch",
	);
	check(
		status.attempts?.every(
			(item) =>
				item.id === current.id ||
				item.id === attempt.id ||
				item.claimReleased ||
				status.actions?.find((candidate) => candidate.id === item.actionId)?.ticketId !== m.ticketId,
		),
		"Another attempt still holds this ticket's process custody",
	);
	if (proof.workspaceDisposition === "retained")
		check(
			attempt.receipt.artifact?.sourceFingerprint === m.source.fingerprint,
			"Retained retry workspace differs from prior terminal output",
		);
	else check(sameSource(prior.source, m.source), "Restored retry requires the complete original source identity");
	check(
		Array.isArray(proof.retainedEvidence) && proof.retainedEvidence.length > 0,
		"Astra retry must retain prior product/review evidence",
	);
	for (const pin of [proof.processProof, proof.ownerAuthorization, ...proof.retainedEvidence]) read(pin);
	for (const name of ["writer.jsonl", "receipt.json"]) {
		const path = join(prior.outputDirectory, name);
		if (existsSync(path))
			check(
				proof.retainedEvidence.some((pin) => pin.path === path && pin.sha256 === hashFactoryRuntimeFile(path)),
				"Retry dropped surviving writer transcript/receipt evidence",
			);
	}
}

/** The factory reads transport-derived fields. The writer never records or reports its own model identity. */
export function summarizeOneironWriter(
	m: OneironManifest,
	stage: OneironWriterStage,
	profile: OneironWriterProfile,
	text: string,
	manifestSha256: string,
): OneironWriterProvenance {
	const messages = text
		.split("\n")
		.filter((line) => line.trim())
		.map(
			(line) =>
				JSON.parse(line) as {
					type?: string;
					message?: {
						role?: string;
						provider?: string;
						model?: string;
						responseId?: string;
						responseModel?: string;
						responseModelSource?: string;
						stopReason?: string;
					};
				},
		)
		.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.map((event) => event.message!);
	check(
		messages.length > 0 &&
			messages.every(
				(message) =>
					message.provider === profile.requested.provider &&
					message.model === profile.requested.model &&
					["toolUse", "stop"].includes(message.stopReason ?? ""),
			) &&
			messages.at(-1)!.stopReason === "stop",
		"Writer lacks a successful terminal event for the pinned requested profile",
	);
	const blockers: string[] = [];
	const responseIds = new Set<string>();
	const observations: OneironWriterProvenance["observations"] = messages.map((message, index) => {
		const source = message.responseModelSource === "provider-response" ? "provider-response" : "unknown";
		const responseModel =
			source === "provider-response" && typeof message.responseModel === "string" ? message.responseModel : null;
		const id = typeof message.responseId === "string" && message.responseId.trim() ? message.responseId : null;
		const approved = responseModel !== null && profile.approvedResponseModels.includes(responseModel);
		if (!id || responseIds.has(id))
			blockers.push(`response ${index}: missing or duplicate transport response identity`);
		if (id) responseIds.add(id);
		if (!approved)
			blockers.push(
				`response ${index}: ${responseModel === null || responseModel === profile.requested.model ? "unknown" : "unapproved"} gateway-reported model identity`,
			);
		return {
			responseId: id,
			requestedSelector: message.model!,
			responseModel,
			source,
			family: responseModel === "gpt-6-astra" ? "astra" : responseModel === "claude-fable-5.1" ? "fable" : "unknown",
		};
	});
	return {
		version: 1,
		requested: { ...profile.requested },
		profile: stage.writerProfile,
		runtime: profile.runtime,
		transcript: { path: join(m.outputDirectory, "writer.jsonl"), sha256: oneironSha(text) },
		manifestSha256,
		sourceFingerprint: m.source.fingerprint,
		sessionDirectory: join(m.outputDirectory, "session"),
		identityAccepted: blockers.length === 0,
		responseModels: [...new Set(observations.flatMap((item) => (item.responseModel ? [item.responseModel] : [])))],
		observations,
		blockers,
		upstreamIdentityAttested: false,
	};
}

export function validateOneironWriterReceipt(
	m: OneironManifest,
	result: Record<string, unknown>,
	manifestSha256: string,
	read: ReadPin,
): void {
	check(m.stage.kind === "writer", "Writer receipt validation needs a writer stage");
	const profile = readOneironWriterProfile(m.stage.writerProfile, read);
	const provenance = result.writerProvenance as OneironWriterProvenance;
	check(
		provenance?.transcript?.path === join(m.outputDirectory, "writer.jsonl"),
		"Writer receipt transcript identity mismatch",
	);
	const actual = summarizeOneironWriter(m, m.stage, profile, read(provenance.transcript), manifestSha256);
	check(
		JSON.stringify(provenance) === JSON.stringify(actual),
		"Writer provenance differs from factory-captured transport events",
	);
	check(
		actual.identityAccepted,
		"Writer serving identity is unknown/unapproved; reconcile before accepting or retrying",
	);
}
