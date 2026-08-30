import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const verifier = join(import.meta.dirname, "..", "scripts", "verify-bundled-state-snapshot.mjs");
const marker = "// dist/core/kernel/state-snapshot.js";

function fixture(legacy = false): { dir: string; bundle: string } {
	const dir = mkdtempSync(join(tmpdir(), "prime-bundle-snapshot-"));
	const bundle = join(dir, "bundle");
	const runtimeDir = join(dir, "prime-agent-runtime", "src", "rlm");
	mkdirSync(bundle, { recursive: true });
	mkdirSync(runtimeDir, { recursive: true });
	writeFileSync(
		join(bundle, "chunk.js"),
		`${marker}
var DEFAULT_SNAPSHOT_MAX_BYTES = ${legacy ? "256" : "64"} * 1024 * 1024;
var DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = ${legacy ? "16" : "8"} * 1024 * 1024;
// dist/core/prompt-admission.js
`,
	);
	writeFileSync(
		join(runtimeDir, "repl.py"),
		legacy
			? `DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024
"version": 1
dill.loads(blob)
`
			: `DEFAULT_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 8 * 1024 * 1024
def _has_filehandle_reducer(blob: bytes | bytearray) -> bool:
    pass
candidate_names = stable_names + list(reversed(data_names))
isinstance(value, io.IOBase)
gc.collect()
"version": 2
"purgedFileHandles": sorted(unsafe_handles)
unsafe legacy dill file-handle reducer rejected
if _has_filehandle_reducer(blob):
    pass
dill.loads(blob)
`,
	);
	return { dir, bundle };
}

describe("production snapshot bundle guard", () => {
	it("accepts bounded JS defaults plus the protected packaged REPL", () => {
		const { dir, bundle } = fixture();
		try {
			expect(() => execFileSync(process.execPath, [verifier, bundle], { encoding: "utf8" })).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects the legacy limits and runtime", () => {
		const { dir, bundle } = fixture(true);
		try {
			const result = spawnSync(process.execPath, [verifier, bundle], { encoding: "utf8" });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("missing required marker");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
