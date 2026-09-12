import { createHash } from "node:crypto";
import {
	closeSync,
	ftruncateSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ONEIRON_TRANSPORT_LIMITS,
	readOneironTransport,
	verifyOneironArtifact,
} from "../src/factory/adapters/oneiron-transport.js";
import { runOneironWriterForeground } from "../src/factory/adapters/oneiron-writer.js";

const roots: string[] = [];
function setup() {
	const directory = mkdtempSync(join(tmpdir(), "oneiron-transport-"));
	roots.push(directory);
	const path = join(directory, "stdout.jsonl");
	const write = (text: string | Buffer) => {
		writeFileSync(path, text);
		return path;
	};
	return { directory, path, write };
}
function ended(extra: Record<string, unknown> = {}) {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "cpa-r",
			model: "gpt-6-astra",
			responseModel: "gpt-6-astra",
			responseModelSource: "provider-response",
			responseId: "resp_native",
			stopReason: "stop",
			...extra,
		},
	});
}
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("bounded file-backed native transport provenance", () => {
	test("streams and hashes more than 39 MiB of repetitive snapshots but retains only completed metadata", () => {
		const f = setup();
		const update = `${JSON.stringify({ type: "message_update", message: { role: "assistant", model: "spoofed-snapshot", responseId: "not-completed", content: [{ type: "text", text: "x".repeat(64 * 1024) }] } })}\n`;
		const hash = createHash("sha256");
		const fd = openSync(f.path, "wx");
		try {
			for (let index = 0; index < 624; index++) {
				writeSync(fd, update);
				hash.update(update);
			}
			const terminal = `${ended({ content: [{ type: "text", text: "not retained" }] })}\n`;
			writeSync(fd, terminal);
			hash.update(terminal);
		} finally {
			closeSync(fd);
		}
		const pin = { path: f.path, sha256: hash.digest("hex") };
		const actual = readOneironTransport(f.path, pin.sha256);
		expect(actual.transcript).toEqual(pin);
		expect(actual.rawBytes).toBeGreaterThan(39 * 1024 * 1024);
		expect(actual.rawBytes).toBe(statSync(f.path).size);
		expect(actual.eventCount).toBe(625);
		expect(actual.messages).toEqual([
			{
				provider: "cpa-r",
				model: "gpt-6-astra",
				responseModel: "gpt-6-astra",
				responseModelSource: "provider-response",
				responseId: "resp_native",
				stopReason: "stop",
			},
		]);
		expect(JSON.stringify(actual).length).toBeLessThan(1024);
		expect(verifyOneironArtifact(f.path, pin.sha256)).toEqual(pin);
	});
	test("ignores nested self-reports, session snapshots, user messages and tools", () => {
		const f = setup();
		const nested = JSON.parse(ended()) as unknown;
		f.write(
			[
				JSON.stringify({ type: "session", message: nested }),
				JSON.stringify({ type: "message_end", message: { role: "user", content: [nested] } }),
				JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [nested] } }),
				ended({
					responseModelSource: undefined,
					responseModel: undefined,
					responseId: undefined,
					content: [nested],
				}),
				JSON.stringify({ type: "agent_end", messages: [nested] }),
			].join("\n"),
		);
		expect(readOneironTransport(f.path).messages).toEqual([
			{ provider: "cpa-r", model: "gpt-6-astra", stopReason: "stop" },
		]);
	});
	test("handles UTF-8 across read boundaries and CRLF without normalizing raw hash bytes", () => {
		const f = setup();
		const text = `\r\n${ended({ content: [{ type: "text", text: `${"x".repeat(65535)}🌊` }], responseId: "resp_é" })}\r\n`;
		f.write(text);
		const actual = readOneironTransport(f.path);
		expect(actual.transcript.sha256).toBe(createHash("sha256").update(text).digest("hex"));
		expect(actual.messages[0]!.responseId).toBe("resp_é");
	});
	test.each([
		["invalid JSON", `${ended()}\nnot-json`, /Invalid or partial/],
		["partial JSON", `${ended()}\n{"type":`, /Invalid or partial/],
		["invalid event shape", "[]", /Invalid transport event/],
		["invalid message", '{"type":"message_end","message":null}', /Invalid transport message/],
		["missing terminal", '{"type":"session"}', /terminal metadata/],
		[
			"partial assistant",
			`${ended()}\n${JSON.stringify({ type: "message_update", message: { role: "assistant" } })}`,
			/Partial transport/,
		],
		["partial agent", `${JSON.stringify({ type: "agent_start" })}\n${ended()}`, /Partial transport/],
		[
			"agent end cannot certify partial assistant",
			`${JSON.stringify({ type: "message_update", message: { role: "assistant" } })}\n${JSON.stringify({ type: "agent_end" })}`,
			/Partial assistant/,
		],
	] as const)("rejects %s and preserves the exact raw artifact", (_name, text, error) => {
		const f = setup();
		f.write(text);
		const pin = verifyOneironArtifact(f.path);
		expect(() => readOneironTransport(f.path)).toThrow(error);
		expect(verifyOneironArtifact(f.path)).toEqual(pin);
	});
	test("rejects malformed UTF-8 instead of hash-binding replacement text", () => {
		const f = setup();
		f.write(
			Buffer.concat([
				Buffer.from('{"type":"session","bad":"'),
				Buffer.from([0xc3, 0x28]),
				Buffer.from('"}\n'),
				Buffer.from(ended()),
			]),
		);
		expect(() => readOneironTransport(f.path)).toThrow(/encoded data/);
	});
	test("rejects non-string paths and hashes without coercion", () => {
		const f = setup();
		f.write(ended());
		const invalid = {
			toString: () => {
				throw new Error("must not coerce");
			},
		} as unknown as string;
		expect(() => readOneironTransport(invalid)).toThrow(/absolute string/);
		expect(() => verifyOneironArtifact(f.path, invalid)).toThrow(/Invalid transport artifact hash/);
	});
	test("rejects hash drift, symlinks and non-files", () => {
		const f = setup();
		f.write(ended());
		const pin = verifyOneironArtifact(f.path);
		f.write(`${ended()}\n`);
		expect(() => readOneironTransport(f.path, pin.sha256)).toThrow(/hash changed/);
		expect(() => verifyOneironArtifact(f.path, pin.sha256)).toThrow(/hash changed/);
		expect(() => readOneironTransport(f.path, "not-a-hash")).toThrow(/Invalid transport artifact hash/);
		const link = join(f.directory, "alias.jsonl");
		symlinkSync(f.path, link);
		expect(() => readOneironTransport(link)).toThrow();
		expect(() => readOneironTransport(f.directory)).toThrow(/regular file/);
	});
	test("bounds raw bytes before reading a sparse oversized artifact", () => {
		const f = setup();
		const fd = openSync(f.path, "wx");
		try {
			ftruncateSync(fd, ONEIRON_TRANSPORT_LIMITS.rawBytes + 1);
		} finally {
			closeSync(fd);
		}
		expect(() => readOneironTransport(f.path)).toThrow(/rawBytes=268435457 exceeds limit=268435456/);
		expect(() => verifyOneironArtifact(f.path)).toThrow(/rawBytes=268435457 exceeds limit=268435456/);
		expect(statSync(f.path).size).toBe(ONEIRON_TRANSPORT_LIMITS.rawBytes + 1);
	});
	test.each([true, false])("bounds a single huge line before parsing; newline=%s", (newline) => {
		const f = setup();
		f.write(`${" ".repeat(ONEIRON_TRANSPORT_LIMITS.lineBytes + 1)}${newline ? "\n" : ""}`);
		expect(() => readOneironTransport(f.path)).toThrow(/lineBytes=8388609 exceeds limit=8388608/);
	});
	test("bounds event count even for ignored session events", () => {
		const f = setup();
		f.write(`${'{"type":"session"}\n'.repeat(ONEIRON_TRANSPORT_LIMITS.events + 1)}${ended()}`);
		expect(() => readOneironTransport(f.path)).toThrow(/eventCount=250001 exceeds limit=250000/);
	});
	test("bounds assistant records, individual metadata strings and total derived output", () => {
		const f = setup();
		f.write(`${ended()}\n`.repeat(ONEIRON_TRANSPORT_LIMITS.messages + 1));
		expect(() => readOneironTransport(f.path)).toThrow(/messages=257 exceeds limit=256/);
		f.write(ended({ responseId: "é".repeat(ONEIRON_TRANSPORT_LIMITS.metadataStringBytes) }));
		expect(() => readOneironTransport(f.path)).toThrow(/metadata\[responseId\]Bytes=2048 exceeds limit=1024/);
		const value = "x".repeat(ONEIRON_TRANSPORT_LIMITS.metadataStringBytes);
		f.write(
			`${ended({ provider: value, model: value, responseId: value, responseModel: value, responseModelSource: value, stopReason: value })}\n`.repeat(
				45,
			),
		);
		expect(() => readOneironTransport(f.path)).toThrow(/derivedBytes=\d+ exceeds limit=262144/);
	});
});

