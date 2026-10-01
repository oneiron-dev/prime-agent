#!/usr/bin/env node
// Compile src/ into the given output directory and ship the executable assets beside the modules:
// bin/cargo (the build-host wrapper) keeps its executable mode, and the CLI entry gets one too.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `dist` for the package; the test suite builds into a temporary directory of its own.
const output = resolve(root, process.argv[2] ?? "dist");
if (output === root || root.startsWith(`${output}/`)) throw new Error(`Refusing to build into ${output}`);
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
rmSync(output, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json"), "--outDir", output], {
	cwd: root,
	stdio: "inherit",
});
mkdirSync(join(output, "bin"), { recursive: true });
copyFileSync(join(root, "src", "bin", "cargo"), join(output, "bin", "cargo"));
chmodSync(join(output, "bin", "cargo"), 0o755);
chmodSync(join(output, "cli-entry.js"), 0o755);
