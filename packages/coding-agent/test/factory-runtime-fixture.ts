import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";
import * as runtime from "../src/factory/runtime.js";

export const fixtureRuntimePin: runtime.FactoryFilePin = { path: "/fixture/runtime.json", sha256: "0".repeat(64) };
const modulePath = fileURLToPath(new URL("../src/factory/runtime.ts", import.meta.url));
const nodePin = { path: process.execPath, sha256: runtime.hashFactoryRuntimeFile(process.execPath) };

export function createRuntimeFixture(directory: string): runtime.FactoryFilePin {
	const bundle = join(directory, "runtime-bundle");
	mkdirSync(bundle);
	const cli = join(bundle, "cli.js");
	writeFileSync(cli, "// Installed runtime fixture\n");
	const identity: runtime.FactoryRuntimeIdentity = {
		version: 1,
		cliArgv: [process.execPath, cli],
		files: [nodePin, ...[cli, modulePath].map((path) => ({ path, sha256: runtime.hashFactoryRuntimeFile(path) }))],
		capabilities: ["provider-response-model-v1", "factory-completed-json-v1"],
	};
	const path = join(directory, "runtime.json");
	writeFileSync(path, JSON.stringify(identity));
	return { path, sha256: runtime.hashFactoryRuntimeFile(path) };
}

export function admitRuntimeFixture(pin: runtime.FactoryFilePin): void {
	const identity = JSON.parse(readFileSync(pin.path, "utf8")) as runtime.FactoryRuntimeIdentity;
	const startedAt = Math.max(
		...[pin, ...identity.files].map((file) => {
			const info = statSync(file.path);
			return Math.max(info.mtimeMs, info.ctimeMs);
		}),
	);
	vi.spyOn(runtime, "factoryRuntimeProcess").mockReturnValue({
		executable: identity.cliArgv[0],
		module: identity.files.some((file) => file.path === modulePath) ? modulePath : identity.cliArgv[1],
		startedAt: Math.floor(startedAt),
	});
}

afterEach(() => vi.restoreAllMocks());
