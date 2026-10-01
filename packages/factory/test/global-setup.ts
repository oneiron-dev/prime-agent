import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		/** The package as `npm run build` ships it, in a temporary directory: dist/ modules plus bin/cargo. */
		factoryDist: string;
	}
}

/** Build the package once for the whole run; CLI and process tests execute these modules, not the sources. */
export default function setup(project: TestProject): () => void {
	const root = mkdtempSync(join(tmpdir(), "factory-dist-"));
	const dist = join(root, "dist");
	execFileSync(process.execPath, [resolve(import.meta.dirname, "..", "scripts", "build.mjs"), dist], {
		stdio: "inherit",
	});
	project.provide("factoryDist", dist);
	return () => rmSync(root, { recursive: true, force: true });
}
