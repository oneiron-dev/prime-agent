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
 * Streams and session files captured from the Rust prime-agent (`scripts/capture-rust-jsonl.py`): the factory's exact
 * native seat argv (`-p --mode json --json-event-profile factory-completed ... --offline ... --no-skills`, the prompt on
 * stdin) under the faux provider, once per custody: an owned seat runs the session itself, a daemon seat
 * (`--daemon-hosted`) streams a session the sandbox daemon holds. The parser reads them as captured.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/rust-jsonl/${name}`, import.meta.url), "utf8");
const lines = (jsonl: string) => jsonl.split("\n").filter((line) => line.trim());
const CUSTODIES = ["owned", "daemon"] as const;
type Custody = (typeof CUSTODIES)[number];
const captured = (custody: Custody) => ({
	done: fixture(`${custody}-writer-done.stdout.jsonl`),
	review: fixture(`${custody}-review-tool-then-verdict.stdout.jsonl`),
	error: fixture(`${custody}-provider-error.stdout.jsonl`),
	length: fixture(`${custody}-length-cutoff.stdout.jsonl`),
});
const types = (jsonl: string) => lines(jsonl).map((line) => JSON.parse(line).type as string);

describe.each(CUSTODIES)("Rust factory-completed streams from a %s seat", (custody) => {
	const streams = captured(custody);

	it("carry the profile marker, no progressive snapshots and every completed event", () => {
		for (const stream of Object.values(streams)) {
			const [header] = lines(stream);
			expect(JSON.parse(header!)).toMatchObject({ type: "session", jsonEventProfile: "factory-completed" });
			expect(types(stream).filter((type) => type === "message_update" || type === "tool_execution_update")).toEqual(
				[],
			);
		}
		// The reviewer's tool ran in the seat's kernel and succeeded.
		const toolEnds = lines(streams.review)
			.map((line) => JSON.parse(line))
			.filter((event) => event.type === "tool_execution_end");
		expect(toolEnds.map((event) => [event.isError ?? false, event.result.content[0].text])).toEqual([
			[false, "factory-capture\n"],
		]);
		// The tool turn keeps its completed events, in order, through the verdict's turn.
		const review = types(streams.review).filter((type) => type !== "message_start");
		expect(review.slice(review.indexOf("tool_execution_start"))).toEqual([
			"tool_execution_start",
			"tool_execution_end",
			"message_end",
			"turn_end",
			"turn_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("reads exact terminals", () => {
		const done = finalAssistantText(streams.done);
		expect([done, writerTerminal(done, "capture-one"), writerTerminal(done, "capture-two")]).toEqual([
			"Implemented the change.\nPR BODY:\nAdded the function.\nDONE capture-one",
			{ kind: "done", line: "DONE capture-one" },
			undefined,
		]);
		// Thinking and the tool-call turn are not the reply; the verdict is the last text after the tool ran.
		const review = finalAssistantText(streams.review);
		expect([review, reviewVerdict(review)]).toEqual(["Checked every hunk.\nVERDICT: LANDABLE", "LANDABLE"]);
		// A provider error and a length cut-off leave no final, though both replies wrote DONE.
		expect([finalAssistantText(streams.error), finalAssistantText(streams.length)]).toEqual(["", ""]);
		for (const stream of [streams.error, streams.length])
			expect(lines(stream).some((line) => line.includes("DONE capture-one"))).toBe(true);
		// The owned seat exits 0 after a provider error; the daemon seat's retries give up and it exits 1.
		expect([fixture(`${custody}-provider-error.exit`), fixture(`${custody}-length-cutoff.exit`)]).toEqual(
			custody === "owned" ? ["0\n", "0\n"] : ["1\n", "0\n"],
		);
	});

	it("tells a turn that never began, one still open and one that ended, whatever the run's outcome", () => {
		const done = lines(streams.done);
		const review = lines(streams.review);
		const toolEnd = review.findIndex((line) => JSON.parse(line).type === "tool_execution_end");
		expect([
			turnState(""),
			turnState("spawn failed\nIDLE 1800s"),
			turnState(review.slice(0, toolEnd + 1).join("\n")),
			turnState(done.slice(0, -1).join("\n")),
			turnState(streams.done),
			turnState(streams.error),
			turnState(`${streams.done}\n${done.slice(0, 2).join("\n")}`),
		]).toEqual(["none", "none", "open", "open", "closed", "closed", "open"]);
	});

	it("drops a stream without agent_end, a later failed run and a turn stopped at its tool call", () => {
		const done = lines(streams.done);
		expect(finalAssistantText(done.slice(0, -1).join("\n"))).toBe("");
		// Two runs in one log: the later run's failed reply supersedes the earlier final.
		expect(finalAssistantText(`${streams.done}\n${streams.error}`)).toBe("");
		const review = lines(streams.review);
		const toolEnd = review.findIndex((line) => JSON.parse(line).type === "tool_execution_end");
		expect(finalAssistantText([...review.slice(0, toolEnd + 1), '{"type":"agent_end"}'].join("\n"))).toBe("");
	});

	it("ignores malformed lines and custom metadata after the turn ended", () => {
		const done = lines(streams.done);
		// The owned stream carries the harness digest, the daemon's failed run its retry outcome.
		const custom = [...done, ...lines(streams.error)].find((line) => {
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

describe.each(CUSTODIES)("completed-review recovery against a %s seat's Rust session file", (custody) => {
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
		const [header, ...entries] = lines(fixture(`${custody}-review-tool-then-verdict.session.jsonl`));
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
		const r = recovery({ stream: captured(custody).review, receiptLine: true });
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
		await expect(recovery({ stream: captured(custody).review, receiptLine: false }).run()).rejects.toThrow(
			"no successful seat receipt for this terminal message",
		);
		const cut = lines(captured(custody).review).slice(0, -1).join("\n");
		await expect(recovery({ stream: cut, receiptLine: true }).run()).rejects.toThrow(
			"matching native message lacks terminal stream completion",
		);
	});
});
