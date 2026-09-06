import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ForegroundCaptureError, runOneironCapture } from "../src/factory/adapters/oneiron-capture.js";
import { oneironInterlockPrefix } from "../src/factory/adapters/oneiron-interlock.js";
import { hashFactoryRuntimeFile } from "../src/factory/runtime.js";

const roots: string[] = [];
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(kind = "held") {
	const root = mkdtempSync(join(tmpdir(), "native-flock-"));
	roots.push(root);
	const lock = join(root, "isolated.lock"),
		path = join(root, "probe.mts");
	writeFileSync(lock, "");
	const target = kind === "alias" ? join(root, "alias.lock") : lock;
	if (kind === "alias") symlinkSync(lock, target);
	const source = resolve("src/factory/adapters/oneiron-interlock.ts");
	writeFileSync(
		path,
		`import {inspectOwnedFlock} from ${JSON.stringify(source)}; import {unlinkSync,writeFileSync} from "node:fs"; ${kind === "replace" ? `unlinkSync(${JSON.stringify(lock)});writeFileSync(${JSON.stringify(lock)},"new inode");` : ""} console.log(JSON.stringify(inspectOwnedFlock(${JSON.stringify(target)})));`,
	);
	const cli = [process.execPath, "--import", resolve("../../node_modules/tsx/dist/loader.mjs"), path];
	const argv = kind === "direct" ? cli : ["/usr/bin/flock", "--nonblock", "--no-fork", lock, ...cli];
	return {
		root,
		lock,
		argv,
		options: {
			stdoutPath: join(root, "stdout"),
			stderrPath: join(root, "stderr"),
			limitBytes: 4096,
			label: "test flock",
		},
	};
}
test("native no-fork flock exposes positive own PID/device/inode through its actual inherited FD", async () => {
	const f = fixture();
	const result = await runOneironCapture(f.argv, f.root, f.options);
	const proof = JSON.parse(readFileSync(result.stdout.path, "utf8"));
	expect(proof.pid).toBeGreaterThan(0);
	expect(proof.processIdentity).toContain(`:${proof.pid}:`);
	expect(proof.kernelRecord).toMatch(/FLOCK\s+ADVISORY\s+WRITE/);
	expect(proof.fd).toBeGreaterThanOrEqual(0);
	expect(proof.device).toMatch(/^\d+$/);
	expect(proof.inode).toMatch(/^\d+$/);
}, 10000);
test.each(["direct", "alias", "replace"])(
	"native temporary-lock %s bypass has no gate ownership proof",
	async (kind) => {
		const f = fixture(kind);
		await expect(runOneironCapture(f.argv, f.root, f.options)).rejects.toBeInstanceOf(ForegroundCaptureError);
		expect(readFileSync(f.options.stdoutPath, "utf8")).toBe("");
		expect(readFileSync(f.options.stderrPath, "utf8")).toMatch(/own-FD|alias/);
	},
	10000,
);
test("busy nonblocking temporary lock refuses the entire entry before any tool runs", async () => {
	const f = fixture();
	const holder = spawn(
		"/usr/bin/flock",
		[
			"--nonblock",
			"--no-fork",
			f.lock,
			process.execPath,
			"-e",
			'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	try {
		await new Promise<void>((resolve, reject) => {
			holder.stdout.once("data", () => resolve());
			holder.once("error", reject);
			holder.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
		});
		await expect(runOneironCapture(f.argv, f.root, f.options)).rejects.toBeInstanceOf(ForegroundCaptureError);
		expect(readFileSync(f.options.stdoutPath, "utf8")).toBe("");
	} finally {
		holder.kill("SIGTERM");
		await new Promise<void>((resolve) => holder.once("close", () => resolve()));
	}
}, 10000);
test("typed whole-entry prefix fixes Linux/Arch physical path and rejects binary/host/slot substitution", () => {
	const binary = { path: "/usr/bin/flock", sha256: hashFactoryRuntimeFile("/usr/bin/flock") };
	expect(oneironInterlockPrefix({ host: "arch", slot: 1, interlock: binary })).toEqual([
		"/usr/bin/flock",
		"--nonblock",
		"--no-fork",
		"/tmp/oneiron-wave6-cargo-slot-1.lock",
	]);
	for (const slot of [0, 5])
		expect(() => oneironInterlockPrefix({ host: "arch", slot, interlock: binary })).toThrow(/Linux/);
	expect(() => oneironInterlockPrefix({ host: "macbook", slot: 1, interlock: binary })).toThrow(/Linux/);
	expect(() =>
		oneironInterlockPrefix({ host: "arch", slot: 1, interlock: { ...binary, sha256: "0".repeat(64) } }),
	).toThrow(/binary/);
	const f = fixture();
	const alias = join(f.root, "flock");
	symlinkSync(binary.path, alias);
	expect(() => oneironInterlockPrefix({ host: "arch", slot: 1, interlock: { ...binary, path: alias } })).toThrow(
		/binary/,
	);
});
// All physical acquisitions above use isolated temporary files. No live v23 slot or production gate is touched.
