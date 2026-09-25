// Memory ceiling for REPL kernel trees: one poll every MEMORY_POLL_INTERVAL_MS
// measures every watched kernel plus its descendants and walks the ladder
// (warn, stop the child, drop the big variables, end the kernel), with a
// machine-wide backstop. Readers: /proc on Linux (resident + swapped), libproc
// phys_footprint on macOS (compressed pages included), nothing elsewhere.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { execFileHidden } from "../../utils/child-process.js";
import { ORPHAN_PROCESS_JOURNAL_ENV, readActiveOrphanProcesses } from "../orphan-process-journal.js";

export const DEFAULT_KERNEL_MEMORY_LIMIT_GB = 16;
export const KERNEL_MEMORY_LIMIT_ENV = "PRIME_AGENT_KERNEL_MEMORY_LIMIT_GB";
export const KERNEL_MEMORY_BACKSTOP_ENV = "PRIME_AGENT_KERNEL_MEMORY_BACKSTOP";
export const GB = 1024 ** 3;
export const MEMORY_POLL_INTERVAL_MS = 2000;
export const MEMORY_WARN_FRACTION = 0.6;
export const MEMORY_HARD_LIMIT_FACTOR = 1.5;
export const MEMORY_TRIM_MIN_BYTES = 256 * 1024 ** 2;
export const MEMORY_TRIM_GRACE_MS = 10_000;
// The backstop never ends a tree this small: a fresh kernel frees nothing worth its state.
const BACKSTOP_MIN_TREE_BYTES = MEMORY_TRIM_MIN_BYTES;
const DARWIN_SAMPLE_TIMEOUT_MS = 5000;

export const MEMORY_LIMIT_REASON =
	"The limit protects this machine: other agents and the owner's apps share it, and a process that outgrows memory freezes the whole machine and ends every session on it.";
const MACHINE_PREFIX = "The machine is nearly out of memory, and this kernel was the largest this session owns. ";
const PIECES_ADVICE = "in pieces (stream, batch, memmap, compact dtypes such as uint8 or float32).";

/** Configured limit in GB, else the env override, else the default; 0 turns the ladder off. */
export function resolveKernelMemoryLimitGb(configured?: unknown): number {
	if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) return configured;
	const raw = process.env[KERNEL_MEMORY_LIMIT_ENV]?.trim();
	const fromEnv = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_KERNEL_MEMORY_LIMIT_GB;
}

