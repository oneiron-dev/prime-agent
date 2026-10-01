import { spawn as spawnChild } from "node:child_process";
import { appendFileSync } from "node:fs";

/** The exit code the runner reports for a stream that went silent. Distinct from 124, which no longer happens. */
export const SEAT_IDLE_EXIT_CODE = 125;
/** Collected output is capped here, then trimmed to its newest half. */
const OUTPUT_LIMIT = 64 * 1024 * 1024;
/** A child that ignores SIGTERM this long after its deadline is killed. */
const KILL_GRACE_MS = 10_000;

export interface Exec {
	code: number;
	output: string;
}

export interface ProcessOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** The wall clock for network calls (gh, git). Ignored when `idleMs` is set. */
	timeoutMs: number;
	/** Silence, never a clock: every byte the child writes on stdout or stderr moves this deadline forward. */
	idleMs?: number;
	onIdle?: (idleMs: number) => void;
	/** Written to the child's stdin, then closed; without it stdin is /dev/null. */
	input?: string;
	/** Appended with the argv and the whole output once the child closed. */
	logPath?: string;
}

/** The process spawner; tests substitute a child whose streams they drive. */
export type SpawnChild = typeof spawnChild;

/**
 * One child process, its stdout and stderr collected together. gh and git get a wall clock because they are
 * network calls. A model or a build gets `idleMs` instead: work that is still producing is never interrupted, and
 * only silence ends it, reported as `SEAT_IDLE_EXIT_CODE`.
 */
export function runProcess(argv: string[], options: ProcessOptions, spawn: SpawnChild = spawnChild): Promise<Exec> {
	const { idleMs } = options;
	const deadlineMs = idleMs ?? options.timeoutMs;
	return new Promise((resolve) => {
		const child = spawn(argv[0]!, argv.slice(1), {
			cwd: options.cwd,
			env: options.env,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let output = "";
		let inputError: Error | undefined;
		if (options.input !== undefined) {
			child.stdin?.on("error", (error) => {
				inputError = error;
			});
			child.stdin?.end(options.input);
		}
		let expired = false;
		let timer: NodeJS.Timeout;
		const arm = () => {
			timer = setTimeout(() => {
				expired = true;
				if (idleMs !== undefined) options.onIdle?.(idleMs);
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
			}, deadlineMs);
		};
		arm();
		const collect = (chunk: Buffer) => {
			if (idleMs !== undefined && !expired) {
				clearTimeout(timer);
				arm();
			}
			output += chunk.toString();
			if (output.length > OUTPUT_LIMIT) output = output.slice(-OUTPUT_LIMIT / 2);
		};
		child.stdout!.on("data", collect);
		child.stderr!.on("data", collect);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: 127, output: `${output}\n${error.message}` });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (options.logPath) appendFileSync(options.logPath, `\n=== ${argv.join(" ")}\n${output}`);
			const note = idleMs === undefined ? "TIMEOUT" : `IDLE ${Math.round(idleMs / 1000)}s`;
			resolve({
				code: expired
					? idleMs === undefined
						? 124
						: SEAT_IDLE_EXIT_CODE
					: inputError
						? 127
						: (code ?? (signal ? 128 : 1)),
				output: expired ? `${output}\n${note}` : inputError ? `${output}\nstdin: ${inputError.message}` : output,
			});
		});
	});
}
