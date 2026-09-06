import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeFileSync, writeSync } from "node:fs";

export interface CapturedStream {
	path: string;
	sha256: string;
	bytes: number;
	observedBytes: number;
	truncated: boolean;
	preview: string;
}
export interface ForegroundCapture {
	argv: string[];
	cwd: string;
	environment: Record<string, string>;
	startedAt: string;
	finishedAt: string;
	exitCode: number | null;
	signal: string | null;
	stdout: CapturedStream;
	stderr?: CapturedStream;
	failure?: string;
}
export interface CaptureOptions {
	stdoutPath: string;
	stderrPath?: string;
	limitBytes: number;
	previewBytes?: number;
	environment?: Record<string, string>;
	/** Gate environments are complete; writer environments retain their existing inheritance. */
	replaceEnvironment?: boolean;
	label: string;
	/** Gate-only interrupted snapshot. Outer runner still owns timeout and process-group cleanup. */
	signalPath?: string;
}
export class ForegroundCaptureError extends Error {
	constructor(public readonly capture: ForegroundCapture) {
		super(capture.failure ?? `Foreground ${capture.signal ?? capture.exitCode}`);
	}
}
/** Inherits the outer CommandAdapter process group. Never detaches or assumes timeout/group ownership. */
export function runOneironCapture(argv: string[], cwd: string, options: CaptureOptions): Promise<ForegroundCapture> {
	const streams: Array<{
		fd: number;
		record: CapturedStream;
		hash: ReturnType<typeof createHash>;
		preview: Buffer;
		writeFailed: boolean;
	}> = [];
	try {
		for (const path of [options.stdoutPath, options.stderrPath].filter((p): p is string => p !== undefined)) {
			streams.push({
				fd: openSync(path, "wx", 0o600),
				record: { path, sha256: "", bytes: 0, observedBytes: 0, truncated: false, preview: "" },
				hash: createHash("sha256"),
				preview: Buffer.alloc(0),
				writeFailed: false,
			});
		}
	} catch (error) {
		for (const stream of streams) closeSync(stream.fd);
		throw error;
	}
	const environment = {
		...(options.replaceEnvironment ? {} : process.env),
		...options.environment,
		GIT_OPTIONAL_LOCKS: "0",
	};
	const startedAt = new Date().toISOString();
	return new Promise((resolve, reject) => {
		let failure: string | undefined;
		let removeSignalListeners = () => {};
		const previewText = (buffer: Buffer) => {
			const chars = [...buffer.toString("utf8")];
			while (Buffer.byteLength(chars.join("")) > (options.previewBytes ?? 0)) chars.pop();
			return chars.join("");
		};
		const finish = (code: number | null, signal: string | null) => {
			removeSignalListeners();
			for (const stream of streams) {
				try {
					fsyncSync(stream.fd);
				} catch (error) {
					failure ??= String(error);
				}
				try {
					closeSync(stream.fd);
				} catch (error) {
					failure ??= String(error);
				}
				stream.record.sha256 = stream.hash.digest("hex");
				stream.record.preview = previewText(stream.preview);
			}
			if (code !== 0) failure ??= `Foreground ${options.label} exited ${code ?? signal}; retain log and reconcile`;
			const capture: ForegroundCapture = {
				argv,
				cwd,
				environment: options.environment ?? {},
				startedAt,
				finishedAt: new Date().toISOString(),
				exitCode: code,
				signal,
				stdout: streams[0]!.record,
				...(streams[1] ? { stderr: streams[1].record } : {}),
				...(failure ? { failure } : {}),
			};
			if (failure) reject(new ForegroundCaptureError(capture));
			else resolve(capture);
		};
		try {
			const child = spawn(argv[0]!, argv.slice(1), {
				cwd,
				detached: false,
				stdio: ["ignore", "pipe", options.stderrPath ? "pipe" : "inherit"],
				env: environment,
			});
			const stop = (error: unknown) => {
				failure ??= error instanceof Error ? error.message : String(error);
				// Keep draining both pipes. Prefix limits still apply. The outer runner kills any surviving descendants.
				child.kill("SIGTERM");
			};
			if (options.signalPath) {
				const interrupt = (signal: string) => {
					stop(new Error(`Gate interrupted by outer ${signal}; retain custody`));
					try {
						for (const stream of streams) fsyncSync(stream.fd);
						writeFileSync(
							options.signalPath!,
							`${JSON.stringify({ argv, cwd, startedAt, interruptedAt: new Date().toISOString(), signal, status: "INTERRUPTED", failure, streams: streams.map((stream) => ({ ...stream.record, sha256: stream.hash.copy().digest("hex"), preview: previewText(stream.preview) })) })}\n`,
							{ flag: "wx", mode: 0o600, flush: true },
						);
					} catch (error) {
						failure ??= String(error);
					}
				};
				const term = () => interrupt("SIGTERM"),
					int = () => interrupt("SIGINT");
				process.once("SIGTERM", term);
				process.once("SIGINT", int);
				removeSignalListeners = () => {
					process.removeListener("SIGTERM", term);
					process.removeListener("SIGINT", int);
				};
			}
			[child.stdout, child.stderr].forEach((pipe, index) => {
				const stream = streams[index];
				if (!pipe || !stream) return;
				pipe.on("data", (chunk: Buffer) => {
					stream.record.observedBytes += chunk.length;
					if (stream.writeFailed) return;
					const size = Math.min(chunk.length, options.limitBytes - stream.record.bytes);
					try {
						let written = 0;
						while (written < size) {
							const n = writeSync(stream.fd, chunk, written, size - written);
							if (n <= 0) throw new Error("Capture write made no progress");
							const part = chunk.subarray(written, written + n);
							stream.hash.update(part);
							const remaining = Math.max(0, (options.previewBytes ?? 0) - stream.preview.length);
							if (remaining) stream.preview = Buffer.concat([stream.preview, part.subarray(0, remaining)]);
							stream.record.bytes += n;
							written += n;
						}
						if (size < chunk.length) {
							stream.record.truncated = true;
							stop(
								new Error(
									`${options.label} ${index === 0 ? "stdout" : "stderr"} rawBytes=${stream.record.observedBytes} exceeds limit=${options.limitBytes}; retained partial log requires reconciliation`,
								),
							);
						}
					} catch (error) {
						stream.writeFailed = true;
						stream.record.truncated = true;
						stop(error);
					}
				});
				pipe.on("error", stop);
			});
			child.on("error", (error) => {
				failure ??= error.message;
			});
			child.on("close", finish);
		} catch (error) {
			failure = String(error);
			finish(null, null);
		}
	});
}
