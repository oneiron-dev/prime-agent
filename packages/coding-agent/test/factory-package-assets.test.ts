import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	it.each(["copy-assets", "copy-binary-assets"])("%s copies Python shims without generated cache files", (script) => {
		expect(manifest.files).toContain("dist");
		expect(shims).toEqual(["oneiron-corpus-foreground.py", "oneiron-push-guard.py"]);
		const commands = manifest.scripts[script]!.split(" && ").filter((command) =>
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
});
