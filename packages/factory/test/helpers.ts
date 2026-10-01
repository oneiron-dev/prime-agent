import { existsSync, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import type { CommandAdapter, CommandContext } from "../src/adapters/command.js";
import type { CompletionReceipt } from "../src/types.js";

/**
 * Resolves once `path` is ready: by default once it exists, which suits files published atomically (written
 * elsewhere, then renamed). Readiness comes from a filesystem watch on its directory, which must already exist; the
 * check after the watch starts closes the race with a change made in between.
 */
export function fileReady(path: string, ready: (path: string) => boolean = existsSync): Promise<void> {
	return new Promise((resolveReady, rejectReady) => {
		const watcher = watch(dirname(path), () => {
			if (!ready(path)) return;
			watcher.close();
			resolveReady();
		});
		watcher.on("error", (error) => {
			watcher.close();
			rejectReady(error);
		});
		if (ready(path)) {
			watcher.close();
			resolveReady();
		}
	});
}

/** For appended JSON lines: ready once the file holds at least one complete line. */
export function holdsLine(path: string): boolean {
	return existsSync(path) && readFileSync(path, "utf8").includes("\n");
}

/** The receipt of a launched attempt: wait for the runner to publish terminal.json, then inspect once. */
export async function terminalReceipt(
	adapter: CommandAdapter,
	context: CommandContext,
	runnerRoot: string,
): Promise<CompletionReceipt> {
	await fileReady(join(runnerRoot, context.attempt.id, "terminal.json"));
	const inspection = await adapter.inspect(context);
	expect(inspection.kind).toBe("terminal");
	if (inspection.kind !== "terminal") throw new Error(`Attempt ${context.attempt.id} is ${inspection.kind}`);
	return inspection.receipt;
}

/**
 * A job body for `node -e`: it appends `x` to `marker`, publishes its pid to `pidFile` and holds until SIGUSR1,
 * then prints `finished` and exits 0. A filesystem watch on the `hold` directory keeps it alive without any timer;
 * removing that directory (the test's cleanup) ends it too.
 */
export function gatedJob(marker: string, pidFile: string, hold: string): string {
	return [
		"const fs = require('node:fs');",
		`fs.appendFileSync(${JSON.stringify(marker)}, 'x');`,
		`const keep = fs.watch(${JSON.stringify(hold)}, () => { if (!fs.existsSync(${JSON.stringify(hold)})) keep.close(); });`,
		"process.on('SIGUSR1', () => { keep.close(); console.log('finished'); });",
		`fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));`,
		`fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});`,
	].join(" ");
}