export function resolveKernelMemoryBackstop(configured?: unknown): boolean {
	if (typeof configured === "boolean") return configured;
	const raw = process.env[KERNEL_MEMORY_BACKSTOP_ENV]?.trim().toLowerCase();
	return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** The model-facing line that states the ceiling up front; undefined when the ladder is off. */
export function kernelMemoryPromptLine(limitGb: number): string | undefined {
	if (!(limitGb > 0)) return undefined;
	return `Memory: each kernel, with the processes it starts, may use up to ${formatGb(limitGb * GB)} GB. Load large data in pieces, and run a heavy one-off job as a script through \`bash()\`, so a breach stops only that script.`;
}

export function formatGb(bytes: number): string {
	const gb = bytes / GB;
	const digits = gb >= 100 ? 0 : gb >= 10 ? 1 : 2;
	return String(Number(gb.toFixed(digits)));
}

/** A usage above the limit never reads as the limit itself ("16 GB, above its 16 GB limit"). */
function formatOver(bytes: number, limitBytes: number): string {
	let text = formatGb(bytes);
	for (let digits = 2; bytes > limitBytes && Number(text) * GB <= limitBytes && digits <= 3; digits += 1) {
		text = String(Number((bytes / GB).toFixed(digits)));
	}
	return text;
}

/** Variable sizes: GB like every other number in the messages, MB or KB below 10 MB. */
function formatSize(bytes: number): string {
	if (bytes >= 10 * 1024 ** 2) return `${formatGb(bytes)} GB`;
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface SizedVariable {
	name: string;
	bytes: number;
	type: string;
	/** numpy, pandas, polars and torch values. */
	shape?: number[];
	dtype?: string;
	/** Lists, tuples, sets, dicts and deques. */
	length?: number;
}

/** The line a stopped or ended cell was running. */
export interface CellLine {
	lineno: number;
	source: string;
}

function describeType(v: SizedVariable): string {
	if (v.length !== undefined) return `${v.type} of ${v.length}`;
	const text = v.dtype ? `${v.type} ${v.dtype}` : v.type;
	return v.shape ? `${text}, shape (${v.shape.join(", ")}${v.shape.length === 1 ? "," : ""})` : text;
}

function describeVariable(v: SizedVariable): string {
	return `${v.name} (${formatSize(v.bytes)}, ${describeType(v)})`;
}

const cellAt = (line: CellLine) => `line ${line.lineno} (\`${line.source}\`)`;

export function memoryWarningMessage(
	totalBytes: number,
	limitBytes: number,
	largest: readonly SizedVariable[],
): string {
	const variables = largest.length
		? largest.map((v) => `${v.name} ${formatSize(v.bytes)} (${describeType(v)})`).join(", ")
		: "none";
	const limit = formatGb(limitBytes);
	return (
		`Memory: this kernel and its processes use ${formatGb(totalBytes)} GB of their ${limit} GB limit. ` +
		`Largest variables: ${variables}. Free what you no longer need (del name) or load the rest in pieces. ` +
		`At ${limit} GB the runtime stops the cell and deletes the largest variables. ${MEMORY_LIMIT_REASON}`
	);
}

export interface ChildStepContext {
	child: { name: string; pid: number; bytes: number };
	totalBytes: number;
	/** The tree without the stopped child. */
	afterBytes: number;
	limitBytes: number;
	machine: boolean;
}

export function memoryChildMessage(c: ChildStepContext): string {
	const limit = formatGb(c.limitBytes);
	let used = `used ${formatOver(c.child.bytes, c.limitBytes)} GB`;
	if (c.child.bytes > c.limitBytes) used += `, above the ${limit} GB limit`;
	else if (c.totalBytes > c.limitBytes) {
		used += ` and took this kernel and its processes to ${formatOver(c.totalBytes, c.limitBytes)} GB, above the ${limit} GB limit`;
	}
	return (
		`${c.machine ? MACHINE_PREFIX : ""}Memory limit: ${c.child.name} (pid ${c.child.pid}), started from this kernel, ${used}, ` +
		`so the runtime stopped it. Memory now: ${formatGb(c.afterBytes)} GB. ` +
		`The kernel and all its variables are intact, and files on disk are untouched. ${MEMORY_LIMIT_REASON} ` +
		`Next: process the data ${PIECES_ADVICE}`
	);
}

export interface TrimStepContext {
	totalBytes: number;
	/** Measured after the trim; undefined when the table could not be read. */
	afterBytes?: number;
	limitBytes: number;
	dropped: readonly SizedVariable[];
	/** The running cell was stopped for this step. */
	cellStopped: boolean;
	line?: CellLine;
}

export function memoryTrimMessage(c: TrimStepContext): string {
	const head = `Memory limit: this kernel used ${formatOver(c.totalBytes, c.limitBytes)} GB, above its ${formatGb(c.limitBytes)} GB limit, so the runtime `;
	const stopped = c.cellStopped ? `stopped the cell${c.line ? ` at ${cellAt(c.line)}` : ""}` : "";
	const now = c.afterBytes === undefined ? "" : ` Memory now: ${formatGb(c.afterBytes)} GB.`;
	const next = `${MEMORY_LIMIT_REASON} Next: recompute only what you need, ${PIECES_ADVICE}`;
	if (c.dropped.length === 0) {
		return (
			`${head}${stopped || "looked for large variables"}. No variable held ${formatGb(MEMORY_TRIM_MIN_BYTES)} GB or more, ` +
			`so none was deleted: every variable is intact, and files on disk are untouched.${now} ` +
			`If memory stays above the limit, the runtime ends the kernel. ${next}`
		);
	}
	return (
		`${head}${stopped ? `${stopped} and deleted` : "deleted"} the largest variables: ${c.dropped.map(describeVariable).join(", ")}.${now} ` +
		`Every other variable is intact, and files on disk are untouched. ${next}`
	);
}

export type KernelEndCause = "grace" | "hard" | "machine";

export interface KillStepContext {
	totalBytes: number;
	limitBytes: number;
	cause: KernelEndCause;
	/** A user cell was running when the kernel ended. */
	cellRunning: boolean;
	line?: CellLine;
	/** Names the kernel held, largest first; `staleSeconds` when they come from an earlier reading. */
	held?: { names: readonly SizedVariable[]; more: number; staleSeconds?: number };
}

export function memoryKillMessage(c: KillStepContext): string {
	const above = `, above its ${formatGb(c.limitBytes)} GB limit`;
	const why =
		c.cause === "grace"
			? `${above}, and ${c.cellRunning ? "stopping the cell" : "deleting the largest variables"} did not bring it down`
			: c.cause === "hard"
				? `${above} and past the ${formatGb(c.limitBytes * MEMORY_HARD_LIMIT_FACTOR)} GB hard limit`
				: c.totalBytes > c.limitBytes
					? above
					: "";
	const where = !c.cellRunning ? "" : c.line ? ` while the cell ran ${cellAt(c.line)}` : " while a cell was running";
	let held = " The kernel did not answer in time, so the names it held are not known.";
	if (c.held && c.held.names.length === 0) held = " The kernel held no variables.";
	else if (c.held) {
		const when = c.held.staleSeconds === undefined ? "" : ` (at a reading ${c.held.staleSeconds} s earlier)`;
		const more = c.held.more > 0 ? `, and ${c.held.more} more` : "";
		held = ` The kernel held${when}: ${c.held.names.map(describeVariable).join(", ")}${more}.`;
	}
	return (
		`${c.cause === "machine" ? MACHINE_PREFIX : ""}Memory limit: this kernel used ${formatOver(c.totalBytes, c.limitBytes)} GB${why}, ` +
		`so the runtime ended the kernel and every process it started${where}. ` +
		`All Python variables are gone; the next cell starts a fresh kernel.${held} Files on disk are untouched. ` +
		`${MEMORY_LIMIT_REASON} Next: rebuild state in pieces, and run a heavy one-off job as a script through bash.`
	);
}

/** A tool result's text: notices from actions taken while no cell ran come first, this cell's own last. */
export function placeMemoryNotices(
	text: string,
	result: { queuedMemoryNotices?: readonly string[]; memoryNotices?: readonly string[] },
): string {
	return [...(result.queuedMemoryNotices ?? []), text, ...(result.memoryNotices ?? [])].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Readers

export interface ProcessRow {
	pid: number;
	ppid: number;
	pgid: number;
	name: string;
	/** Filled by readers that measure while listing (macOS); Linux measures members on demand. */
	bytes?: number;
}

export interface ProcessTable {
	rows: ReadonlyMap<number, ProcessRow>;
	/** The machine is about to run out of memory. */
	critical: boolean;
	bytesOf(pid: number): number;
}

export type MemoryReader = (python: string | undefined) => Promise<ProcessTable>;

/** `pid (comm) state ppid pgrp ...`; comm may itself contain spaces and parentheses. */
export function parseLinuxStat(text: string): ProcessRow | undefined {
	const open = text.indexOf("(");
	const close = text.lastIndexOf(")");
	if (open < 0 || close < open) return undefined;
	const fields = text.slice(close + 2).split(" ");
	const pid = Number(text.slice(0, open));
	const ppid = Number(fields[1]);
	const pgid = Number(fields[2]);
	if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) return undefined;
	return { pid, ppid, pgid, name: text.slice(open + 1, close) };
}

function statusKb(text: string, key: string): number {
	const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
	return match ? Number(match[1]) : 0;
}

/** Resident plus swapped bytes from /proc/<pid>/status. */
export function parseLinuxStatusBytes(text: string): number {
	return (statusKb(text, "VmRSS") + statusKb(text, "VmSwap")) * 1024;
}

/** Critical when MemAvailable is at or below 5% of MemTotal. */
export function parseLinuxMeminfoCritical(text: string): boolean {
	const total = statusKb(text, "MemTotal");
	return total > 0 && statusKb(text, "MemAvailable") <= total * 0.05;
}

/** First line `pressure <vm_pressure_level> <memorystatus_level>`, then `pid ppid pgid footprint comm` rows. */
export function parseDarwinSample(text: string): { rows: Map<number, ProcessRow>; critical: boolean } {
	const rows = new Map<number, ProcessRow>();
	let critical = false;
	for (const line of text.split("\n")) {
		const pressure = line.match(/^pressure (-?\d+) (-?\d+)$/);
		if (pressure) {
			const level = Number(pressure[1]);
			const available = Number(pressure[2]);
			critical = level === 4 || (available >= 0 && available <= 10);
			continue;
		}
		const [pid, ppid, pgid, bytes, name] = line.split("\t");
		const row = { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), bytes: Number(bytes), name: name ?? "" };
		if ([row.pid, row.ppid, row.pgid, row.bytes].every(Number.isSafeInteger) && row.pid > 0) rows.set(row.pid, row);
	}
	return { rows, critical };
}

// proc_pidinfo(PROC_PIDT_SHORTBSDINFO) for the tree and proc_pid_rusage(RUSAGE_INFO_V0)
// ri_phys_footprint for the size: the number Activity Monitor and top's MEM show.
const DARWIN_SAMPLER = `
import ctypes, os
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
def level(name):
    value, size = ctypes.c_int(-1), ctypes.c_size_t(4)
    ok = lib.sysctlbyname(name, ctypes.byref(value), ctypes.byref(size), None, ctypes.c_size_t(0)) == 0
    return value.value if ok else -1
class Info(ctypes.Structure):
    _fields_ = [("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("pgid", ctypes.c_uint32), ("status", ctypes.c_uint32), ("comm", ctypes.c_char * 16)] + [(f, ctypes.c_uint32) for f in ("flags", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "rfu")]
class Usage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(f, ctypes.c_uint64) for f in ("user", "system", "idle", "intr", "pageins", "wired", "resident", "footprint", "start", "exit")]
count = lib.proc_listallpids(None, 0)
pids = (ctypes.c_int * (max(count, 0) + 512))()
count = lib.proc_listallpids(pids, ctypes.sizeof(pids))
lines = ["pressure %d %d" % (level(b"kern.memorystatus_vm_pressure_level"), level(b"kern.memorystatus_level"))]
info, usage, uid = Info(), Usage(), os.getuid()
for pid in pids[:max(count, 0)]:
    if pid <= 0 or lib.proc_pidinfo(pid, 13, ctypes.c_uint64(0), ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info) or info.uid != uid:
        continue
    if lib.proc_pid_rusage(pid, 0, ctypes.byref(usage)) == 0:
        lines.append("%d\\t%d\\t%d\\t%d\\t%s" % (pid, info.ppid, info.pgid, usage.footprint, info.comm.decode("utf-8", "replace")))
print("\\n".join(lines))
`;

async function readDarwinTable(python: string | undefined): Promise<ProcessTable> {
	if (!python) throw new Error("macOS memory reader needs the kernel Python");
	const stdout = await new Promise<string>((resolve, reject) => {
		execFileHidden(
			python,
			["-I", "-S", "-c", DARWIN_SAMPLER],
			{ encoding: "utf8", timeout: DARWIN_SAMPLE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
			(error, out) => (error ? reject(error) : resolve(out)),
		);
	});
	const { rows, critical } = parseDarwinSample(stdout);
	return { rows, critical, bytesOf: (pid) => rows.get(pid)?.bytes ?? 0 };
}

const procBuffer = Buffer.alloc(64 * 1024);

function readProcFile(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		let length = 0;
		while (length < procBuffer.length) {
			const read = readSync(fd, procBuffer, length, procBuffer.length - length, length);
			if (read === 0) break;
			length += read;
		}
		return procBuffer.toString("latin1", 0, length);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

async function readLinuxTable(): Promise<ProcessTable> {
	const rows = new Map<number, ProcessRow>();
	const names = readdirSync("/proc");
	for (let index = 0; index < names.length; index += 1) {
		// Yield between chunks so a host with thousands of processes never stalls its event loop.
		if (index % 256 === 255) await new Promise<void>((resolve) => globalThis.setImmediate(resolve));
		const name = names[index]!;
		if (!/^\d+$/.test(name)) continue;
		const stat = readProcFile(`/proc/${name}/stat`);
		const row = stat === undefined ? undefined : parseLinuxStat(stat);
		if (row) rows.set(row.pid, row);
	}
	const critical = parseLinuxMeminfoCritical(readProcFile("/proc/meminfo") ?? "");
	const measured = new Map<number, number>();
	const bytesOf = (pid: number): number => {
		let bytes = measured.get(pid);
		if (bytes === undefined) {
			bytes = parseLinuxStatusBytes(readProcFile(`/proc/${pid}/status`) ?? "");
			measured.set(pid, bytes);
		}
		return bytes;
	};
	return { rows, critical, bytesOf };
}

export function platformMemoryReader(platform: NodeJS.Platform = process.platform): MemoryReader | undefined {
	if (platform === "linux") return () => readLinuxTable();
	if (platform === "darwin") return (python) => readDarwinTable(python);
	return undefined;
}

// ---------------------------------------------------------------------------
// Trees

/** One stoppable unit under a kernel: a process group of its own, or a subtree sharing the kernel's group. */
export interface ChildUnit {
	/** Set when the unit is a whole process group the kernel started (signal -pgid). */
	pgid?: number;
	pids: number[];
	bytes: number;
	/** Heaviest member, named in the message. */
	pid: number;
	name: string;
}

export interface KernelTreeUsage {
	kernelPid: number;
	kernelBytes: number;
	totalBytes: number;
	/** Largest first. */
	units: ChildUnit[];
}

export function indexChildren(rows: ReadonlyMap<number, ProcessRow>): Map<number, number[]> {
	const children = new Map<number, number[]>();
	for (const row of rows.values()) {
		if (row.ppid === row.pid) continue;
		const list = children.get(row.ppid);
		if (list) list.push(row.pid);
		else children.set(row.ppid, [row.pid]);
	}
	return children;
}

/**
 * The kernel plus every descendant (the kernel shares its owner's process group,
 * so descendants are found by parent pid), plus the members of a bash() process
 * group whose shell died and left them reparented. A group whose leader is alive
 * but not a descendant is someone else's: its id was reused.
 */
export function measureKernelTree(
	table: ProcessTable,
	children: ReadonlyMap<number, readonly number[]>,
	kernelPid: number,
	bashPgids: ReadonlySet<number>,
	ownPgid: number | undefined,
): KernelTreeUsage | undefined {
	const kernel = table.rows.get(kernelPid);
	if (!kernel) return undefined;
	const members = new Set<number>([kernelPid]);
	const queue = [kernelPid];
	const visit = (pid: number) => {
		if (members.has(pid)) return;
		members.add(pid);
		queue.push(pid);
	};
	const orphanPgids = new Set(
		[...bashPgids].filter((pgid) => !table.rows.has(pgid) && pgid > 1 && pgid !== kernel.pgid && pgid !== ownPgid),
	);
	for (const row of table.rows.values()) {
		if (orphanPgids.has(row.pgid)) visit(row.pid);
	}
	while (queue.length > 0) {
		for (const child of children.get(queue.pop()!) ?? []) visit(child);
	}
	const units = new Map<string, ChildUnit>();
	const heaviest = new Map<ChildUnit, number>();
	for (const pid of members) {
		if (pid === kernelPid) continue;
		const row = table.rows.get(pid)!;
		const ownGroup =
			row.pgid !== kernel.pgid &&
			row.pgid !== ownPgid &&
			row.pgid > 1 &&
			(members.has(row.pgid) || orphanPgids.has(row.pgid));
		let top = row;
		while (!ownGroup && top.ppid !== kernelPid && members.has(top.ppid)) top = table.rows.get(top.ppid)!;
		const key = ownGroup ? `g${row.pgid}` : `p${top.pid}`;
		const bytes = table.bytesOf(pid);
		let unit = units.get(key);
		if (!unit) {
			unit = { ...(ownGroup ? { pgid: row.pgid } : {}), pids: [], bytes: 0, pid, name: row.name };
			units.set(key, unit);
			heaviest.set(unit, -1);
		}
		unit.pids.push(pid);
		unit.bytes += bytes;
		if (bytes > heaviest.get(unit)!) {
			heaviest.set(unit, bytes);
			unit.pid = pid;
			unit.name = row.name;
		}
	}
	const kernelBytes = table.bytesOf(kernelPid);
	const sorted = [...units.values()].sort((a, b) => b.bytes - a.bytes);
	return {
		kernelPid,
		kernelBytes,
		totalBytes: sorted.reduce((sum, unit) => sum + unit.bytes, kernelBytes),
		units: sorted,
	};
}

/** SIGKILL a unit: its whole group, or each pid of a subtree that shares the kernel's group. */
export function killChildUnit(unit: ChildUnit): void {
	if (unit.pgid !== undefined) {
		try {
			process.kill(-unit.pgid, "SIGKILL");
			return;
		} catch {
			// Group gone or unsignalable: fall back to its measured members.
		}
	}
	for (const pid of unit.pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already exited.
		}
	}
}

// ---------------------------------------------------------------------------
// Ladder

export interface LadderState {
	warnArmed: boolean;
	/** When the variable step began (or its trim finished); the grace clock for the last step. */
	trimAt?: number;
}

export type MemoryStep =
	| { kind: "warn" }
	| { kind: "child"; unit: ChildUnit }
	| { kind: "trim"; targetBytes: number }
	| { kind: "kill"; cause: KernelEndCause };

/**
 * Smallest unit first: a child that holds more than the kernel itself is
 * stopped alone; otherwise the cell is stopped and the big variables go; the
 * whole tree ends only past the hard limit or when the trim did not help.
 */
export function decideMemorySteps(
	usage: KernelTreeUsage,
	limitBytes: number,
	state: LadderState,
	now: number,
	machineCritical = false,
): MemoryStep[] {
	const steps: MemoryStep[] = [];
	const total = usage.totalBytes;
	const child = usage.units[0];
	const childHoldsMost = child !== undefined && child.bytes > usage.kernelBytes;
	if (machineCritical) {
		steps.push(childHoldsMost ? { kind: "child", unit: child } : { kind: "kill", cause: "machine" });
	} else if (total > limitBytes) {
		if (childHoldsMost) steps.push({ kind: "child", unit: child });
		else if (total > limitBytes * MEMORY_HARD_LIMIT_FACTOR) steps.push({ kind: "kill", cause: "hard" });
		else if (state.trimAt === undefined) {
			state.trimAt = now;
			const target = Math.max(0, usage.kernelBytes - limitBytes * MEMORY_WARN_FRACTION);
			steps.push({ kind: "trim", targetBytes: Math.ceil(target) });
		} else if (now - state.trimAt >= MEMORY_TRIM_GRACE_MS) steps.push({ kind: "kill", cause: "grace" });
	} else {
		state.trimAt = undefined;
	}
	if (total >= limitBytes * MEMORY_WARN_FRACTION) {
		if (state.warnArmed && steps.length === 0) steps.push({ kind: "warn" });
		state.warnArmed = false;
	} else {
		state.warnArmed = true;
	}
	return steps;
}

/** What a kernel client exposes to the guard. */
export interface MemoryGuardedKernel {
	/** Undefined while no kernel process is running or the ladder is off. */
	readonly memoryWatch:
		| { pid: number; limitBytes: number; backstop: boolean; python?: string; bashPgids: Iterable<number> }
		| undefined;
	warnMemory(usage: KernelTreeUsage): void;
	stopMemoryChild(unit: ChildUnit, usage: KernelTreeUsage, machine: boolean): Promise<void>;
	trimMemory(targetBytes: number, usage: KernelTreeUsage): void;
	endMemoryKernel(usage: KernelTreeUsage, cause: KernelEndCause): Promise<void>;
}

export class KernelMemoryGuard {
	private readonly kernels = new Map<MemoryGuardedKernel, LadderState>();
	private timer?: ReturnType<typeof globalThis.setInterval>;
	private ticking?: Promise<void>;
	private journalCache?: { key: string; byKernel: Map<number, number[]> };

	constructor(
		private readonly reader: MemoryReader | undefined,
		private readonly intervalMs = MEMORY_POLL_INTERVAL_MS,
		private readonly now: () => number = Date.now,
	) {}

	watch(kernel: MemoryGuardedKernel): void {
		if (!this.reader) return;
		this.kernels.set(kernel, { warnArmed: true });
		if (!this.timer) {
			this.timer = globalThis.setInterval(() => void this.tick().catch(() => undefined), this.intervalMs);
			this.timer.unref?.();
		}
	}

	unwatch(kernel: MemoryGuardedKernel): void {
		this.kernels.delete(kernel);
		if (this.kernels.size === 0 && this.timer) {
			globalThis.clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** The variable step's trim finished: the grace clock for the last step restarts here. */
	noteTrimmed(kernel: MemoryGuardedKernel): void {
		const state = this.kernels.get(kernel);
		if (state?.trimAt !== undefined) state.trimAt = this.now();
	}

	/** One kernel's tree now, outside the poll: the "memory now" figure after a step. */
	async measure(kernel: MemoryGuardedKernel): Promise<KernelTreeUsage | undefined> {
		const watch = kernel.memoryWatch;
		if (!this.reader || !watch) return undefined;
		try {
			const table = await this.reader(watch.python);
			return this.measureOne(table, indexChildren(table.rows), watch, this.journalPgids());
		} catch {
			return undefined;
		}
	}

	private measureOne(
		table: ProcessTable,
		children: ReadonlyMap<number, readonly number[]>,
		watch: NonNullable<MemoryGuardedKernel["memoryWatch"]>,
		journal: ReadonlyMap<number, readonly number[]>,
	): KernelTreeUsage | undefined {
		const bash = new Set([...watch.bashPgids, ...(journal.get(watch.pid) ?? [])]);
		return measureKernelTree(table, children, watch.pid, bash, table.rows.get(process.pid)?.pgid);
	}

	/** One measurement pass for every watched kernel; overlapping calls join the pass in flight. */
	tick(): Promise<void> {
		this.ticking ??= this.runTick().finally(() => {
			this.ticking = undefined;
		});
		return this.ticking;
	}

	private async runTick(): Promise<void> {
		const reader = this.reader;
		const watched = [...this.kernels.keys()].filter((kernel) => kernel.memoryWatch);
		if (!reader || watched.length === 0) return;
		let table: ProcessTable;
		try {
			table = await reader(watched[0]!.memoryWatch!.python);
		} catch {
			return; // An unreadable table skips this pass; the next one retries.
		}
		const children = indexChildren(table.rows);
		const journal = this.journalPgids();
		const measured: { kernel: MemoryGuardedKernel; usage: KernelTreeUsage; limitBytes: number; backstop: boolean }[] =
			[];
		for (const kernel of watched) {
			const watch = kernel.memoryWatch;
			if (!watch || !this.kernels.has(kernel)) continue;
			const usage = this.measureOne(table, children, watch, journal);
			if (usage) measured.push({ kernel, usage, limitBytes: watch.limitBytes, backstop: watch.backstop });
		}
		const backstop = table.critical
			? measured
					.filter((m) => m.backstop && m.usage.totalBytes >= BACKSTOP_MIN_TREE_BYTES)
					.sort((a, b) => b.usage.totalBytes - a.usage.totalBytes)[0]
			: undefined;
		const now = this.now();
		for (const m of measured) {
			const state = this.kernels.get(m.kernel);
			if (!state) continue;
			for (const step of decideMemorySteps(m.usage, m.limitBytes, state, now, m === backstop)) {
				try {
					if (step.kind === "warn") m.kernel.warnMemory(m.usage);
					else if (step.kind === "child") await m.kernel.stopMemoryChild(step.unit, m.usage, m === backstop);
					else if (step.kind === "trim") m.kernel.trimMemory(step.targetBytes, m.usage);
					else await m.kernel.endMemoryKernel(m.usage, step.cause);
				} catch {
					// One kernel's failed step must not stop the pass for the others.
				}
			}
		}
	}

	/** Active bash() process groups per kernel pid from the orphan journal, re-read only when it changes. */
	private journalPgids(): Map<number, number[]> {
		const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		if (!path) return new Map();
		let key: string;
		try {
			const stat = statSync(path);
			key = `${path}:${stat.size}:${stat.mtimeMs}`;
		} catch {
			return new Map();
		}
		if (this.journalCache?.key !== key) {
			const byKernel = new Map<number, number[]>();
			try {
				for (const record of readActiveOrphanProcesses(path, process.pid)) {
					if (record.kernelPid === undefined) continue;
					byKernel.set(record.kernelPid, [...(byKernel.get(record.kernelPid) ?? []), record.pid]);
				}
			} catch {
				// An unreadable journal leaves the parent-pid walk.
			}
			this.journalCache = { key, byKernel };
		}
		return this.journalCache.byKernel;
	}
}

export const kernelMemoryGuard = new KernelMemoryGuard(platformMemoryReader());