describe("writer foreground raw stdout custody", () => {
	test("retains a bounded prefix and rejects raw byte overflow before process success", async () => {
		const f = setup();
		const script = `const fs=require('node:fs');const chunk=Buffer.alloc(1024*1024,'x');for(let i=0;i<257;i++)fs.writeSync(1,chunk);`;
		await expect(runOneironWriterForeground([process.execPath, "-e", script], f.directory, f.path)).rejects.toThrow(
			/rawBytes=\d+ exceeds limit=268435456.*partial log requires reconciliation/,
		);
		expect(statSync(f.path).size).toBe(ONEIRON_TRANSPORT_LIMITS.rawBytes);
	}, 20000);
	test("retains partial JSON from a zero-exit child but cannot derive completed provenance", async () => {
		const f = setup();
		const raw = `${ended()}\n{"type":`;
		await runOneironWriterForeground(
			[process.execPath, "-e", `process.stdout.write(${JSON.stringify(raw)})`],
			f.directory,
			f.path,
		);
		expect(() => readOneironTransport(f.path)).toThrow(/Invalid or partial/);
		expect(readFileSync(f.path, "utf8")).toBe(raw);
	});

	test("spools more than 39 MiB without a full-string result or overwriting retained bytes", async () => {
		const f = setup();
		const script = `const snapshot=JSON.stringify({type:'message_update',message:{role:'assistant',content:[{type:'text',text:'x'.repeat(65536)}]}})+'\\n';for(let i=0;i<624;i++)process.stdout.write(snapshot);process.stdout.write(${JSON.stringify(ended())});`;
		await expect(
			runOneironWriterForeground([process.execPath, "-e", script], f.directory, f.path),
		).resolves.toBeUndefined();
		const transport = readOneironTransport(f.path);
		expect(transport.rawBytes).toBeGreaterThan(39 * 1024 * 1024);
		expect(transport.messages).toHaveLength(1);
		expect(() => runOneironWriterForeground([process.execPath, "-e", ""], f.directory, f.path)).toThrow(/EEXIST/);
		expect(verifyOneironArtifact(f.path)).toEqual(transport.transcript);
	});
	test.each(["nonzero", "owner-loss"])(
		"keeps raw terminal-looking bytes but rejects %s process completion",
		async (failure) => {
			const f = setup();
			const script = `process.stdout.write(${JSON.stringify(ended())},()=>{${failure === "nonzero" ? "process.exit(2)" : "process.kill(process.pid,'SIGTERM')"}});`;
			await expect(
				runOneironWriterForeground([process.execPath, "-e", script], f.directory, f.path),
			).rejects.toThrow(/Foreground writer exited/);
			expect(readFileSync(f.path, "utf8")).toBe(ended());
		},
	);
});
