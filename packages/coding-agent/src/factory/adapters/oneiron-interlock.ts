import {
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { hashFactoryRuntimeFile } from "../runtime.js";
import type { ActionRecord, AttemptRecord } from "../types.js";
import type { OneironPin } from "./oneiron-review.js";

interface InterlockedStage {
	host: string;
	slot: number;
	interlock: OneironPin;
}
export interface OneironInterlockProof {
	version: 1;
	kind: "linux-flock-v1";
	binary: OneironPin;
	lockPath: string;
	slot: number;
	pid: number;
	processIdentity: string;
	parentPid: number;
	parentProcessIdentity: string;
	fd: number;
	device: string;
	inode: string;
	kernelRecord: string;
	attemptId: string;
	runnerDirectory: string;
}
function check(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
export function oneironInterlockPrefix(stage: InterlockedStage): string[] {
	check(
		stage.host === "arch" &&
			process.platform === "linux" &&
			["x64", "arm64"].includes(process.arch) &&
			Number.isInteger(stage.slot) &&
			stage.slot >= 1 &&
			stage.slot <= 4,
		"Bun physical interlock initially supports Linux/Arch slots1-4 only",
	);
	const path = stage.interlock?.path;
	check(
		path === "/usr/bin/flock" &&
			realpathSync(path) === path &&
			lstatSync(path).isFile() &&
			(statSync(path).mode & 0o111) !== 0 &&
			hashFactoryRuntimeFile(path) === stage.interlock.sha256,
		"Pinned native Linux flock binary required",
	);
	const fd = openSync(path, "r"),
		header = Buffer.alloc(20);
	try {
		check(
			readSync(fd, header) === header.length &&
				header.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) &&
				header.readUInt16LE(18) === (process.arch === "x64" ? 62 : 183),
			"Interlock must be native ELF, not a shim",
		);
	} finally {
		closeSync(fd);
	}
	return [path, "--nonblock", "--no-fork", `/tmp/oneiron-wave6-cargo-slot-${stage.slot}.lock`];
}
function processIdentity(pid: number): string {
	const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(")").at(-1)!.trim().split(/\s+/);
	check(fields[0] !== "Z" && fields[19], "Interlock process identity unavailable");
	return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${pid}:${fields[19]}`;
}
/** Inner native primitive. Production caller always derives the v23 path; tests use only isolated temp locks. */
export function inspectOwnedFlock(lockPath: string) {
	check(
		process.platform === "linux" && realpathSync(lockPath) === lockPath && lstatSync(lockPath).isFile(),
		"Physical slot lock path must not be an alias",
	);
	const expected = statSync(lockPath, { bigint: true });
	check(
		expected.nlink === 1n && expected.uid === BigInt(process.getuid!()),
		"Physical slot lock ownership/link identity mismatch",
	);
	const major = ((expected.dev >> 8n) & 0xfffn) | ((expected.dev >> 32n) & ~0xfffn);
	const minor = (expected.dev & 0xffn) | ((expected.dev >> 12n) & 0xffffff00n);
	for (const name of readdirSync("/proc/self/fdinfo")) {
		if (!/^\d+$/.test(name)) continue;
		let text: string;
		try {
			text = readFileSync(`/proc/self/fdinfo/${name}`, "utf8");
		} catch {
			continue;
		}
		const line = text.split("\n").find((line) => /^lock:/.test(line));
		const match = line?.match(/^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+(\d+) ([a-f0-9]+):([a-f0-9]+):(\d+) 0 EOF$/i);
		if (
			!match ||
			Number(match[1]) !== process.pid ||
			BigInt(`0x${match[2]}`) !== major ||
			BigInt(`0x${match[3]}`) !== minor ||
			BigInt(match[4]!) !== expected.ino
		)
			continue;
		const fd = Number(name),
			actual = fstatSync(fd, { bigint: true });
		check(
			actual.dev === expected.dev &&
				actual.ino === expected.ino &&
				readlinkSync(`/proc/self/fd/${name}`) === lockPath,
			"Owned physical lock FD/path inode changed",
		);
		return {
			pid: process.pid,
			processIdentity: processIdentity(process.pid),
			fd,
			device: String(expected.dev),
			inode: String(expected.ino),
			kernelRecord: line!,
		};
	}
	throw new Error("No positive own-FD/kernel exclusive physical slot lock; direct launch bypass denied");
}
function runnerIdentity(
	directory: string,
	attempt: AttemptRecord,
	action: ActionRecord,
	pid: number,
	identity: string,
	parentPid: number,
	parentIdentity: string,
): void {
	check(
		basename(directory) === attempt.id && realpathSync(directory) === directory,
		"Interlock requires actual Core attempt directory",
	);
	const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
	const started = JSON.parse(readFileSync(join(directory, "started.json"), "utf8"));
	const child = JSON.parse(readFileSync(join(directory, "child.json"), "utf8"));
	check(
		manifest.version === 1 &&
			manifest.attemptId === attempt.id &&
			manifest.sourceFingerprint === action.sourceFingerprint &&
			JSON.stringify(manifest.command) === JSON.stringify(action.command) &&
			started.attemptId === attempt.id &&
			started.sourceFingerprint === action.sourceFingerprint &&
			started.pid === parentPid &&
			started.processIdentity === parentIdentity &&
			(attempt.processIdentity === null || attempt.processIdentity === parentIdentity) &&
			child.pid === pid &&
			child.processIdentity === identity,
		"Interlock process is not the recorded current Core child/parent",
	);
}
export function inspectOneironInterlock(
	stage: InterlockedStage,
	action: ActionRecord,
	attempt: AttemptRecord,
): OneironInterlockProof {
	const prefix = oneironInterlockPrefix(stage);
	check(
		JSON.stringify(action.command.argv.slice(0, 4)) === JSON.stringify(prefix),
		"Core command lacks exact whole-entry no-fork interlock prefix",
	);
	const held = inspectOwnedFlock(prefix[3]!);
	const parentPid = process.ppid,
		parentProcessIdentity = processIdentity(parentPid),
		runnerDirectory = realpathSync(`/proc/${parentPid}/cwd`);
	runnerIdentity(runnerDirectory, attempt, action, held.pid, held.processIdentity, parentPid, parentProcessIdentity);
	return {
		version: 1,
		kind: "linux-flock-v1",
		binary: stage.interlock,
		lockPath: prefix[3]!,
		slot: stage.slot,
		...held,
		parentPid,
		parentProcessIdentity,
		attemptId: attempt.id,
		runnerDirectory,
	};
}
export function validateOneironInterlockProof(
	proof: OneironInterlockProof,
	stage: InterlockedStage,
	action: ActionRecord,
	attempt: AttemptRecord,
): void {
	const prefix = oneironInterlockPrefix(stage);
	const record = proof?.kernelRecord?.match(
		/^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+(\d+) ([a-f0-9]+):([a-f0-9]+):(\d+) 0 EOF$/i,
	);
	check(record && /^\d+$/.test(proof.device) && /^\d+$/.test(proof.inode), "Malformed retained kernel lock record");
	const device = BigInt(proof.device);
	check(
		BigInt(`0x${record[2]}`) === (((device >> 8n) & 0xfffn) | ((device >> 32n) & ~0xfffn)) &&
			BigInt(`0x${record[3]}`) === ((device & 0xffn) | ((device >> 12n) & 0xffffff00n)) &&
			record[4] === proof.inode,
		"Retained kernel lock device/inode mismatch",
	);
	check(
		proof?.version === 1 &&
			proof.kind === "linux-flock-v1" &&
			JSON.stringify(proof.binary) === JSON.stringify(stage.interlock) &&
			proof.lockPath === prefix[3] &&
			proof.slot === stage.slot &&
			proof.attemptId === attempt.id &&
			JSON.stringify(action.command.argv.slice(0, 4)) === JSON.stringify(prefix) &&
			Number.isInteger(proof.fd) &&
			proof.fd >= 0 &&
			Number(proof.kernelRecord.match(/WRITE\s+(\d+) /)?.[1]) === proof.pid,
		"Retained physical slot proof identity mismatch",
	);
	runnerIdentity(
		proof.runnerDirectory,
		attempt,
		action,
		proof.pid,
		proof.processIdentity,
		proof.parentPid,
		proof.parentProcessIdentity,
	);
}
