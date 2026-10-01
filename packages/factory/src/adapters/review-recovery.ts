import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type ReviewSeat, TicketFailure } from "./oneiron-settings.js";
import { contentText, reviewVerdict, sessionEntries } from "./terminal-output.js";

/** What the owner-recovery check reads from the ticket it runs in. */
export interface ReviewRecoveryContext {
	directory: string;
	worktree: string;
	/** The ticket's run.log, which carries every seat receipt line. */
	runLogPath: string;
	head(): Promise<string>;
	/** `git status --porcelain` of the worktree. */
	status(): Promise<string>;
	log(step: string, message?: string): void;
}

/**
 * Owner recovery: `sessions/<session>.completed.json` (`head`, `sessionPath`, `messageId`, optional
 * `missingSeatReceiptReason`) names a terminal review message already saved in the review's own session. It is
 * reconsumed only when it binds this worktree, the current clean head, one successful terminal assistant message
 * with one standalone verdict, no newer terminal message, and the seat stream and run.log line that produced it.
 */
export async function completedReview(
	context: ReviewRecoveryContext,
	name: ReviewSeat,
	session: string,
	sessionDir: string,
	logPath: string,
	resumeSession: string | undefined,
): Promise<string | undefined> {
	const receiptPath = join(context.directory, "sessions", `${session}.completed.json`);
	if (!existsSync(receiptPath)) return undefined;
	const invalid = (reason: string) => new TicketFailure(`review ${name} invalid completed receipt: ${reason}`);
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
		head?: string;
		sessionPath?: string;
		messageId?: string;
		missingSeatReceiptReason?: string;
	};
	const { head, sessionPath, messageId } = receipt;
	if (!head || !sessionPath || !messageId || !isAbsolute(sessionPath) || !existsSync(sessionPath))
		throw invalid("missing canonical session, head or message ID");
	if (resumeSession ? sessionPath !== resumeSession : !sessionPath.startsWith(`${sessionDir}/`))
		throw invalid("session is not this review's original root");
	if (head !== (await context.head()) || (await context.status()).trim())
		throw invalid("reviewed HEAD changed or worktree is dirty");
	const entries = sessionEntries(sessionPath);
	const header = entries[0];
	if (
		header?.type !== "session" ||
		header.cwd !== context.worktree ||
		header.git?.commit !== head ||
		header.rlmDepth !== 0
	)
		throw invalid("canonical root header does not bind this worktree and HEAD");
	const matches = entries.filter((entry) => entry.id === messageId);
	if (matches.length !== 1) throw invalid("message ID missing or ambiguous");
	const entry = matches[0]!;
	const message = entry.message;
	if (
		entry.type !== "message" ||
		message?.role !== "assistant" ||
		message.stopReason !== "stop" ||
		!Array.isArray(message.content) ||
		message.content.some((block) => block?.type === "toolCall")
	)
		throw invalid("not a successful terminal assistant message");
	const index = entries.indexOf(entry);
	if (
		entries
			.slice(index + 1)
			.some((later) => later.message?.role === "assistant" && later.message.stopReason === "stop")
	)
		throw invalid("a newer terminal assistant message supersedes the receipt");
	const final = contentText(message.content);
	const verdict = reviewVerdict(final);
	if (!verdict) throw invalid("missing or conflicting standalone verdict");
	if (
		/\b(?:reviewers?|delegated (?:work|reviews?)) (?:are |is )?(?:still )?(?:running|pending|outstanding)\b|\bI (?:will|must|need to) collect (?:their|the|child|reviewer)\b/i.test(
			final,
		)
	)
		throw invalid("terminal text contradicts completion of delegated review work");
	// The seat stream that carried this message must have reached agent_end.
	let matched = false;
	let seen = false;
	let ended = false;
	for (const line of existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : []) {
		let event: { type?: unknown; message?: unknown };
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "agent_start" || event.type === "message_start") matched = false;
		if (event.type === "message_end") {
			matched = isDeepStrictEqual(event.message, message);
			seen ||= matched;
		}
		if (event.type === "agent_end" && matched) ended = true;
	}
	if (seen && !ended) throw invalid("matching native message lacks terminal stream completion");
	if (
		!seen &&
		!(
			receipt.missingSeatReceiptReason &&
			message.responseId &&
			message.provider &&
			message.model &&
			message.usage &&
			!message.errorMessage
		)
	)
		throw invalid(
			"no matching seat stream; an explicit missing-receipt reason and native response provenance are required",
		);
	const nextUser = entries.slice(index + 1).find((later) => later.message?.role === "user");
	const after = Date.parse(entry.timestamp ?? "");
	const before = nextUser ? Date.parse(nextUser.timestamp ?? "") : Number.POSITIVE_INFINITY;
	const successful = readFileSync(context.runLogPath, "utf8")
		.split("\n")
		.some((line) => {
			const at = Date.parse(line.match(/^\[([^\]]+)\]/)?.[1] ?? "");
			return (
				at >= after &&
				at <= before &&
				(line.includes(`review:${name} incomplete rc=0;`) || line.endsWith(`review:${name} ${verdict}`))
			);
		});
	if (seen && !successful) throw invalid("no successful seat receipt for this terminal message");
	appendFileSync(
		join(context.directory, "review-reconsumption.jsonl"),
		`${JSON.stringify({ at: new Date().toISOString(), name, ...receipt, verdict, source: "canonical-native-terminal-message", responseId: message.responseId, seatReceipt: seen ? "native-agent-end-and-rc0" : "missing-after-controller-stop" })}\n`,
	);
	context.log(`review:${name}`, `${verdict} (reconsumed original terminal message ${messageId} at ${head})`);
	return verdict === "LANDABLE" ? "LANDABLE" : `DEFECTS\n${final}`;
}
