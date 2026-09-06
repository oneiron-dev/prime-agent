import { createHash } from "node:crypto";
import type * as NodeFs from "node:fs";
import { existsSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CommandAdapter, type CommandContext } from "../src/factory/adapters/command.js";
import {
	type CapturedStream,
	ForegroundCaptureError,
	runOneironCapture,
} from "../src/factory/adapters/oneiron-capture.js";
import { ONEIRON_TRANSPORT_LIMITS, verifyOneironArtifact } from "../src/factory/adapters/oneiron-transport.js";
import { runOneironWriterForeground } from "../src/factory/adapters/oneiron-writer.js";

// Local process fixtures and explicit filesystem faults are not production verification evidence.
const ioFault = vi.hoisted(() => ({
	afterBytes: undefined as number | undefined,
	mode: "none" as "none" | "write" | "zero",
	written: 0,
	shortWrites: false,
	recoverAfterFailure: false,
	fsync: false,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return {
		...actual,
		openSync: vi.fn(actual.openSync),
		writeSync: vi.fn((fd: number, buffer: NodeJS.ArrayBufferView, offset = 0, length = buffer.byteLength) => {
			if (ioFault.afterBytes !== undefined && ioFault.written >= ioFault.afterBytes) {
				if (ioFault.mode === "write") {
					if (ioFault.recoverAfterFailure) ioFault.afterBytes = undefined;
					throw new Error("ENOSPC: explicit capture test write fault");
				}
				if (ioFault.mode === "zero") return 0;
			}
			const remaining = ioFault.afterBytes === undefined ? length : ioFault.afterBytes - ioFault.written;
			const size = Math.min(length, remaining, ioFault.shortWrites ? 3 : length);
			const written = actual.writeSync(fd, buffer, offset, size);
			ioFault.written += written;
			return written;
		}),
		fsyncSync: vi.fn((fd: number) => {
			if (ioFault.fsync) throw new Error("EIO: explicit capture test fsync fault");
			actual.fsyncSync(fd);
		}),
	};
});

const roots: string[] = [];
function setup() {
	const directory = mkdtempSync(join(tmpdir(), "oneiron-capture-fixture-"));
	roots.push(directory);
	return {
		directory,
		options: {
			stdoutPath: join(directory, "stdout.log"),
			stderrPath: join(directory, "stderr.log"),
			limitBytes: 4096,
			previewBytes: 32,
			label: "Fixture gate",
		},
	};
}
function command(script: string): string[] {
	return [process.execPath, "-e", `const fs = require('node:fs'); ${script}`];
}
function retained(stream: CapturedStream, bytes: Buffer, previewBytes = 32, preview?: string): void {
	expect(readFileSync(stream.path)).toEqual(bytes);
	expect(stream.bytes).toBe(bytes.length);
	expect(stream.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
	expect(stream.preview).toBe(preview ?? bytes.subarray(0, previewBytes).toString("utf8"));
	expect(Buffer.byteLength(stream.preview)).toBeLessThanOrEqual(previewBytes);
}
async function rejectedCapture(run: () => Promise<unknown>) {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(ForegroundCaptureError);
		return (error as ForegroundCaptureError).capture;
	}
	throw new Error("Expected foreground capture to reject");
}
function expectCaptureFilesClosed(): void {
	for (const result of vi.mocked(openSync).mock.results) {
		if (result.type === "return") expect(() => fstatSync(result.value)).toThrow(/EBADF/);
	}
}
beforeEach(() => {
	Object.assign(ioFault, {
		afterBytes: undefined,
		mode: "none",
		written: 0,
		shortWrites: false,
		recoverAfterFailure: false,
		fsync: false,
	});
	vi.clearAllMocks();
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("foreground capture with local command fixtures", () => {
	test("retains and hashes stdout and stderr when the command exits nonzero", async () => {
		const f = setup();
		const stdout = Buffer.from("partial stdout é\n");
		const stderr = Buffer.from("failure detail 🌊\n");
		const argv = command(
			`fs.writeSync(1, ${JSON.stringify(stdout.toString())}); fs.writeSync(2, ${JSON.stringify(stderr.toString())}); process.exitCode = 23;`,
		);
		const capture = await rejectedCapture(() => runOneironCapture(argv, f.directory, f.options));
		expect(capture).toMatchObject({ argv, cwd: f.directory, exitCode: 23, signal: null });
		expect(capture.failure).toMatch(/exited 23/);
		retained(capture.stdout, stdout);
		retained(capture.stderr!, stderr);
		expect(capture.stdout).toMatchObject({ observedBytes: stdout.length, truncated: false });
		expect(capture.stderr).toMatchObject({ observedBytes: stderr.length, truncated: false });
		expectCaptureFilesClosed();
	});

	test("accepts exact UTF-8 byte limits independently on both streams", async () => {
		const f = setup();
		const stdout = Buffer.from("Aé🌊\r\n");
		const stderr = Buffer.from("Bø🧭\r\n");
		const capture = await runOneironCapture(
			command(
				`fs.writeSync(1, ${JSON.stringify(stdout.toString())}); fs.writeSync(2, ${JSON.stringify(stderr.toString())});`,
			),
			f.directory,
			{ ...f.options, limitBytes: stdout.length, previewBytes: 4 },
		);
		expect(capture).toMatchObject({ exitCode: 0, signal: null });
		expect(capture.failure).toBeUndefined();
		retained(capture.stdout, stdout, 4, "Aé");
		retained(capture.stderr!, stderr, 4, "Bø");
		for (const stream of [capture.stdout, capture.stderr!]) {
			expect(stream).toMatchObject({ observedBytes: stdout.length, truncated: false });
			expect(statSync(stream.path).mode & 0o777).toBe(0o600);
		}
		expectCaptureFilesClosed();
	});
	test.each(["stdout", "stderr"] as const)("retains the exact raw %s prefix on UTF-8 overflow", async (stream) => {
		const f = setup();
		const raw = Buffer.from("é🌊尾");
		const target = stream === "stdout" ? 1 : 2;
		const other = target === 1 ? 2 : 1;
		const capture = await rejectedCapture(() =>
			runOneironCapture(
				command(`fs.writeSync(${other}, 'ok'); fs.writeSync(${target}, ${JSON.stringify(raw.toString())});`),
				f.directory,
				{ ...f.options, limitBytes: 5, previewBytes: 3 },
			),
		);
		const overflow = capture[stream]!;
		retained(overflow, raw.subarray(0, 5), 3, "é");
		expect(overflow).toMatchObject({ observedBytes: raw.length, truncated: true });
		retained(capture[stream === "stdout" ? "stderr" : "stdout"]!, Buffer.from("ok"), 3);
		expect(capture.failure).toMatch(new RegExp(`${stream} rawBytes=${raw.length} exceeds limit=5`));
		expectCaptureFilesClosed();
	});
	test.each(["stdoutPath", "stderrPath"] as const)("does not overwrite existing %s or launch a command", (stream) => {
		const f = setup();
		const retainedBytes = Buffer.from("prior retained evidence\n");
		writeFileSync(f.options[stream], retainedBytes);
		const marker = join(f.directory, "must-not-launch");
		expect(() =>
			runOneironCapture(command(`fs.writeFileSync(${JSON.stringify(marker)}, 'launched');`), f.directory, f.options),
		).toThrow(/EEXIST/);
		expect(readFileSync(f.options[stream])).toEqual(retainedBytes);
		expect(() => statSync(marker)).toThrow(/ENOENT/);
		expectCaptureFilesClosed();
	});
	test("retains both streams when the child terminates by signal", async () => {
		const f = setup();
		const capture = await rejectedCapture(() =>
			runOneironCapture(
				command(
					"fs.writeSync(1, 'interrupted'); fs.writeSync(2, 'diagnostic'); process.kill(process.pid, 'SIGTERM');",
				),
				f.directory,
				f.options,
			),
		);
		expect(capture).toMatchObject({ exitCode: null, signal: "SIGTERM" });
		expect(capture.failure).toMatch(/SIGTERM/);
		retained(capture.stdout, Buffer.from("interrupted"));
		retained(capture.stderr!, Buffer.from("diagnostic"));
		expectCaptureFilesClosed();
	});
	test("retains empty artifacts and closes files if the executable cannot spawn", async () => {
		const f = setup();
		const capture = await rejectedCapture(() =>
			runOneironCapture([join(f.directory, "missing-executable")], f.directory, f.options),
		);
		expect(capture.failure).toMatch(/ENOENT/);
		retained(capture.stdout, Buffer.alloc(0));
		retained(capture.stderr!, Buffer.alloc(0));
		expectCaptureFilesClosed();
	});
	test("uses the explicit gate environment instead of ambient values", async () => {
		const f = setup();
		vi.stubEnv("CAPTURE_FIXTURE_AMBIENT", "must-not-leak");
		const environment = { CAPTURE_FIXTURE_EXPLICIT: "local-test", GIT_OPTIONAL_LOCKS: "1" };
		const capture = await runOneironCapture(
			command(
				"fs.writeSync(1, JSON.stringify({ cwd: process.cwd(), ambient: process.env.CAPTURE_FIXTURE_AMBIENT ?? null, explicit: process.env.CAPTURE_FIXTURE_EXPLICIT, locks: process.env.GIT_OPTIONAL_LOCKS }));",
			),
			f.directory,
			{ ...f.options, environment, replaceEnvironment: true },
		);
		expect(JSON.parse(readFileSync(capture.stdout.path, "utf8"))).toEqual({
			cwd: f.directory,
			ambient: null,
			explicit: "local-test",
			locks: "0",
		});
		expect(capture.environment).toEqual(environment);
		expect(Number.isFinite(Date.parse(capture.startedAt))).toBe(true);
		expect(Date.parse(capture.finishedAt)).toBeGreaterThanOrEqual(Date.parse(capture.startedAt));
	});
});

describe("explicit capture filesystem fault injection", () => {
	test("completes short writes without losing or double-hashing bytes", async () => {
		const f = setup();
		const raw = Buffer.from("short writes é🌊\r\n");
		ioFault.shortWrites = true;
		const capture = await runOneironCapture(
			command(`fs.writeSync(1, ${JSON.stringify(raw.toString())});`),
			f.directory,
			f.options,
		);
		retained(capture.stdout, raw);
		expect(capture.stdout).toMatchObject({ observedBytes: raw.length, truncated: false });
		expectCaptureFilesClosed();
	});
	test.each(["write", "zero"] as const)(
		"rejects a %s failure and hashes only bytes actually retained",
		async (mode) => {
			const f = setup();
			const raw = Buffer.from("é🌊 write fault tail");
			Object.assign(ioFault, { mode, afterBytes: 4 });
			const capture = await rejectedCapture(() =>
				runOneironCapture(command(`fs.writeSync(1, ${JSON.stringify(raw.toString())});`), f.directory, f.options),
			);
			expect(capture.failure).toMatch(mode === "write" ? /ENOSPC/ : /write made no progress/);
			retained(capture.stdout, raw.subarray(0, 4));
			expect(capture.stdout.observedBytes).toBe(raw.length);
			retained(capture.stderr!, Buffer.alloc(0));
			expectCaptureFilesClosed();
		},
	);
	test("does not append later chunks after a transient disk error leaves a gap", async () => {
		const f = setup();
		Object.assign(ioFault, { mode: "write", afterBytes: 4, recoverAfterFailure: true });
		const argv = command(
			"process.once('SIGTERM', () => { fs.writeSync(1, 'later-data'); fs.writeSync(2, 'healthy stderr'); process.exit(0); }); fs.writeSync(1, 'abcdef'); setTimeout(() => process.exit(2), 2000);",
		);
		const capture = await rejectedCapture(() => runOneironCapture(argv, f.directory, f.options));
		expect(capture.failure).toMatch(/ENOSPC/);
		expect(capture.exitCode).toBe(0);
		retained(capture.stdout, Buffer.from("abcd"));
		expect(capture.stdout).toMatchObject({ observedBytes: 16, truncated: true });
		retained(capture.stderr!, Buffer.from("healthy stderr"));
		expectCaptureFilesClosed();
	});
	test("rejects fsync failure even after a zero exit and retains both complete artifacts", async () => {
		const f = setup();
		ioFault.fsync = true;
		const capture = await rejectedCapture(() =>
			runOneironCapture(
				command("fs.writeSync(1, 'complete stdout'); fs.writeSync(2, 'complete stderr');"),
				f.directory,
				f.options,
			),
		);
		expect(capture.exitCode).toBe(0);
		expect(capture.failure).toMatch(/EIO: explicit capture test fsync fault/);
		retained(capture.stdout, Buffer.from("complete stdout"));
		retained(capture.stderr!, Buffer.from("complete stderr"));
		expectCaptureFilesClosed();
	});
});

describe("writer wrapper with local transport fixtures", () => {
	test("returns no transcript string, keeps raw partial JSON, and preserves environment inheritance", async () => {
		const f = setup();
		vi.stubEnv("CAPTURE_FIXTURE_AMBIENT", "inherited-local-value");
		const argv = command(
			"fs.writeSync(1, process.env.CAPTURE_FIXTURE_AMBIENT + ':' + process.env.CAPTURE_FIXTURE_EXPLICIT + ':' + process.env.GIT_OPTIONAL_LOCKS + ': {\"type\":');",
		);
		await expect(
			runOneironWriterForeground(argv, f.directory, f.options.stdoutPath, {
				CAPTURE_FIXTURE_EXPLICIT: "explicit-local-value",
				GIT_OPTIONAL_LOCKS: "1",
			}),
		).resolves.toBeUndefined();
		expect(readFileSync(f.options.stdoutPath, "utf8")).toBe('inherited-local-value:explicit-local-value:0: {"type":');
		expect(() => statSync(f.options.stderrPath)).toThrow(/ENOENT/);
	});
	test("throws synchronously rather than overwriting a retained writer transcript", () => {
		const f = setup();
		writeFileSync(f.options.stdoutPath, "retained writer transcript");
		expect(() => runOneironWriterForeground(command(""), f.directory, f.options.stdoutPath)).toThrow(/EEXIST/);
		expect(readFileSync(f.options.stdoutPath, "utf8")).toBe("retained writer transcript");
	});
	test.each(["nonzero", "signal"] as const)("retains writer bytes while rejecting %s completion", async (failure) => {
		const f = setup();
		const raw = Buffer.from('{"type":"fixture_only"}\n');
		const argv = command(
			`fs.writeSync(1, ${JSON.stringify(raw.toString())}); ${failure === "nonzero" ? "process.exitCode = 7;" : "process.kill(process.pid, 'SIGTERM');"}`,
		);
		const capture = await rejectedCapture(() => runOneironWriterForeground(argv, f.directory, f.options.stdoutPath));
		expect(capture.failure).toMatch(/Foreground writer exited/);
		expect(capture).toMatchObject(
			failure === "nonzero" ? { exitCode: 7, signal: null } : { exitCode: null, signal: "SIGTERM" },
		);
		retained(capture.stdout, raw, 0);
		expect(capture.stderr).toBeUndefined();
	});
	test.each([false, true])(
		"keeps the 256 MiB writer transport boundary; overflow=%s",
		async (overflow) => {
			const f = setup();
			expect(ONEIRON_TRANSPORT_LIMITS.rawBytes).toBe(256 * 1024 * 1024);
			const argv = command(
				`const chunk = Buffer.alloc(1024 * 1024, 'x'); for (let i = 0; i < 256; i++) fs.writeSync(1, chunk); ${overflow ? "fs.writeSync(1, 'y');" : ""}`,
			);
			if (overflow) {
				const capture = await rejectedCapture(() =>
					runOneironWriterForeground(argv, f.directory, f.options.stdoutPath),
				);
				expect(capture.failure).toMatch(
					/rawBytes=268435457 exceeds limit=268435456.*partial log requires reconciliation/,
				);
				expect(capture.stdout).toMatchObject({
					bytes: ONEIRON_TRANSPORT_LIMITS.rawBytes,
					observedBytes: ONEIRON_TRANSPORT_LIMITS.rawBytes + 1,
					truncated: true,
					preview: "",
				});
				expect(capture.stdout.sha256).toBe(verifyOneironArtifact(f.options.stdoutPath).sha256);
			} else {
				await expect(runOneironWriterForeground(argv, f.directory, f.options.stdoutPath)).resolves.toBeUndefined();
			}
			expect(statSync(f.options.stdoutPath).size).toBe(ONEIRON_TRANSPORT_LIMITS.rawBytes);
			const hash = createHash("sha256");
			const chunk = Buffer.alloc(1024 * 1024, "x");
			for (let i = 0; i < 256; i++) hash.update(chunk);
			expect(verifyOneironArtifact(f.options.stdoutPath).sha256).toBe(hash.digest("hex"));
			expectCaptureFilesClosed();
		},
		20_000,
	);
});

describe("capture under the existing local CommandAdapter", () => {
	test("retains an interrupted snapshot while the outer runner owns group timeout", async () => {
		const f = setup();
		const signalPath = join(f.directory, "interrupted.json");
		const finalPath = join(f.directory, "capture-failure.json");
		const fixture = join(f.directory, "capture-timeout.mjs");
		const argv = command(
			"fs.writeSync(1, 'before timeout stdout'); fs.writeSync(2, 'before timeout stderr'); setInterval(() => {}, 1000);",
		);
		writeFileSync(
			fixture,
			`import { writeFileSync } from 'node:fs';
import { runOneironCapture } from ${JSON.stringify(resolve("src/factory/adapters/oneiron-capture.ts"))};
try { await runOneironCapture(${JSON.stringify(argv)}, ${JSON.stringify(f.directory)}, ${JSON.stringify({ ...f.options, signalPath })}); }
catch (error) { writeFileSync(${JSON.stringify(finalPath)}, JSON.stringify(error.capture), { flag: 'wx' }); process.exitCode = 1; }`,
		);
		const host = { type: "local" as const, runnerRoot: join(f.directory, "attempts") };
		const context: CommandContext = {
			attempt: {
				id: "capture-timeout",
				actionId: "capture",
				slotId: "local",
				state: "SUBMITTED",
				createdAt: new Date().toISOString(),
				submittedAt: new Date().toISOString(),
				processIdentity: null,
				receipt: null,
				uncertainty: null,
				claimReleased: false,
			},
			action: {
				id: "capture",
				ticketId: "capture-fixture",
				kind: "process",
				dependencies: [],
				sourceFingerprint: "opaque:capture-fixture",
				requirements: {},
				state: "RUNNING",
				command: {
					argv: [process.execPath, "--import", resolve("../../node_modules/tsx/dist/loader.mjs"), fixture],
					cwd: f.directory,
					timeoutMs: 1500,
				},
			},
			slot: { id: "local", host: "local" },
		};
		const adapter = new CommandAdapter({ local: host });
		let cleanupError: unknown;
		try {
			await adapter.launch(context);
			await vi.waitFor(
				async () => {
					const result = await adapter.inspect(context);
					expect(result.kind).toBe("terminal");
					if (result.kind === "terminal") expect(result.receipt.exitCode).toBe(124);
				},
				{ timeout: 10_000, interval: 40 },
			);
			const interrupted = JSON.parse(readFileSync(signalPath, "utf8")) as {
				status: string;
				signal: string;
				failure: string;
				streams: CapturedStream[];
			};
			expect(interrupted).toMatchObject({ status: "INTERRUPTED", signal: "SIGTERM" });
			expect(interrupted.failure).toMatch(/outer SIGTERM/);
			expect(interrupted.streams).toHaveLength(2);
			retained(interrupted.streams[0]!, Buffer.from("before timeout stdout"));
			retained(interrupted.streams[1]!, Buffer.from("before timeout stderr"));
			expect(statSync(signalPath).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(finalPath, "utf8"))).toMatchObject({
				failure: interrupted.failure,
				stdout: interrupted.streams[0],
				stderr: interrupted.streams[1],
			});
		} finally {
			const childPath = join(host.runnerRoot, context.attempt.id, "child.json");
			if (existsSync(childPath)) {
				const child = JSON.parse(readFileSync(childPath, "utf8")) as { pid: number };
				if (Number.isInteger(child.pid) && child.pid > 1) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = error;
					}
				}
			}
		}
		expect(cleanupError).toBeUndefined();
	}, 15_000);
});
