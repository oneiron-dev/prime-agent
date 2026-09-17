import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ActionRecord, AttemptRecord, CompletionReceipt, SlotSpec } from "../types.js";
import { COMMAND_RUNNER_SOURCE } from "./command-runner-source.js";

export interface CommandHost {
	type: "local" | "ssh";
	runnerRoot: string;
	sshHost?: string;
	python?: string;
}

export interface CommandContext {
	attempt: AttemptRecord;
	action: ActionRecord;
	slot: SlotSpec;
}

export type CommandInspection =
	| { kind: "running"; processIdentity: string }
	| { kind: "terminal"; receipt: CompletionReceipt }
	| { kind: "uncertain"; reason: string };

export interface HostRequest {
	operation: "launch" | "inspect" | "fingerprint";
	runnerRoot: string;
	manifest: {
		version: 1;
		attemptId: string;
		sourceFingerprint: string;
		command: ActionRecord["command"];
	};
}

export type HostTransport = (host: CommandHost, request: HostRequest) => Promise<unknown>;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function hostLaunchSpec(host: CommandHost): { command: string; args: string[] } {
	const python = host.python ?? "python3";
	if (host.type === "local") return { command: python, args: ["-c", COMMAND_RUNNER_SOURCE] };
	if (!host.sshHost || !/^[A-Za-z0-9_@.:-]+$/.test(host.sshHost) || host.sshHost.startsWith("-")) {
		throw new Error("SSH host must be an explicit hostname or configured SSH alias");
	}
	return {
		command: "ssh",
		args: [
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"--",
			host.sshHost,
			[shellQuote(python), "-c", shellQuote(COMMAND_RUNNER_SOURCE)].join(" "),
		],
	};
}

export const commandTransport: HostTransport = (host, request) => transportCommand(host, request, 20_000);

function transportCommand(host: CommandHost, request: HostRequest, timeoutMs: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const spec = hostLaunchSpec(host);
		const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
		let output = "";
		let errorOutput = "";
		let settled = false;
		const finish = (error?: Error, value?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(
				new Error(
					request.operation === "fingerprint"
						? "Host transport timed out while fingerprinting source"
						: "Host transport timed out; launch state is uncertain",
				),
			);
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.length > 1024 * 1024) {
				child.kill();
				finish(new Error("Host response exceeded limit"));
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			errorOutput = (errorOutput + chunk.toString()).slice(-4096);
		});
		child.on("error", (error) => finish(error));
		child.stdin.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code !== 0) return finish(new Error(`Host transport exited ${code}: ${errorOutput.trim()}`));
			try {
				finish(undefined, JSON.parse(output));
			} catch {
				finish(new Error("Host returned an invalid receipt"));
			}
		});
		child.stdin.end(JSON.stringify(request));
	});
}

export class CommandAdapter {
	constructor(
		private readonly hosts: Record<string, CommandHost>,
		private readonly options: { pauseFile?: string; transport?: HostTransport } = {},
	) {
		for (const [name, host] of Object.entries(hosts)) {
			if (!isAbsolute(host.runnerRoot)) throw new Error(`Host ${name} requires an absolute runnerRoot`);
			if (host.type !== "local" && host.type !== "ssh") throw new Error(`Unknown host type for ${name}`);
			hostLaunchSpec(host);
		}
	}

	async launch(context: CommandContext): Promise<CommandInspection> {
		if (this.options.pauseFile && existsSync(this.options.pauseFile)) {
			return { kind: "uncertain", reason: "Owner pause file exists; dispatch suppressed" };
		}
		return this.request("launch", context);
	}

	async inspect(context: CommandContext): Promise<CommandInspection> {
		return this.request("inspect", context);
	}

	private async request(operation: HostRequest["operation"], context: CommandContext): Promise<CommandInspection> {
		const host = this.hosts[context.slot.host];
		if (!host) return { kind: "uncertain", reason: `Unconfigured host ${context.slot.host}` };
		const request: HostRequest = {
			operation,
			runnerRoot: host.runnerRoot,
			manifest: {
				version: 1,
				attemptId: context.attempt.id,
				sourceFingerprint: context.action.sourceFingerprint,
				command: context.action.command,
			},
		};
		try {
			const value = await (this.options.transport ?? commandTransport)(host, request);
			if (!value || typeof value !== "object") throw new Error("Malformed host result");
			const result = value as Record<string, unknown>;
			if (result.kind === "running" && typeof result.processIdentity === "string" && result.processIdentity) {
				return { kind: "running", processIdentity: result.processIdentity };
			}
			if (result.kind === "terminal" && result.receipt && typeof result.receipt === "object") {
				const receipt = result.receipt as CompletionReceipt;
				if (
					receipt.attemptId !== context.attempt.id ||
					receipt.sourceFingerprint !== context.action.sourceFingerprint ||
					!(receipt.exitCode === null || Number.isInteger(receipt.exitCode)) ||
					typeof receipt.finishedAt !== "string" ||
					!Number.isFinite(Date.parse(receipt.finishedAt))
				) {
					throw new Error("Terminal receipt identity or outcome is invalid");
				}
				return { kind: "terminal", receipt };
			}
			if (result.kind === "uncertain" && typeof result.reason === "string")
				return { kind: "uncertain", reason: result.reason };
			throw new Error("Malformed host result");
		} catch (error) {
			return { kind: "uncertain", reason: error instanceof Error ? error.message : String(error) };
		}
	}
}

export async function fingerprintCommand(host: CommandHost, cwd: string, timeoutMs = 20_000): Promise<string> {
	if (!isAbsolute(cwd)) throw new Error("Fingerprint requires an absolute cwd");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
		throw new Error("Fingerprint timeout must be an integer between 1 and 120000 ms");
	}
	const value = await transportCommand(
		host,
		{
			operation: "fingerprint",
			runnerRoot: host.runnerRoot,
			manifest: { version: 1, attemptId: "fingerprint", sourceFingerprint: "", command: { argv: ["git"], cwd } },
		},
		timeoutMs,
	);
	if (
		!value ||
		typeof value !== "object" ||
		!("sourceFingerprint" in value) ||
		typeof value.sourceFingerprint !== "string" ||
		!/^git:[0-9a-f]{64}$/.test(value.sourceFingerprint)
	) {
		throw new Error("Host could not fingerprint the source");
	}
	return value.sourceFingerprint;
}
