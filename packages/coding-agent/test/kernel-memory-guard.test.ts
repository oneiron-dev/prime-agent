import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKernelVenvDir, kernelVenvPython } from "../src/core/kernel/bootstrap.js";
import { type ExecuteResult, ReplKernelManager } from "../src/core/kernel/index.js";
import {
	decideMemorySteps,
	indexChildren,
	type KernelTreeUsage,
	kernelMemoryGuard,
	type LadderState,
	MEMORY_LIMIT_REASON,
	measureKernelTree,
	memoryChildMessage,
	memoryKillMessage,
	memoryTrimMessage,
	memoryWarningMessage,
	type ProcessRow,
	parseDarwinSample,
	parseLinuxMeminfoCritical,
	parseLinuxStat,
	parseLinuxStatusBytes,
	platformMemoryReader,
	resolveKernelMemoryLimitGb,
} from "../src/core/kernel/memory-guard.js";

describe("kernel memory guard", () => {
	it("parses the Linux /proc files and the macOS sampler output", () => {
		expect(parseLinuxStat("4242 (py thon (x)) S 17 4200 4200 0 -1 4194560")).toEqual({
			pid: 4242,
			ppid: 17,
			pgid: 4200,
			name: "py thon (x)",
		});
		expect(parseLinuxStatusBytes("Name:\tpython3\nVmRSS:\t    1024 kB\nVmSwap:\t     512 kB\n")).toBe(1536 * 1024);
		expect(parseLinuxMeminfoCritical("MemTotal: 1000 kB\nMemAvailable: 50 kB\n")).toBe(true);
		expect(parseLinuxMeminfoCritical("MemTotal: 1000 kB\nMemAvailable: 51 kB\n")).toBe(false);
		const sample = parseDarwinSample(
			"pressure 1 42\n100\t1\t100\t2048\tnode\n200\t100\t100\t4096\tpython3.11\nbroken\n",
		);
		expect(sample.critical).toBe(false);
		expect([...sample.rows.values()]).toEqual([
			{ pid: 100, ppid: 1, pgid: 100, bytes: 2048, name: "node" },
			{ pid: 200, ppid: 100, pgid: 100, bytes: 4096, name: "python3.11" },
		]);
		expect(parseDarwinSample("pressure 4 30\n").critical).toBe(true);
		expect(parseDarwinSample("pressure 2 10\n").critical).toBe(true);
	});

	it("measures the kernel, its descendants and its reparented bash groups as stoppable units", () => {
		const rows: ProcessRow[] = [
			{ pid: 10, ppid: 1, pgid: 10, name: "node", bytes: 500 },
			{ pid: 20, ppid: 10, pgid: 10, name: "python", bytes: 100 },
			{ pid: 30, ppid: 20, pgid: 30, name: "bash", bytes: 5 },
			{ pid: 31, ppid: 30, pgid: 30, name: "python3", bytes: 900 },
			{ pid: 40, ppid: 20, pgid: 10, name: "python3", bytes: 50 },
			{ pid: 41, ppid: 40, pgid: 10, name: "sort", bytes: 60 },
			{ pid: 51, ppid: 1, pgid: 50, name: "orphan", bytes: 70 },
			{ pid: 60, ppid: 1, pgid: 60, name: "stranger", bytes: 999 },
			{ pid: 61, ppid: 60, pgid: 60, name: "stranger", bytes: 999 },
		];
		const table = {
			rows: new Map(rows.map((row) => [row.pid, row])),
			critical: false,
			bytesOf: (pid: number) => rows.find((row) => row.pid === pid)?.bytes ?? 0,
		};
		const usage = measureKernelTree(table, indexChildren(table.rows), 20, new Set([30, 50, 60]), 10);
		expect(usage).toEqual({
			kernelPid: 20,
			kernelBytes: 100,
			totalBytes: 1185,
			units: [
				{ pgid: 30, pids: [30, 31], bytes: 905, pid: 31, name: "python3" },
				{ pids: [40, 41], bytes: 110, pid: 41, name: "sort" },
				{ pgid: 50, pids: [51], bytes: 70, pid: 51, name: "orphan" },
			],
		});
	});

	it("walks the ladder: warn once per crossing, child first, trim, then end the kernel", () => {
		const limit = 1000;
		const tree = (kernelBytes: number, childBytes = 0): KernelTreeUsage => ({
			kernelPid: 1,
			kernelBytes,
			totalBytes: kernelBytes + childBytes,
			units: childBytes ? [{ pgid: 2, pids: [2], bytes: childBytes, pid: 2, name: "python3" }] : [],
		});
		const state: LadderState = { warnArmed: true };
		const kinds = (usage: KernelTreeUsage, now: number, machine = false) =>
			decideMemorySteps(usage, limit, state, now, machine).map((step) => ("cause" in step ? step.cause : step.kind));
		expect(kinds(tree(599), 0)).toEqual([]);
		expect(kinds(tree(600), 0)).toEqual(["warn"]);
		expect(kinds(tree(700), 0)).toEqual([]);
		expect(kinds(tree(500), 0)).toEqual([]);
		expect(kinds(tree(650), 0)).toEqual(["warn"]);
		expect(kinds(tree(300, 900), 0)).toEqual(["child"]);
		expect(decideMemorySteps(tree(1100), limit, state, 1000)).toEqual([{ kind: "trim", targetBytes: 500 }]);
		expect(kinds(tree(1100), 10_999)).toEqual([]);
		expect(kinds(tree(1100), 11_000)).toEqual(["grace"]);
		expect(kinds(tree(900), 11_000)).toEqual([]);
		expect(kinds(tree(1100), 12_000)).toEqual(["trim"]);
		expect(kinds(tree(1600), 12_000)).toEqual(["hard"]);
		expect(kinds(tree(400, 1200), 12_000)).toEqual(["child"]);
		expect(kinds(tree(300), 12_000, true)).toEqual(["machine"]);
		expect(kinds(tree(100, 200), 12_000, true)).toEqual(["child"]);
	});

	it.each([
		[
			"warning",
			memoryWarningMessage(0.35 * 2 ** 30, 2 ** 29, [{ name: "data", bytes: 0.34 * 2 ** 30, type: "bytes" }]),
		],
		["child", memoryChildMessage({ name: "python3", pid: 7, bytes: 2 ** 30 }, 2 ** 30, 2 ** 29, false)],
		["variable", memoryTrimMessage(2 ** 30, 2 ** 29, [{ name: "big", bytes: 2 ** 30, type: "list" }], true)],
		["variable, nothing large", memoryTrimMessage(2 ** 30, 2 ** 29, [], true)],
		["last", memoryKillMessage(2 ** 30, 2 ** 29, "grace")],
		["hard", memoryKillMessage(2 ** 30, 2 ** 29, "hard")],
		["machine child", memoryChildMessage({ name: "python3", pid: 7, bytes: 2 ** 28 }, 2 ** 28, 2 ** 29, true)],
		["machine kernel", memoryKillMessage(2 ** 28, 2 ** 29, "machine")],
	])("the %s message says why and what next", (kind, message) => {
		expect(message).toContain(MEMORY_LIMIT_REASON);
		expect(message).toMatch(kind.startsWith("machine") ? /^The machine is nearly out of memory/ : /^Memory/);
		expect(message).toMatch(kind === "warning" ? /Free what you no longer need/ : /Next: /);
	});

	it("resolves the limit from settings, then the environment, then 16 GB", () => {
		const saved = process.env.PRIME_AGENT_KERNEL_MEMORY_LIMIT_GB;
		try {
			process.env.PRIME_AGENT_KERNEL_MEMORY_LIMIT_GB = "2";
			expect([resolveKernelMemoryLimitGb(0), resolveKernelMemoryLimitGb(), resolveKernelMemoryLimitGb(-1)]).toEqual([
				0, 2, 2,
			]);
			delete process.env.PRIME_AGENT_KERNEL_MEMORY_LIMIT_GB;
			expect(resolveKernelMemoryLimitGb()).toBe(16);
		} finally {
			if (saved === undefined) delete process.env.PRIME_AGENT_KERNEL_MEMORY_LIMIT_GB;
			else process.env.PRIME_AGENT_KERNEL_MEMORY_LIMIT_GB = saved;
		}
	});
});

