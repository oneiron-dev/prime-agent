import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

let tempDir = "";
const managers: ReplKernelManager[] = [];

function fakeRuntime(hungType = "execute"): { python: string; requests: () => Record<string, unknown>[] } {
	const python = join(tempDir, "python");
	const journal = join(tempDir, "requests");
	writeFileSync(
		python,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
emit({event:"ready",protocol:3});
readline.createInterface({input:process.stdin}).on("line", line => {
 const request=JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(journal)}, line + "\\n");
 if(request.type==="shutdown") {emit({event:"done",id:request.id,status:"ok"});process.exit(0);}
 if(request.type===${JSON.stringify(hungType)} || request.type==="interrupt") return;
 emit({event:"done",id:request.id,status:"ok",restored:["saved_value"],failed:[]});
});
`,
	);
	chmodSync(python, 0o755);
	return {
		python,
		requests: () =>
			existsSync(journal)
				? readFileSync(journal, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [],
	};
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-kernel-deadlines-"));
});
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(managers.splice(0).map((manager) => manager.kill()));
	rmSync(tempDir, { recursive: true, force: true });
});

describe("kernel lifecycle deadlines", () => {
	it("rejects timer-overflow budgets before starting a kernel", async () => {
		const { python, requests } = fakeRuntime();
		const manager = new ReplKernelManager({ python, cwd: tempDir });
		managers.push(manager);
		await expect(manager.execute("never sent", { timeoutMs: 2_147_483_648 })).rejects.toThrow(/timer range/);
		const provisioner = new IpythonKernelProvisioner(tempDir, { python, startupStepTimeoutMs: 2_147_483_648 });
		await expect(provisioner.ensure()).rejects.toThrow(/timer range/);
		await provisioner.dispose();
		expect(requests()).toEqual([]);
	});

	it("cancels a queued request promptly without interrupting the owner or releasing its queue slot", async () => {
		const { python, requests } = fakeRuntime();
		const manager = new ReplKernelManager({ python, cwd: tempDir });
		managers.push(manager);
		const owner = manager.execute("owner");
		owner.catch(() => undefined);
		await vi.waitFor(() => expect(requests()).toHaveLength(1));
		const controller = new AbortController();
		const queued = manager.execute("cancelled", { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await expect(queued).resolves.toMatchObject({ status: "aborted" });
		const following = manager.execute("following");
		following.catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(requests()).toHaveLength(1);
		await manager.kill();
		await Promise.allSettled([owner, following]);
	});

	it("counts queue wait against a request timeout without sending or interrupting code", async () => {
		const { python, requests } = fakeRuntime();
		const manager = new ReplKernelManager({ python, cwd: tempDir });
		managers.push(manager);
		const owner = manager.execute("owner");
		owner.catch(() => undefined);
		await vi.waitFor(() => expect(requests()).toHaveLength(1));
		const queued = manager.execute("never sent", { timeoutMs: 30 });
		await expect(queued).resolves.toMatchObject({ status: "aborted" });
		expect(requests()).toHaveLength(1);
		await manager.kill();
		await Promise.allSettled([owner]);
	});

	it("bounds ordinary restore and preserves the snapshot after timeout", async () => {
		const { python, requests } = fakeRuntime("restore");
		const snapshot = join(tempDir, "state.dill");
		writeFileSync(snapshot, "untouched fixture");
		const manager = new ReplKernelManager({
			python,
			cwd: tempDir,
			snapshot: { path: snapshot, manifestPath: join(tempDir, "state.json") },
		});
		managers.push(manager);
		await manager.start();
		await expect(manager.restoreState({ timeoutMs: 30 })).resolves.toBeNull();
		await manager.shutdown({ snapshot: true });
		expect(requests().some((request) => request.type === "snapshot")).toBe(false);
		expect(readFileSync(snapshot, "utf8")).toBe("untouched fixture");
	});

	it.each(["restore", "execute"])(
		"preserves saved state and withholds readiness after a hung %s",
		async (hungType) => {
			const { python, requests } = fakeRuntime(hungType);
			const snapshotDir = join(tempDir, "snapshot");
			mkdirSync(snapshotDir);
			const snapshot = join(snapshotDir, "kernel-state.dill");
			writeFileSync(snapshot, "untouched fixture");
			const onRestore = vi.fn();
			const provisioner = new IpythonKernelProvisioner(tempDir, {
				python,
				snapshotDir,
				onRestore,
				startupStepTimeoutMs: 30,
			});
			try {
				await expect(provisioner.ensure()).rejects.toThrow(/restore|initialize/);
				expect(provisioner.manager).toBeUndefined();
				expect(provisioner.lastRestore).toBeUndefined();
				expect(onRestore).not.toHaveBeenCalled();
				expect(readFileSync(snapshot, "utf8")).toBe("untouched fixture");
				expect(requests().some((request) => request.type === "snapshot")).toBe(false);
				if (hungType === "restore") expect(requests().some((request) => request.type === "execute")).toBe(false);
			} finally {
				await provisioner.dispose();
			}
		},
	);

	it("bounds the previous-disposal gate without spawning a replacement", async () => {
		const { python, requests } = fakeRuntime();
		const provisioner = new IpythonKernelProvisioner(tempDir, {
			python,
			readyGate: new Promise(() => {}),
			startupStepTimeoutMs: 30,
		});
		try {
			await expect(provisioner.ensure()).rejects.toThrow(/previous Python kernel/);
			expect(requests()).toEqual([]);
		} finally {
			await provisioner.dispose();
		}
	});
});
