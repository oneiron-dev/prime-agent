import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import type { OneironPin } from "./oneiron-review.js";

export const ONEIRON_TRANSPORT_LIMITS = Object.freeze({
	rawBytes: 256 * 1024 * 1024,
	lineBytes: 8 * 1024 * 1024,
	events: 250_000,
	messages: 256,
	metadataStringBytes: 1024,
	derivedBytes: 256 * 1024,
});

export interface OneironTransportMessage {
	provider?: string;
	model?: string;
	responseId?: string;
	responseModel?: string;
	responseModelSource?: string;
	stopReason?: string;
}
export interface OneironTransportLog {
	transcript: OneironPin;
	messages: OneironTransportMessage[];
	rawBytes: number;
	eventCount: number;
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function bound(field: string, actual: number | bigint, limit: number): void {
	check(actual <= limit, `Transport ${field}=${actual} exceeds limit=${limit}`);
}

function streamArtifact(
	path: string,
	expectedSha256: string | undefined,
	consume?: (chunk: Buffer) => void,
): { pin: OneironPin; rawBytes: number } {
	check(typeof path === "string" && isAbsolute(path), "Transport artifact path must be an absolute string");
	check(
		expectedSha256 === undefined || (typeof expectedSha256 === "string" && /^[a-f0-9]{64}$/.test(expectedSha256)),
		"Invalid transport artifact hash",
	);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = fstatSync(fd, { bigint: true });
		check(before.isFile(), "Transport artifact must be a regular file");
		bound("rawBytes", before.size, ONEIRON_TRANSPORT_LIMITS.rawBytes);
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let rawBytes = 0;
		for (;;) {
			const size = readSync(fd, chunk, 0, chunk.length, null);
			if (size === 0) break;
			rawBytes += size;
			bound("rawBytes", rawBytes, ONEIRON_TRANSPORT_LIMITS.rawBytes);
			const bytes = chunk.subarray(0, size);
			hash.update(bytes);
			consume?.(bytes);
		}
		const after = fstatSync(fd, { bigint: true });
		const current = lstatSync(path, { bigint: true });
		check(
			before.dev === after.dev &&
				before.ino === after.ino &&
				before.size === after.size &&
				before.mtimeNs === after.mtimeNs &&
				before.ctimeNs === after.ctimeNs &&
				BigInt(rawBytes) === after.size &&
				current.isFile() &&
				current.dev === after.dev &&
				current.ino === after.ino &&
				current.size === after.size &&
				current.mtimeNs === after.mtimeNs &&
				current.ctimeNs === after.ctimeNs,
			"Transport artifact changed while reading",
		);
		const sha256 = hash.digest("hex");
		check(expectedSha256 === undefined || sha256 === expectedSha256, `Artifact hash changed: ${path}`);
		return { pin: { path, sha256 }, rawBytes };
	} finally {
		closeSync(fd);
	}
}

/** Hash opaque retained bytes without treating them as inline model evidence. Never rewrites the artifact. */
export function verifyOneironArtifact(path: string, expectedSha256?: string): OneironPin {
	return streamArtifact(path, expectedSha256).pin;
}

/** Read completed native assistant metadata only. Caller must verify terminal custody and the approved route. */
export function readOneironTransport(path: string, expectedSha256?: string): OneironTransportLog {
	const messages: OneironTransportMessage[] = [];
	const line = Buffer.allocUnsafe(ONEIRON_TRANSPORT_LIMITS.lineBytes);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let lineBytes = 0;
	let eventCount = 0;
	let derivedBytes = 2;
	let assistantPending = false;
	let agentPending = false;
	const parseLine = () => {
		const text = decoder.decode(line.subarray(0, lineBytes));
		if (!text.trim()) return;
		eventCount++;
		bound("eventCount", eventCount, ONEIRON_TRANSPORT_LIMITS.events);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`Invalid or partial transport JSON event ${eventCount}`);
		}
		check(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), "Invalid transport event");
		const event = parsed as Record<string, unknown>;
		check(typeof event.type === "string" && event.type.length > 0, "Invalid transport event type");
		if (event.type === "agent_start") agentPending = true;
		if (event.type === "agent_end") {
			check(!assistantPending, "Partial assistant transport response");
			agentPending = false;
		}
		if (!["message_start", "message_update", "message_end"].includes(event.type)) return;
		check(
			event.message !== null && typeof event.message === "object" && !Array.isArray(event.message),
			"Invalid transport message",
		);
		const source = event.message as Record<string, unknown>;
		if (source.role !== "assistant") return;
		if (event.type !== "message_end") {
			assistantPending = true;
			return;
		}
		assistantPending = false;
		bound("messages", messages.length + 1, ONEIRON_TRANSPORT_LIMITS.messages);
		const message: OneironTransportMessage = {};
		for (const key of [
			"provider",
			"model",
			"responseId",
			"responseModel",
			"responseModelSource",
			"stopReason",
		] as const) {
			const value = source[key];
			if (value === undefined) continue;
			check(typeof value === "string", `Invalid transport metadata ${key}`);
			bound(`metadata[${key}]Bytes`, Buffer.byteLength(value), ONEIRON_TRANSPORT_LIMITS.metadataStringBytes);
			message[key] = value;
		}
		derivedBytes += Buffer.byteLength(JSON.stringify(message)) + (messages.length > 0 ? 1 : 0);
		bound("derivedBytes", derivedBytes, ONEIRON_TRANSPORT_LIMITS.derivedBytes);
		messages.push(message);
	};
	const artifact = streamArtifact(path, expectedSha256, (chunk) => {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? chunk.length : newline;
			const size = end - start;
			bound("lineBytes", lineBytes + size, ONEIRON_TRANSPORT_LIMITS.lineBytes);
			chunk.copy(line, lineBytes, start, end);
			lineBytes += size;
			if (newline < 0) break;
			parseLine();
			lineBytes = 0;
			start = newline + 1;
		}
	});
	if (lineBytes > 0) parseLine();
	check(!assistantPending && !agentPending, "Partial transport lifecycle; completion requires reconciliation");
	check(messages.length > 0, "Transport log lacks completed assistant terminal metadata");
	const result = { transcript: artifact.pin, messages, rawBytes: artifact.rawBytes, eventCount };
	bound("derivedBytes", Buffer.byteLength(JSON.stringify(result)), ONEIRON_TRANSPORT_LIMITS.derivedBytes);
	return result;
}
