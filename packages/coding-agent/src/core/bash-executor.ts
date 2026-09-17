/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../utils/shell.js";
import type { BashOperations } from "./tools/bash.js";
import { OutputSpill } from "./tools/output-accumulator.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";
export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Hard ceiling in seconds for this command. Omitted means no executor-imposed cap. */
	timeout?: number;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the command was killed by its hard deadline */
	timedOut?: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}
/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	const spill = new OutputSpill("pi-bash");
	let totalBytes = 0;

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");
		if (totalBytes > DEFAULT_MAX_BYTES) {
			spill.open(outputChunks);
		}

		spill.write(text);
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
			timeout: options?.timeout,
		});

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		if (truncationResult.truncated) {
			spill.open(outputChunks);
		}
		// Settled before advertising: the path refers to the COMPLETE file or is undefined.
		const fullOutputPath = await spill.finalize();
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath,
		};
	} catch (err) {
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				spill.open(outputChunks);
			}
			const fullOutputPath = await spill.finalize();
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath,
			};
		}

		if (err instanceof Error && err.message.startsWith("timeout:")) {
			const timeoutSeconds = err.message.slice("timeout:".length);
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				spill.open(outputChunks);
			}
			const fullOutputPath = await spill.finalize();
			const output = truncationResult.truncated ? truncationResult.content : fullOutput;
			const notice = `Command timed out after ${timeoutSeconds} seconds and its process tree was killed. MUST NOT be retried unchanged; decompose or rewrite it into bounded phases that report progress.`;
			return {
				output: output ? `${output}\n${notice}` : notice,
				exitCode: undefined,
				cancelled: false,
				timedOut: true,
				truncated: truncationResult.truncated,
				fullOutputPath,
			};
		}

		await spill.finalize();

		throw err;
	}
}