// The worktree's runtime on the shared kernel interpreter: nothing is installed into the kernel venv.
const python = process.env.PRIME_AGENT_KERNEL_PYTHON ?? kernelVenvPython(getKernelVenvDir());
const runtimeSrc = resolve(__dirname, "..", "..", "..", "prime-agent-runtime", "src");

describe("kernel memory ladder (real runtime, 0.5 GB limit)", { tags: ["kernel-heavy"] }, () => {
	let dir = "";
	let manager: ReplKernelManager | undefined;
	let fifoCount = 0;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-memcap-"));
	});

	afterEach(async () => {
		await manager?.shutdown();
		manager = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	function start(memoryLimitGb = 0.5): ReplKernelManager {
		manager = new ReplKernelManager({
			python,
			cwd: dir,
			env: { PYTHONPATH: runtimeSrc },
			memoryLimitGb,
			memoryBackstop: false,
		});
		return manager;
	}

	function fifo(): string {
		const path = join(dir, `fifo-${fifoCount++}`);
		execFileSync("mkfifo", [path]);
		return path;
	}

	/** Run code that opens READY once it holds its memory, then measure while it is parked on RELEASE. */
	async function runMeasured(code: string, release: boolean): Promise<ExecuteResult> {
		const ready = fifo();
		const parked = fifo();
		const cell = code.replaceAll("READY", JSON.stringify(ready)).replaceAll("RELEASE", JSON.stringify(parked));
		const result = manager!.execute(cell);
		await readFile(ready);
		await kernelMemoryGuard.tick();
		if (release) await writeFile(parked, "go");
		return result;
	}

	const HOLD = 'open(READY, "w").close()\nopen(RELEASE).read()';

	it("reads this platform's process table with sizes", async () => {
		const table = await platformMemoryReader()!(python);
		expect(table.rows.get(process.pid)?.ppid).toBe(process.ppid);
		expect(table.bytesOf(process.pid)).toBeGreaterThan(16 * 2 ** 20);
	});

	it("warns once per crossing with the largest variable", async () => {
		start();
		const warned = await runMeasured(`data = b"\\x01" * (350 << 20)\n${HOLD}`, true);
		expect(warned.status).toBe("ok");
		expect(warned.memoryNotices).toHaveLength(1);
		expect(warned.memoryNotices?.[0]).toMatch(
			/^Memory: this kernel and its processes use 0\.\d+ GB of their 0\.5 GB limit\. Largest variables: data 0\.34 GB \(bytes\)/,
		);
		const again = await runMeasured(`more = 1\n${HOLD}`, true);
		expect(again.memoryNotices).toBeUndefined();
	});

	it.each([
		["limit 0 turns the ladder off", 0, `data = b"\\x01" * (350 << 20)`],
		["a normal cell under 60% is unchanged", 0.5, "x = sum(range(10))"],
	])("%s", async (_name, limit, code) => {
		start(limit);
		const result = await runMeasured(`${code}\n${HOLD}`, true);
		expect(result.status).toBe("ok");
		expect(result.memoryNotices).toBeUndefined();
		expect(manager!.memoryWatch === undefined).toBe(limit === 0);
	});

	it("stops only the child that bash started, and the bash call returns why", async () => {
		start();
		await manager!.execute("before = 41");
		const script = join(dir, "hog.py");
		writeFileSync(
			script,
			'import sys, time\ndata = b"\\x01" * (700 << 20)\nopen(sys.argv[1], "w").close()\ntime.sleep(600)\n',
		);
		const result = await runMeasured(
			`import shlex, sys\nfrom rlm import bash\nr = await bash(shlex.join([sys.executable, ${JSON.stringify(script)}, READY]))\nprint(r.exit_code)\nprint(r.output)`,
			false,
		);
		expect(result.stdout).toMatch(/^-9\n/);
		expect(result.stdout).toMatch(
			/Memory limit: python\S* \(pid \d+\), started from this kernel, used 0\.\d+ GB, above the 0\.5 GB limit/,
		);
		expect(result.stdout).toContain(MEMORY_LIMIT_REASON);
		expect((await manager!.execute("before + 1")).result).toBe("42");
	});

	it("stops the cell and drops the big variable, keeping the small one", async () => {
		start();
		await manager!.execute('small = b"\\x02" * (64 << 20)');
		const loop = `big = []\nfor _ in range(64):\n    big.append(b"\\x01" * (16 << 20))\n    if len(big) == 30:\n        ${HOLD.replace("\n", "\n        ")}`;
		const result = await runMeasured(loop, false);
		expect(result.error?.ename).toBe("KeyboardInterrupt");
		expect(result.memoryNotices?.[0]).toMatch(
			/so the runtime stopped the cell and deleted the largest variables: big \(0\.47 GB, list\)\. Every other variable is intact\./,
		);
		expect((await manager!.execute('(len(small), "big" in globals())')).result).toBe("(67108864, False)");
	});

	it("ends the kernel when the memory ignores the interrupt, and the next cell runs fresh", async () => {
		start();
		await manager!.execute("x = 1");
		const firstPid = manager!.memoryWatch?.pid;
		const masked = `import signal\nsignal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})\nbig = b"\\x01" * (820 << 20)\n${HOLD}`;
		const result = await runMeasured(masked, false);
		expect(result.status).toBe("error");
		expect(result.memoryNotices?.[0]).toMatch(
			/past the 0\.75 GB hard limit, so the runtime ended the kernel\. All Python variables are gone/,
		);
		expect((await manager!.execute('"x" in globals()')).result).toBe("False");
		expect(manager!.memoryWatch?.pid).not.toBe(firstPid);
	});
});
