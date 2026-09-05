import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CommandAdapter, fingerprintCommand } from "../src/factory/adapters/command.js";
import {
	type OneironManifest,
	type OneironPermit,
	type OneironReceipt,
	prepareOneiron,
} from "../src/factory/adapters/oneiron.js";
import { type OneironPin, oneironSha } from "../src/factory/adapters/oneiron-review.js";
import {
	defaultOneironWriterProfile,
	type OneironWriterProfile,
	type OneironWriterRetry,
} from "../src/factory/adapters/oneiron-writer.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { FactoryStore } from "../src/factory/store.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("whole-attempt retry under the real factory supervisor", () => {
	test.each([false, true])(
		"permits only its real current attempt; competing claim=%s",
		async (competitor) => {
			const directory = mkdtempSync(join(tmpdir(), "oneiron-retry-runner-"));
			roots.push(directory);
			let counter = 0;
			const pin = (value: unknown): OneironPin => {
				const path = join(directory, `evidence-${counter++}.json`);
				writeFileSync(path, JSON.stringify(value));
				return { path, sha256: oneironSha(readFileSync(path)) };
			};
			const workspace = join(directory, "workspace");
			mkdirSync(workspace);
			const git = (...args: string[]) =>
				execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
			git("init", "-q", "--initial-branch=fixture");
			writeFileSync(join(workspace, "source"), "test only");
			git("add", "source");
			git(
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-qm",
				"fixture",
			);
			const host = { type: "local" as const, runnerRoot: join(directory, "attempts") };
			const source = {
				workspace,
				head: git("rev-parse", "HEAD"),
				tree: git("rev-parse", "HEAD^{tree}"),
				branch: "fixture",
				remoteUrl: "https://example.invalid/fixture.git",
				fingerprint: await fingerprintCommand(host, workspace),
			};
			const bundle = join(directory, "bundle");
			mkdirSync(bundle);
			const node = join(bundle, "node");
			const cli = join(bundle, "cli.js");
			writeFileSync(node, "fixture node");
			writeFileSync(cli, "fixture cli");
			const runtimePin = pin({
				version: 1,
				cliArgv: [node, cli],
				files: [node, cli].map((path) => ({ path, sha256: oneironSha(readFileSync(path)) })),
				capabilities: ["provider-response-model-v1"],
			});
			const primaryProfile = defaultOneironWriterProfile(runtimePin);
			const primaryProfilePin = pin(primaryProfile);
			const authorization = pin({ fixtureOnly: true, approved: true });
			const custody = pin({
				version: 1,
				state: "transferred",
				ticketId: "RETRY-1",
				owner: "fixture",
				sourceFingerprint: source.fingerprint,
				expiresAt: "2099-01-01",
				activeOwners: ["fixture"],
				liveProcesses: [],
				duplicateAuthorityDisabled: true,
				sharedGitClear: true,
				priorOwners: [{ id: "prior", release: authorization }],
			});
			const triage = pin({
				stage: "triage",
				output: source,
				result: { triage: { findings: [{ classification: "material", disposition: "open" }] } },
			});
			const manifest: OneironManifest = {
				version: 1,
				ticketId: "RETRY-1",
				owner: "fixture",
				source,
				factoryDirectory: directory,
				factoryRuntime: runtimePin,
				ownerPauseFile: join(directory, "pause"),
				custody,
				outputDirectory: join(directory, "prior-output"),
				stage: {
					kind: "writer",
					prompt: pin("Repair the retained material finding"),
					triage,
					writerProfile: primaryProfilePin,
				},
			};
			const priorManifest = pin(manifest);
			const priorPermit = pin({ unusedFixture: true });
			const old = prepareOneiron(manifest, {
				manifestPath: priorManifest.path,
				adapterArgv: [process.execPath, "-e", "process.exit(1)"],
				permitPath: priorPermit.path,
				host: "local",
				slotId: "writer",
			}).action!;
			const database = join(directory, "factory.db");
			const store = new FactoryStore(database);
			const engine = new FactoryEngine(store, new CommandAdapter({ local: host }), { enabled: true });
			try {
				engine.applyPlan({
					version: 1,
					tickets: [{ id: manifest.ticketId, owner: manifest.owner }],
					slots: [
						{ id: "writer", host: "local" },
						{ id: "other", host: "local" },
					],
					actions: [old],
				});
				engine.resume();
				await engine.tick();
				await vi.waitFor(
					async () => {
						await engine.tick();
						expect(store.attempts()[0]!.state).toBe("TERMINAL");
					},
					{ timeout: 10000, interval: 30 },
				);
				const priorAttempt = store.attempts()[0]!;
				expect(priorAttempt.receipt!.exitCode).toBe(1);
				const proof: OneironWriterRetry = {
					version: 1,
					decision: "retry-whole-attempt",
					ticketId: manifest.ticketId,
					priorActionId: old.id,
					priorAttemptId: priorAttempt.id,
					priorManifest,
					priorTerminal: pin(priorAttempt.receipt),
					processProof: pin({ priorProcessGone: true, fixtureOnly: true }),
					retainedEvidence: [priorManifest],
					workspaceDisposition: "retained",
					reconciledSource: source,
					custody,
					ownerAuthorization: authorization,
					noLiveProcesses: true,
					noDuplicateExecution: true,
					expiresAt: "2099-01-01",
				};
				const retryProfile: OneironWriterProfile = {
					...primaryProfile,
					mode: "astra-retry",
					requested: { provider: "cpa-r", model: "gpt-6-astra", effort: "xhigh" },
					approvedResponseModels: ["gpt-6-astra"],
				};
				manifest.outputDirectory = join(directory, "retry-output");
				manifest.stage = {
					kind: "writer",
					prompt: pin("Repair only the retained material finding"),
					triage,
					writerProfile: pin(retryProfile),
					retryReconciliation: pin(proof),
				};
				const retryManifest = pin(manifest);
				const permit: OneironPermit = {
					version: 1,
					permission: "execute",
					manifestSha256: retryManifest.sha256,
					ticketId: manifest.ticketId,
					stage: "writer",
					sourceFingerprint: source.fingerprint,
					custodySha256: custody.sha256,
					owner: manifest.owner,
					ownerAuthorization: authorization,
					expiresAt: "2099-01-01",
				};
				const permitPin = pin(permit);
				const marker = join(directory, "writer-called.json");
				const fixture = join(directory, "retry-stage.mjs");
				const response = JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						provider: "cpa-r",
						model: "gpt-6-astra",
						responseModel: "gpt-6-astra",
						responseModelSource: "provider-response",
						responseId: "resp_retry_fixture",
						stopReason: "stop",
					},
				});
				writeFileSync(
					fixture,
					`import {writeFileSync} from 'node:fs'; import {executeOneiron} from ${JSON.stringify(resolve("src/factory/adapters/oneiron.ts"))}; import {FactoryStore} from ${JSON.stringify(resolve("src/factory/store.ts"))}; const runtime={now:Date.now,source:async()=>(${JSON.stringify(source)}),status:async()=>{const store=new FactoryStore(${JSON.stringify(database)});try{return {...store.status(),ownerPaused:false}}finally{store.close()}},run:async()=>{throw Error('Writer must use file-backed capture')},runWriter:async(argv,cwd,transcriptPath)=>{writeFileSync(${JSON.stringify(marker)},JSON.stringify({attemptId:process.env.PRIME_FACTORY_ATTEMPT_ID,source:process.env.PRIME_FACTORY_SOURCE_FINGERPRINT,argv}));writeFileSync(transcriptPath,${JSON.stringify(response)},{flag:'wx'})},call:async()=>{throw Error('No model request permitted in fixture')}}; console.log(JSON.stringify(await executeOneiron(${JSON.stringify(retryManifest.path)},${JSON.stringify(permitPin.path)},true,runtime,${JSON.stringify(retryManifest.sha256)})));`,
				);
				const action = prepareOneiron(manifest, {
					manifestPath: retryManifest.path,
					adapterArgv: [process.execPath, "--import", resolve("../../node_modules/tsx/dist/loader.mjs"), fixture],
					permitPath: permitPin.path,
					host: "local",
					slotId: "writer",
				}).action!;
				const other = {
					...old,
					id: "competing-claim",
					command: { argv: ["fixture-not-launched"], cwd: join(directory, "other-workspace") },
					sourceFingerprint: "fixture:other",
					requirements: { slotId: "other" },
				};
				engine.applyPlan({ version: 1, tickets: [], slots: [], actions: competitor ? [action, other] : [action] });
				if (competitor) {
					const claim = store.claim(other.id, "other")!;
					expect(claim).toBeTruthy();
					store.markSubmitted(claim.attempt.id);
				}
				vi.stubEnv("PRIME_FACTORY_ATTEMPT_ID", "inherited-spoof");
				vi.stubEnv("PRIME_FACTORY_SOURCE_FINGERPRINT", "wrong-source");
				await engine.tick();
				await vi.waitFor(
					async () => {
						await engine.tick();
						expect(store.attempts().find((attempt) => attempt.actionId === action.id)?.state).toBe("TERMINAL");
					},
					{ timeout: 15000, interval: 40 },
				);
				const current = store.attempts().find((attempt) => attempt.actionId === action.id)!;
				const error = readFileSync(join(host.runnerRoot, current.id, "stderr.log"), "utf8");
				if (competitor) {
					expect(current.receipt!.exitCode, error).toBe(1);
					expect(error).toContain("Another attempt");
					expect(existsSync(marker)).toBe(false);
				} else {
					expect(current.receipt!.exitCode, error).toBe(0);
					expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
						attemptId: current.id,
						source: source.fingerprint,
					});
					const receipt = JSON.parse(
						readFileSync(join(manifest.outputDirectory, "receipt.json"), "utf8"),
					) as OneironReceipt;
					expect(receipt.result.writerProvenance).toMatchObject({
						requested: retryProfile.requested,
						responseModels: ["gpt-6-astra"],
						identityAccepted: true,
					});
				}
			} finally {
				store.close();
			}
		},
		25000,
	);
});
