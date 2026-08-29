import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const verifier = join(import.meta.dirname, "..", "scripts", "verify-bundled-state-snapshot.mjs");
const marker = "// dist/core/kernel/state-snapshot.js";

function patchedSection(): string {
	return `${marker}
import builtins as _b, io, json, os, sys, datetime, pickletools
if _b.isinstance(value, io.IOBase):
b"_create_filehandle"
"version": 2
"purgedFileHandles": _b.sorted(unsafe_handles)
unsafe legacy dill file-handle reducer rejected
dill.loads(blob)
// dist/core/prompt-admission.js
`;
}

describe("production bundle state-snapshot guard", () => {
	it("accepts a bundle containing the v2 file-handle protections", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-bundle-snapshot-v2-"));
		try {
			writeFileSync(join(dir, "chunk-v2.js"), patchedSection());
			expect(() => execFileSync(process.execPath, [verifier, dir], { encoding: "utf8" })).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects the legacy v1 helper used by the production CLI", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-bundle-snapshot-v1-"));
		try {
			writeFileSync(
				join(dir, "chunk-v1.js"),
				`${marker}
import builtins as _b, io, json, os, sys, datetime
"version": 1
dill.loads(blob)
`,
			);
			const result = spawnSync(process.execPath, [verifier, dir], { encoding: "utf8" });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("missing required marker");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
