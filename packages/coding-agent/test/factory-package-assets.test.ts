import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
	files: string[];
	scripts: Record<string, string>;
};
const adapterDirectory = join(packageDirectory, "src", "factory", "adapters");
const shims = readdirSync(adapterDirectory)
	.filter((name) => name.endsWith(".py"))
	.sort();
const shx = join(packageDirectory, "..", "..", "node_modules", "shx", "lib", "cli.js");

describe("factory package assets", () => {
	it("copy-assets copies Python shims without generated cache files", () => {
		expect(manifest.files).toContain("dist");
		expect(shims).toEqual(["oneiron-corpus-foreground.py", "oneiron-push-guard.py"]);
		const commands = manifest.scripts["copy-assets"]!.split(" && ").filter((command) =>
			command.includes("factory/adapters"),
		);
		expect(commands).toEqual([
			"shx mkdir -p dist/factory/adapters",
			"shx cp src/factory/adapters/*.py dist/factory/adapters/",
		]);
		const directory = mkdtempSync(join(tmpdir(), "factory-package-assets-"));
		try {
			const source = join(directory, "src", "factory", "adapters");
			mkdirSync(join(source, "__pycache__"), { recursive: true });
			writeFileSync(join(source, "__pycache__", "ignored.pyc"), "not a release asset");
			for (const shim of shims) cpSync(join(adapterDirectory, shim), join(source, shim));
			for (const command of commands) {
				execFileSync(process.execPath, [shx, ...command.split(" ").slice(1)], { cwd: directory });
			}
			const output = join(directory, "dist", "factory", "adapters");
			expect(readdirSync(output).sort()).toEqual(shims);
			for (const shim of shims) {
				expect(readFileSync(join(output, shim))).toEqual(readFileSync(join(adapterDirectory, shim)));
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("includes Python shims in standalone binary assets", () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-binary-assets-"));
		try {
			const output = join(directory, "factory", "adapters");
			mkdirSync(output, { recursive: true });
			writeFileSync(join(output, "existing.js"), "export const compiled = true;");
			const moduleUrl = pathToFileURL(join(packageDirectory, "scripts", "copy-binary-assets.mjs")).href;
			execFileSync(process.execPath, [
				"--input-type=module",
				"-e",
				`import { copyBinaryAssets, validateBinaryAssets } from ${JSON.stringify(moduleUrl)}; copyBinaryAssets(${JSON.stringify(directory)}); validateBinaryAssets(${JSON.stringify(directory)});`,
			]);
			expect(readdirSync(output).sort()).toEqual(["existing.js", ...shims].sort());
			expect(readFileSync(join(output, "existing.js"), "utf8")).toBe("export const compiled = true;");
			for (const shim of shims) {
				expect(readFileSync(join(output, shim))).toEqual(readFileSync(join(adapterDirectory, shim)));
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
