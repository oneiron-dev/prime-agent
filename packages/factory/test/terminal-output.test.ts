import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completedReview } from "../src/adapters/review-recovery.js";
import {
	finalAssistantText,
	reviewVerdict,
	type SessionEntry,
	turnState,
	writerTerminal,
} from "../src/adapters/terminal-output.js";

/**
 * Streams and session files captured from the Rust prime-agent (`scripts/capture-rust-jsonl.py`, faux provider,
 * `-p --mode json`). They carry the `all` profile; `factoryCompleted` derives what `--json-event-profile
 * factory-completed` emits: the same stream without the two progressive snapshot events.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/rust-jsonl/${name}`, import.meta.url), "utf8");
const lines = (jsonl: string) => jsonl.split("\n").filter((line) => line.trim());
function factoryCompleted(jsonl: string): string {
	return lines(jsonl)
		.filter((line) => !["message_update", "tool_execution_update"].includes(JSON.parse(line).type))
		.join("\n");
}
const captured = {
	done: fixture("writer-done.stdout.jsonl"),
	review: fixture("review-tool-then-verdict.stdout.jsonl"),
	error: fixture("provider-error.stdout.jsonl"),
	length: fixture("length-cutoff.stdout.jsonl"),
};

describe("Rust JSON streams through the factory's terminal parsing", () => {
	it.each([
		["the all profile", (jsonl: string) => jsonl],
		["the factory-completed profile", factoryCompleted],
	])("reads exact terminals from %s", (_profile, project) => {
		const done = finalAssistantText(project(captured.done));
		expect([done, writerTerminal(done, "capture-one"), writerTerminal(done, "capture-two")]).toEqual([
			"Implemented the change.\nPR BODY:\nAdded the function.\nDONE capture-one",
			{ kind: "done", line: "DONE capture-one" },
			undefined,
		]);
		// Thinking and the tool-call turn are not the reply; the verdict is the last text after the tool ran.
		const review = finalAssistantText(project(captured.review));
		expect([review, reviewVerdict(review)]).toEqual(["Checked every hunk.\nVERDICT: LANDABLE", "LANDABLE"]);
		// A provider error and a length cut-off leave no final, though the process exited 0 and DONE was written.
		expect([finalAssistantText(project(captured.error)), finalAssistantText(project(captured.length))]).toEqual([
			"",
			"",
		]);
		expect([fixture("provider-error.exit"), fixture("length-cutoff.exit")]).toEqual(["0\n", "0\n"]);
	});

	it("tells a turn that never began, one still open and one that ended, whatever the run's outcome", () => {
		const done = lines(captured.done);
		const toolEnd = lines(captured.review).findIndex((line) => JSON.parse(line).type === "tool_execution_end");
		expect([
			turnState(""),
			turnState("spawn failed\nIDLE 1800s"),
			turnState(lines(captured.review).slice(0, toolEnd + 1).join("\n")),
			turnState(factoryCompleted(done.slice(0, -1).join("\n"))),
			turnState(captured.done),
			turnState(factoryCompleted(captured.error)),
			turnState(`${captured.done}\n${done.slice(0, 2).join("\n")}`),
		]).toEqual(["none", "none", "open", "open", "closed", "closed", "open"]);
	});

	it("drops a stream without agent_end, a later failed run and a turn stopped at its tool call", () => {
		const done = lines(captured.done);
		expect(finalAssistantText(done.slice(0, -1).join("\n"))).toBe("");
		// Two runs in one log: the later run's failed reply supersedes the earlier final.
		expect(finalAssistantText(`${captured.done}\n${captured.error}`)).toBe("");
		const review = lines(captured.review);
		const toolEnd = review.findIndex((line) => JSON.parse(line).type === "tool_execution_end");
		expect(finalAssistantText([...review.slice(0, toolEnd + 1), '{"type":"agent_end"}'].join("\n"))).toBe("");
	});

	it("ignores malformed lines and custom metadata after the turn ended", () => {
		const done = lines(captured.done);
		const custom = done.find((line) => {
			const event = JSON.parse(line);
			return event.type === "message_end" && event.message?.role === "custom";
		});
		expect(custom).toBeDefined();
		const noisy = [
			"not json",
			"[1, 2]",
			...done.slice(0, 3),
			"{",
			...done.slice(3),
			custom!.replace('"message_end"', '"message_start"'),
			custom!,
		];
		expect(finalAssistantText(noisy.join("\n"))).toBe(
			"Implemented the change.\nPR BODY:\nAdded the function.\nDONE capture-one",
		);
	});
});

describe("terminal lines", () => {
	it.each([
		["VERDICT: LANDABLE\nNo defects.", "LANDABLE"],
		["Summary first.\nVERDICT: DEFECTS\nsrc/a.rs:1 wrong", "DEFECTS"],
		["I would say VERDICT: LANDABLE.", undefined],
		["> VERDICT: LANDABLE", undefined],
		["```\nVERDICT: LANDABLE\n```", undefined],
		["VERDICT: LANDABLE\nVERDICT: DEFECTS", undefined],
	])("a review verdict is one standalone line outside a fence: %j", (final, expected) => {
		expect(reviewVerdict(final)).toBe(expected);
	});

	it.each([
		["DONE T1", { kind: "done", line: "DONE T1" }],
		["Work finished.\nPR BODY:\nx\n\nDONE T1  \n\n", { kind: "done", line: "DONE T1" }],
		[
			"No token.\nBLOCKED T1: the fixture host is gone",
			{ kind: "blocked", line: "BLOCKED T1: the fixture host is gone", why: "the fixture host is gone" },
		],
		["I will print DONE T1 when the build ends.", undefined],
		["DONE T1\nStill running the tests.", undefined],
		["DONE T1.", undefined],
		["  DONE T1", undefined],
		["BLOCKED T1", undefined],
		["DONE T10", undefined],
		["Example:\n```\nDONE T1\n```", undefined],
		["Unclosed fence:\n~~~\nDONE T1", undefined],
	])("a writer reply is terminal only on its exact last line outside a fence: %j", (final, expected) => {
		expect(writerTerminal(final, "T1")).toEqual(expected);
	});

	it("reads the final assistant text only from an ended turn", () => {
		const reply = (text: string, extra: Record<string, unknown> = {}) =>
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }], ...extra },
			});
		const stream = [
			JSON.stringify({ type: "agent_start" }),
			JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "no" }] } }),
			reply("first"),
			"not json",
			reply("DONE x"),
			JSON.stringify({ type: "agent_end" }),
			JSON.stringify({ type: "message_end", message: { role: "custom", content: [] } }),
		].join("\n");
		expect(finalAssistantText(stream)).toBe("DONE x");
		// No agent_end, a tool call or a cut-off reply leaves no final text: earlier commentary is never reused.
		expect(finalAssistantText(stream.split("\n").slice(0, 5).join("\n"))).toBe("");
		expect(
			finalAssistantText(
				[reply("DONE x"), reply("", { content: [{ type: "toolCall" }] }), '{"type":"agent_end"}'].join("\n"),
			),
		).toBe("");
		expect(finalAssistantText([reply("DONE x", { stopReason: "length" }), '{"type":"agent_end"}'].join("\n"))).toBe(
			"",
		);
	});
});

describe("completed-review recovery against a Rust session file", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	/** The captured review session, rebound to a fixture worktree and head (paths and SHAs are per capture). */
	function recovery(options: { stream: string; receiptLine: boolean }) {
		const root = mkdtempSync(join(tmpdir(), "factory-review-recovery-"));
		roots.push(root);
		const directory = join(root, "tickets", "capture-one");
		const worktree = join(root, "wt", "capture-one");
		const head = "c".repeat(40);
		const sessionDir = join(directory, "sessions", "review-grok");
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(join(directory, "logs"));
		const [header, ...entries] = lines(fixture("review-tool-then-verdict.session.jsonl"));
		const session = JSON.parse(header!) as SessionEntry;
		const sessionPath = join(sessionDir, "session.jsonl");
		writeFileSync(
			sessionPath,
			`${[JSON.stringify({ ...session, cwd: worktree, git: { ...session.git, commit: head } }), ...entries].join("\n")}\n`,
		);
		const terminal = entries
			.map((line) => JSON.parse(line) as SessionEntry)
			.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
			.at(-1)!;
		writeFileSync(
			join(directory, "sessions", "review-grok.completed.json"),
			JSON.stringify({ head, sessionPath, messageId: terminal.id }),
		);
		const logPath = join(directory, "logs", "review-grok.jsonl");
		writeFileSync(logPath, options.stream);
		const after = new Date(Date.parse(terminal.timestamp!) + 1_000).toISOString();
		const runLogPath = join(directory, "run.log");
		writeFileSync(runLogPath, options.receiptLine ? `[${after}] capture-one review:grok LANDABLE\n` : "");
		const logged: string[] = [];
		const context = {
			directory,
			worktree,
			runLogPath,
			head: async () => head,
			status: async () => "",
			log: (step: string, message?: string) => {
				logged.push(`${step} ${message ?? ""}`);
			},
		};
		return {
			run: () => completedReview(context, "grok", "review-grok", sessionDir, logPath, undefined),
			logged,
			reconsumed: () => JSON.parse(readFileSync(join(directory, "review-reconsumption.jsonl"), "utf8")),
			messageId: terminal.id,
		};
	}

	it("reconsumes the persisted terminal message its seat stream carried to agent_end", async () => {
		const r = recovery({ stream: factoryCompleted(captured.review), receiptLine: true });
		expect(await r.run()).toBe("LANDABLE");
		expect(r.reconsumed()).toMatchObject({
			name: "grok",
			messageId: r.messageId,
			verdict: "LANDABLE",
			seatReceipt: "native-agent-end-and-rc0",
		});
		expect(r.logged).toEqual([`review:grok LANDABLE (reconsumed original terminal message ${r.messageId} at ${"c".repeat(40)})`]);
	});

	it("refuses the message without its run.log receipt or without a stream that reached agent_end", async () => {
		await expect(recovery({ stream: captured.review, receiptLine: false }).run()).rejects.toThrow(
			"no successful seat receipt for this terminal message",
		);
		const cut = lines(captured.review).slice(0, -1).join("\n");
		await expect(recovery({ stream: cut, receiptLine: true }).run()).rejects.toThrow(
			"matching native message lacks terminal stream completion",
		);
	});
});
