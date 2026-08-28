import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildRestoreCode,
	buildSnapshotCode,
	DEFAULT_SNAPSHOT_MAX_BYTES,
	DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
	manifestPathIn,
	parseRestoreResult,
	parseSnapshotResult,
	snapshotPathIn,
} from "../src/core/kernel/state-snapshot.js";

const MARKER = "__PRIME_AGENT_KERNEL_STATE__";
const PYTHON = process.env.PRIME_AGENT_TEST_PYTHON ?? "python3";
const pythonHasDill = spawnSync(PYTHON, ["-c", "import dill"], { stdio: "ignore" }).status === 0;

describe("kernel state snapshot paths", () => {
	it("places snapshot + manifest inside the session artifact directory", () => {
		const artifactDir = "/home/u/.prime/agent/session-artifacts/abc-123";
		expect(snapshotPathIn(artifactDir)).toBe(join(artifactDir, "kernel-state.dill"));
		expect(manifestPathIn(artifactDir)).toBe(join(artifactDir, "kernel-state.json"));
	});
});

describe("parseSnapshotResult", () => {
	it("parses a valid marker line", () => {
		const stdout = `${MARKER}${JSON.stringify({
			saved: ["x", "y"],
			skipped: [{ name: "sock", reason: "TypeError: cannot pickle" }],
			pruned: ["large_text"],
			bytes: 1234,
		})}\n`;
		const result = parseSnapshotResult(stdout, "/tmp/s.dill");
		expect(result).toEqual({
			saved: ["x", "y"],
			skipped: [{ name: "sock", reason: "TypeError: cannot pickle" }],
			pruned: ["large_text"],
			bytes: 1234,
			path: "/tmp/s.dill",
		});
	});

	it("ignores stdout printed before the marker line", () => {
		const stdout = `some earlier print output\n${MARKER}${JSON.stringify({ saved: ["a"], skipped: [], bytes: 7 })}`;
		expect(parseSnapshotResult(stdout, "/tmp/s.dill")?.saved).toEqual(["a"]);
	});

	it("returns null when the marker is absent", () => {
		expect(parseSnapshotResult("no marker here", "/tmp/s.dill")).toBeNull();
	});

	it("returns null when the payload reports an error", () => {
		const stdout = `${MARKER}${JSON.stringify({ error: "dill unavailable" })}`;
		expect(parseSnapshotResult(stdout, "/tmp/s.dill")).toBeNull();
	});

	it("returns null on malformed JSON", () => {
		expect(parseSnapshotResult(`${MARKER}{not json`, "/tmp/s.dill")).toBeNull();
	});

	it("tolerates missing fields", () => {
		const result = parseSnapshotResult(`${MARKER}{}`, "/tmp/s.dill");
		expect(result).toEqual({ saved: [], skipped: [], bytes: 0, path: "/tmp/s.dill" });
	});
});

describe("parseRestoreResult", () => {
	it("parses restored and failed names", () => {
		const stdout = `${MARKER}${JSON.stringify({
			restored: ["df", "model"],
			failed: [{ name: "conn", reason: "TypeError" }],
		})}`;
		expect(parseRestoreResult(stdout, "/tmp/s.dill")).toEqual({
			restored: ["df", "model"],
			failed: [{ name: "conn", reason: "TypeError" }],
			path: "/tmp/s.dill",
		});
	});

	it("returns null when the marker is absent", () => {
		expect(parseRestoreResult("", "/tmp/s.dill")).toBeNull();
	});

	it("returns null when the payload reports an error", () => {
		expect(parseRestoreResult(`${MARKER}${JSON.stringify({ error: "load failed" })}`, "/tmp/s.dill")).toBeNull();
	});
});

describe("buildSnapshotCode", () => {
	const code = buildSnapshotCode("/state/sess.dill", "/state/sess.json", DEFAULT_SNAPSHOT_MAX_BYTES);

	it("embeds the output, manifest paths, and the byte cap", () => {
		expect(code).toContain('"/state/sess.dill"');
		expect(code).toContain('"/state/sess.json"');
		expect(code).toContain(String(DEFAULT_SNAPSHOT_MAX_BYTES));
		expect(code).toContain(String(DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES));
	});

	it("uses dill, an atomic write, and rejects file-handle reducers", () => {
		expect(code).toContain("import dill");
		expect(code).toContain("os.replace");
		expect(code).toContain("except _b.KeyboardInterrupt");
		expect(code).toContain("io.IOBase");
		expect(code).toContain('b"_create_filehandle"');
		expect(code).toContain('"rlm"');
		expect(code).toContain(`print(${JSON.stringify(MARKER)}`);
	});
});

describe("buildRestoreCode", () => {
	const code = buildRestoreCode("/state/sess.dill");

	it("embeds the input path and rejects legacy file handles before dill.loads", () => {
		expect(code).toContain('"/state/sess.dill"');
		expect(code).toContain("os.path.exists");
		expect(code).toContain('b"_create_filehandle"');
		expect(code.indexOf('b"_create_filehandle"')).toBeLessThan(code.indexOf("dill.loads"));
	});
});

describe.skipIf(!pythonHasDill)("file-handle snapshot safety regression", () => {
	it("skips and purges a closed write handle without changing its target", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-snapshot-handle-"));
		try {
			const target = join(dir, "durable.txt");
			const snapshot = join(dir, "kernel-state.dill");
			const manifest = join(dir, "kernel-state.json");
			const python = `
f = open(${JSON.stringify(target)}, "w")
f.write("SURVIVE")
f.close()
safe_value = 42
${buildSnapshotCode(snapshot, manifest, DEFAULT_SNAPSHOT_MAX_BYTES)}
`;
			const stdout = execFileSync(PYTHON, ["-c", python], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
			const result = parseSnapshotResult(stdout, snapshot);
			expect(result?.saved).toContain("safe_value");
			expect(result?.saved).not.toContain("f");
			expect(result?.skipped).toContainEqual({ name: "f", reason: "unsafe file handle (io.IOBase)" });
			expect(readFileSync(target, "utf8")).toBe("SURVIVE");
			const manifestData = JSON.parse(readFileSync(manifest, "utf8"));
			expect(manifestData.version).toBe(2);
			expect(manifestData.purgedFileHandles).toEqual(["f"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a legacy closed write-handle blob before it can truncate", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-restore-handle-"));
		try {
			const target = join(dir, "durable.txt");
			const snapshot = join(dir, "kernel-state.dill");
			writeFileSync(target, "SURVIVE");
			const setup = `
import dill
from pathlib import Path
_target = Path(${JSON.stringify(target)})
_legacy = open(_target, "w")
_legacy.close()
_target.write_text("SURVIVE")
with open(${JSON.stringify(snapshot)}, "wb") as _fh:
    dill.dump({"legacy_write": dill.dumps(_legacy), "safe_value": dill.dumps(42)}, _fh)
${buildRestoreCode(snapshot)}
`;
			const stdout = execFileSync(PYTHON, ["-c", setup], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
			const result = parseRestoreResult(stdout, snapshot);
			expect(result?.restored).toEqual(["safe_value"]);
			expect(result?.failed).toContainEqual({
				name: "legacy_write",
				reason: "unsafe legacy dill file-handle reducer rejected",
			});
			expect(readFileSync(target, "utf8")).toBe("SURVIVE");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
