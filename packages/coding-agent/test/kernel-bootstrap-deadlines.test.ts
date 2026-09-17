import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RLM_EXTRA_UV_ARGS, ensureKernelPython, resolveRuntimeIdentity } from "../src/core/kernel/bootstrap.js";

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let runtimeIdentity = "";
const silent = (): void => {};
// Allow a cold Node fixture and its helper to start before exercising the deadline.
const timeouts = { validationMs: 1_000, commandMs: 1_000, lockMs: 250, totalMs: 5_000 };

function executable(filePath: string, body: string): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, `#!${process.execPath}\n${body}\n`);
	chmodSync(filePath, 0o755);
}

function currentVenv(body: string): { venv: string; python: string } {
	const venv = join(tempDir, "venv");
	const python = join(venv, "bin", "python");
	executable(python, body);
	writeFileSync(
		join(venv, ".bootstrap-version"),
		JSON.stringify({ schema: 9, runtime: runtimeIdentity, snapshot: "dill", extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS }),
	);
	process.env.PRIME_AGENT_KERNEL_VENV = venv;
	return { venv, python };
}

function trackedProgram(body: string): string {
	return `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(join(tempDir, "pids"))}, process.pid + '\\n'); ${body}`;
}

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function recordedPids(): number[] {
	const file = join(tempDir, "pids");
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + 3_000;
	while (!predicate()) {
		if (performance.now() >= deadline) throw new Error("Timed out waiting for disposable bootstrap fixture");
		await sleep(10);
	}
}

describe("kernel bootstrap deadlines", () => {
	beforeEach(async () => {
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-kernel-deadlines-"));
		process.env.HOME = tempDir;
		process.env.PRIME_AGENT_INSTALL_UV = "0";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.XDG_DATA_HOME;
		runtimeIdentity = await resolveRuntimeIdentity();
	});

	afterEach(async () => {
		try {
			await until(() => recordedPids().every((pid) => !running(pid)));
		} finally {
			for (const pid of recordedPids()) {
				if (running(pid)) process.kill(pid, "SIGKILL");
			}
			process.env = originalEnv;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("times out runtime validation without rebuilding an existing environment", async () => {
		const { venv } = currentVenv(trackedProgram("setInterval(() => {}, 1000);"));
		writeFileSync(join(venv, "keep-me"), "original environment");

		await expect(ensureKernelPython({ onProgress: silent, timeouts })).rejects.toThrow(
			"runtime validation timed out",
		);

		expect(readFileSync(join(venv, "keep-me"), "utf8")).toBe("original environment");
		expect(existsSync(`${venv}.bootstrap.lock`)).toBe(false);
		expect(recordedPids()).toHaveLength(1);
		await until(() => recordedPids().every((pid) => !running(pid)));
	});

	it("bounds a live install lock wait without removing the other owner's lock", async () => {
		const venv = join(tempDir, "venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const lock = `${venv}.bootstrap.lock`;
		mkdirSync(lock);
		writeFileSync(join(lock, "pid"), `${process.pid}\n`);

		await expect(ensureKernelPython({ onProgress: silent, timeouts })).rejects.toThrow("install lock wait timed out");

		expect(readFileSync(join(lock, "pid"), "utf8")).toBe(`${process.pid}\n`);
		expect(existsSync(venv)).toBe(false);
	});

	it("kills a stalled installer and its helper before releasing the install lock", async () => {
		const venv = join(tempDir, "venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const bin = join(tempDir, "bin");
		const helper = join(tempDir, "helper");
		executable(helper, trackedProgram("setInterval(() => {}, 1000);"));
		executable(
			join(bin, "uv"),
			trackedProgram(
				`require('node:child_process').spawn(${JSON.stringify(helper)}, [], { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
			),
		);
		process.env.PATH = bin;

		await expect(ensureKernelPython({ onProgress: silent, timeouts })).rejects.toThrow(
			"installation command timed out",
		);

		expect(recordedPids()).toHaveLength(2);
		await until(() => recordedPids().every((pid) => !running(pid)));
		expect(existsSync(`${venv}.bootstrap.lock`)).toBe(false);
		expect(existsSync(join(venv, ".bootstrap-version"))).toBe(false);
	});

	it("cancels one waiter while preserving the shared bootstrap needed by another", async () => {
		const release = join(tempDir, "release");
		const { python } = currentVenv(
			trackedProgram(`setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);`),
		);
		const controller = new AbortController();
		const options = { onProgress: silent, timeouts: { ...timeouts, validationMs: 3_000 } };
		const first = ensureKernelPython({ ...options, signal: controller.signal });
		const firstResult = expect(first).rejects.toThrow("obsolete startup");
		const second = ensureKernelPython(options);
		await until(() => recordedPids().length === 1);

		controller.abort(new Error("obsolete startup"));
		await firstResult;
		expect(running(recordedPids()[0])).toBe(true);
		writeFileSync(release, "ready");

		await expect(second).resolves.toBe(python);
		expect(recordedPids()).toHaveLength(1);
	});

	it("shares a validation across hundreds of callers", async () => {
		const { python } = currentVenv(trackedProgram("setTimeout(() => process.exit(0), 100);"));
		const results = Array.from({ length: 300 }, () => ensureKernelPython({ onProgress: silent, timeouts }));

		await expect(Promise.all(results)).resolves.toEqual(Array.from({ length: 300 }, () => python));
		expect(recordedPids()).toHaveLength(1);
	});

	it("stops the subprocess when the last waiter cancels", async () => {
		currentVenv(trackedProgram("setInterval(() => {}, 1000);"));
		const controller = new AbortController();
		const result = ensureKernelPython({ onProgress: silent, signal: controller.signal, timeouts });
		const cancelled = expect(result).rejects.toThrow("closed session");
		await until(() => recordedPids().length === 1);

		controller.abort(new Error("closed session"));

		await cancelled;
		await until(() => recordedPids().every((pid) => !running(pid)));
	});

	it("bounds the total setup across individually successful import checks", async () => {
		const python = join(tempDir, "python");
		executable(python, trackedProgram("setTimeout(() => process.exit(0), 80);"));
		process.env.PRIME_AGENT_KERNEL_PYTHON = python;

		await expect(
			ensureKernelPython({ onProgress: silent, timeouts: { ...timeouts, validationMs: 2_000, totalMs: 400 } }),
		).rejects.toThrow("kernel setup timed out");

		expect(recordedPids().length).toBeGreaterThan(1);
		await until(() => recordedPids().every((pid) => !running(pid)));
	});

	it("revalidates a previously completed environment instead of caching success", async () => {
		const { python } = currentVenv(trackedProgram("process.exit(0);"));
		await expect(ensureKernelPython({ onProgress: silent, timeouts })).resolves.toBe(python);
		executable(python, trackedProgram("setInterval(() => {}, 1000);"));

		await expect(ensureKernelPython({ onProgress: silent, timeouts })).rejects.toThrow(
			"runtime validation timed out",
		);
		expect(recordedPids()).toHaveLength(2);
	});

	it("does not start a subprocess for an already cancelled caller", async () => {
		currentVenv(trackedProgram("process.exit(0);"));
		const controller = new AbortController();
		controller.abort(new Error("already closed"));

		await expect(ensureKernelPython({ signal: controller.signal, timeouts })).rejects.toThrow("already closed");
		expect(recordedPids()).toHaveLength(0);
	});
});
