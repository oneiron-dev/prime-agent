import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CommandHost,
	commandTransport,
	fingerprintCommand,
	type HostRequest,
} from "../../../src/factory/adapters/command.js";
import { COMMAND_RUNNER_SOURCE } from "../../../src/factory/adapters/command-runner-source.js";
import { runFactoryCli } from "../../../src/factory/cli.js";
import { FACTORY_HELP } from "../../../src/factory/help.js";
import { createHarness, type Harness } from "../harness.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

const sourceFingerprint = `git:${"a".repeat(64)}`;
const timeoutError = "Fingerprint timeout must be an integer between 1 and 120000 ms";

function mockHost() {
	vi.useFakeTimers();
	const child = Object.assign(new EventEmitter(), {
		stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(() => true),
	});
	vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as ChildProcess);
	return child;
}

function respond(child: ReturnType<typeof mockHost>, value: unknown = { sourceFingerprint }) {
	child.stdout.emit("data", Buffer.from(JSON.stringify(value)));
	child.emit("close", 0);
}

describe("ONE-1820 factory fingerprint timeout", () => {
	let harness: Harness;
	let host: CommandHost;
	let hostsPath: string;
	let cwd: string;

	beforeEach(async () => {
		harness = await createHarness();
		cwd = join(harness.tempDir, "source");
		host = { type: "local", runnerRoot: join(harness.tempDir, "attempts") };
		hostsPath = join(harness.tempDir, "hosts.json");
		writeFileSync(hostsPath, JSON.stringify({ local: host }));
		vi.mocked(childProcess.spawn).mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.mocked(childProcess.spawn).mockReset();
		harness.cleanup();
	});

	function request(operation: HostRequest["operation"] = "fingerprint"): HostRequest {
		return {
			operation,
			runnerRoot: host.runnerRoot,
			manifest: { version: 1, attemptId: "fingerprint", sourceFingerprint: "", command: { argv: ["git"], cwd } },
		};
	}

	function cliArgs(options: string[] = []): string[] {
		return ["fingerprint", "local", cwd, "--hosts", hostsPath, ...options];
	}

	it.each([undefined, 1, 20_000, 60_000, 120_000])(
		"uses the adapter deadline %s without changing request bytes",
		async (timeoutMs) => {
			const child = mockHost();
			const timer = vi.spyOn(globalThis, "setTimeout");
			const result = fingerprintCommand(host, cwd, timeoutMs);
			expect(timer).toHaveBeenCalledWith(expect.any(Function), timeoutMs ?? 20_000);
			expect(child.stdin.end).toHaveBeenCalledWith(JSON.stringify(request()));
			await vi.advanceTimersByTimeAsync((timeoutMs ?? 20_000) - 1);
			expect(child.kill).not.toHaveBeenCalled();
			respond(child);
			await expect(result).resolves.toBe(sourceFingerprint);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each([undefined, "1", "20000", "60000", "120000"])(
		"propagates CLI deadline %s to the host transport",
		async (timeout) => {
			const child = mockHost();
			const timer = vi.spyOn(globalThis, "setTimeout");
			const output = vi.spyOn(console, "log").mockImplementation(() => {});
			const timeoutMs = timeout === undefined ? 20_000 : Number(timeout);
			const result = runFactoryCli(cliArgs(timeout === undefined ? [] : ["--timeout-ms", timeout]));
			expect(timer).toHaveBeenCalledWith(expect.any(Function), timeoutMs);
			expect(child.stdin.end).toHaveBeenCalledWith(JSON.stringify(request()));
			await vi.advanceTimersByTimeAsync(timeoutMs - 1);
			expect(child.kill).not.toHaveBeenCalled();
			respond(child);
			await result;
			expect(output).toHaveBeenCalledOnce();
			expect(output).toHaveBeenCalledWith(JSON.stringify({ sourceFingerprint }));
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 120_001, Number.MAX_VALUE])(
		"rejects invalid adapter deadline %s before spawning",
		async (timeoutMs) => {
			mockHost();
			await expect(fingerprintCommand(host, cwd, timeoutMs)).rejects.toThrow(timeoutError);
			expect(childProcess.spawn).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each([
		"invalid",
		"20000ms",
		" ",
		"0",
		"-1",
		"1.5",
		"NaN",
		"Infinity",
		"-Infinity",
		"120001",
		"1e100",
		"9007199254740993",
	])(
		"rejects invalid CLI deadline %s without emitting a fingerprint",
		async (timeout) => {
			mockHost();
			const output = vi.spyOn(console, "log").mockImplementation(() => {});
			await expect(runFactoryCli(cliArgs(["--timeout-ms", timeout]))).rejects.toThrow(timeoutError);
			expect(childProcess.spawn).not.toHaveBeenCalled();
			expect(output).not.toHaveBeenCalled();
		},
	);

	it("rejects missing and repeated CLI timeout values", async () => {
		mockHost();
		await expect(runFactoryCli(cliArgs(["--timeout-ms"]))).rejects.toThrow("Missing value for --timeout-ms");
		await expect(runFactoryCli(cliArgs(["--timeout-ms", ""]))).rejects.toThrow("Missing value for --timeout-ms");
		await expect(runFactoryCli(cliArgs(["--timeout-ms", "20000", "--timeout-ms", "60000"]))).rejects.toThrow(
			"Repeated option --timeout-ms",
		);
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});

	it.each([
		"init",
		"status",
		"events",
		"tick",
		"run",
		"serve",
		"pause",
		"resume",
		"import",
		"decide",
		"supersede",
		"resolve",
		"reconcile-management",
	])(
		"rejects --timeout-ms for %s before reading factory state",
		async (command) => {
			mockHost();
			await expect(runFactoryCli([command, cwd, "--timeout-ms", "60000"])).rejects.toThrow(
				"--timeout-ms is only supported for fingerprint",
			);
			expect(childProcess.spawn).not.toHaveBeenCalled();
		},
	);

	it.each(["adapter", "cli"])("reports %s timeout failure, not a fingerprint or a launch result", async (entry) => {
		const child = mockHost();
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const result =
			entry === "adapter"
				? fingerprintCommand(host, cwd, 60_000)
				: runFactoryCli(cliArgs(["--timeout-ms", "60000"]));
		const rejected = expect(result).rejects.toThrow("Host transport timed out while fingerprinting source");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(child.kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(39_999);
		expect(child.kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await rejected;
		expect(child.kill).toHaveBeenCalledOnce();
		respond(child);
		expect(output).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["launch", "inspect"] as const)("keeps the %s transport deadline at 20000 ms", async (operation) => {
		const child = mockHost();
		const result = commandTransport(host, request(operation));
		const rejected = expect(result).rejects.toThrow("Host transport timed out; launch state is uncertain");
		await vi.advanceTimersByTimeAsync(19_999);
		expect(child.kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await rejected;
		expect(child.kill).toHaveBeenCalledOnce();
	});

	it("applies the explicit deadline to SSH without changing the native runner or request", async () => {
		const child = mockHost();
		const timer = vi.spyOn(globalThis, "setTimeout");
		const result = fingerprintCommand({ ...host, type: "ssh", sshHost: "user@factory-host" }, cwd, 120_000);
		expect(childProcess.spawn).toHaveBeenCalledWith("ssh", expect.any(Array), { stdio: ["pipe", "pipe", "pipe"] });
		expect(timer).toHaveBeenCalledWith(expect.any(Function), 120_000);
		expect(child.stdin.end).toHaveBeenCalledWith(JSON.stringify(request()));
		respond(child);
		await expect(result).resolves.toBe(sourceFingerprint);
	});

	it("documents the fingerprint-only bounds and unchanged default", () => {
		expect(FACTORY_HELP).toContain("--hosts <hosts.json> [--timeout-ms <milliseconds>]");
		expect(FACTORY_HELP).toContain("integers 1..120000 (default 20000 ms)");
		expect(FACTORY_HELP).toContain("launch and inspect deadlines are unchanged");
	});

	it("preserves native Git fingerprint bytes for a dirty conflicted index and untracked files", async () => {
		mkdirSync(cwd);
		const git = (...args: string[]) =>
			childProcess.execFileSync(
				"git",
				[
					"-C",
					cwd,
					"-c",
					"user.name=Test",
					"-c",
					"user.email=test@example.invalid",
					"-c",
					"commit.gpgsign=false",
					"-c",
					"core.autocrlf=false",
					...args,
				],
				{ encoding: "utf8", stdio: "pipe" },
			);
		git("init", "-q");
		writeFileSync(join(cwd, "tracked"), "base\n");
		writeFileSync(join(cwd, "binary"), Buffer.from([0, 1, 255]));
		git("add", "tracked", "binary");
		git("commit", "-qm", "base");
		git("branch", "other");
		git("checkout", "-qb", "ours");
		writeFileSync(join(cwd, "tracked"), "ours\n");
		git("commit", "-qam", "ours");
		git("checkout", "-q", "other");
		writeFileSync(join(cwd, "tracked"), "theirs\n");
		git("commit", "-qam", "theirs");
		expect(() => git("merge", "ours")).toThrow();
		const unmerged = git("ls-files", "-u");
		expect(unmerged).not.toBe("");
		const conflictedBytes = readFileSync(join(cwd, "tracked"));
		expect(conflictedBytes.toString()).toContain("<<<<<<<");
		writeFileSync(join(cwd, "binary"), Buffer.from([0, 2, 254]));
		git("add", "binary");
		writeFileSync(join(cwd, "untracked"), Buffer.from([0, 13, 10, 255]));
		chmodSync(join(cwd, "untracked"), 0o751);
		symlinkSync("untracked", join(cwd, "link"));
		const diff = git("diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--");
		const nativeOutput = childProcess
			.execFileSync("python3", ["-c", COMMAND_RUNNER_SOURCE], {
				input: JSON.stringify(request()),
				encoding: "utf8",
			})
			.trim();
		const native = JSON.parse(nativeOutput) as { sourceFingerprint: string };
		expect(native.sourceFingerprint).toMatch(/^git:[0-9a-f]{64}$/);
		expect(await fingerprintCommand(host, cwd)).toBe(native.sourceFingerprint);
		expect(await fingerprintCommand(host, cwd, 120_000)).toBe(native.sourceFingerprint);
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		await runFactoryCli(cliArgs());
		await runFactoryCli(cliArgs(["--timeout-ms", "60000"]));
		expect(output.mock.calls).toEqual([[nativeOutput], [nativeOutput]]);
		expect(git("ls-files", "-u")).toBe(unmerged);
		expect(git("diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--")).toBe(diff);
		expect(readFileSync(join(cwd, "tracked"))).toEqual(conflictedBytes);
		writeFileSync(join(cwd, "untracked"), Buffer.from([0, 13, 10, 254]));
		expect(await fingerprintCommand(host, cwd, 60_000)).not.toBe(native.sourceFingerprint);
	});
});
