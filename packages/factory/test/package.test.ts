import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, inject, it } from "vitest";
import { FACTORY_HELP } from "../src/help.js";
import {
	type FactoryRuntimeIdentity,
	factoryCargoBinDirectory,
	locateFactoryEntrypoint,
	recordFactoryRuntime,
} from "../src/runtime.js";

const packageRoot = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8")) as {
	bin: Record<string, string>;
	files: string[];
	dependencies?: Record<string, string>;
};
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const executable = (path: string) => (statSync(path).mode & 0o111) === 0o111;

it("builds an executable entry and the cargo wrapper beside the modules, with no runtime dependency", () => {
	const dist = inject("factoryDist");
	const entry = join(dist, "cli-entry.js");
	expect(manifest.bin).toEqual({ "prime-agent-factory": "dist/cli-entry.js" });
	expect(manifest.dependencies).toBeUndefined();
	expect([executable(entry), readFileSync(entry, "utf8").startsWith("#!/usr/bin/env node\n")]).toEqual([true, true]);
	// The bin runs directly, without node on the command line, and help needs no factory state.
	expect(execFileSync(entry, ["help"], { encoding: "utf8" })).toBe(`${FACTORY_HELP}\n`);
	const cargo = join(dist, "bin", "cargo");
	expect([executable(cargo), readFileSync(cargo, "utf8")]).toEqual([
		true,
		readFileSync(new URL("src/bin/cargo", packageRoot), "utf8"),
	]);
	const runtime = pathToFileURL(join(dist, "runtime.js")).href;
	expect([locateFactoryEntrypoint(runtime).entry, factoryCargoBinDirectory(runtime)]).toEqual([
		entry,
		join(dist, "bin"),
	]);
	for (const shipped of ["dist", "assets", "README.md", "LICENSE"]) expect(manifest.files).toContain(shipped);
	expect(readFileSync(new URL("assets/factory-exception-watchdog@.service", packageRoot), "utf8")).toContain(
		"ExecStart=/usr/bin/env node ${WATCHDOG_SCRIPT} --factory ${FACTORY_DIR} --session ${OWNER_SESSION}",
	);
});

it("pins the factory's own entry and modules, not the agent binary", () => {
	const dist = inject("factoryDist");
	const directory = mkdtempSync(join(tmpdir(), "factory-pin-"));
	roots.push(directory);
	const pin = recordFactoryRuntime(
		directory,
		"runtime.json",
		locateFactoryEntrypoint(pathToFileURL(join(dist, "runtime.js")).href),
	);
	const identity = JSON.parse(readFileSync(pin.path, "utf8")) as FactoryRuntimeIdentity;
	const paths = identity.files.map((file) => file.path);
	expect([identity.version, identity.factoryArgv]).toEqual([2, [process.execPath, join(dist, "cli-entry.js")]]);
	expect(paths).toEqual(expect.arrayContaining([process.execPath, join(dist, "cli-entry.js"), join(dist, "adapters", "oneiron-ticket.js")]));
	expect(paths.every((path) => path === process.execPath || path.startsWith(`${dist}/`))).toBe(true);
});
