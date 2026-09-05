import { describe, expect, it } from "vitest";
import type { AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/types.js";
import {
	filterUnifiedSessions,
	reconcileUnifiedSessions,
	UnifiedSessionSearchCache,
} from "../src/modes/agents-view/agents-view-state.js";
import {
	matchesSearchText,
	matchSearchText,
	PreparedSearchText,
	parseSearchQuery,
	prepareSearchMatcher,
} from "../src/modes/agents-view/session-view-search.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

function saved(id: string, overrides: Partial<AgentConnectionSavedSessionInfo> = {}): AgentConnectionSavedSessionInfo {
	return {
		path: `/tmp/prepared-search/${id}.jsonl`,
		id,
		cwd: "/tmp/prepared-search",
		name: id,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: "first message",
		allMessagesText: "full transcript with a distant needle",
		...overrides,
	};
}

function daemon(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "active-root",
		activeSessionId: "active-root",
		sessionId: "root",
		sessionFile: "/tmp/prepared-search/root.jsonl",
		cwd: "/tmp/prepared-search",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function preparedResult(corpus: PreparedSearchText, query: string) {
	const parsed = parseSearchQuery(query);
	return corpus.match({
		query,
		parsed,
		normalizedNeedles: parsed.tokens.map((token) => token.value.toLowerCase().replace(/\s+/g, " ").trim()),
	});
}

function expectReleased(corpus: PreparedSearchText): void {
	expect(Reflect.get(corpus, "normalizedText")).toBeUndefined();
	expect(Reflect.get(corpus, "lastQuery")).toBeUndefined();
	expect(Reflect.get(corpus, "lastResult")).toBeUndefined();
}

describe("prepared session search", () => {
	it("preserves full-text token, phrase, regex, Unicode, and fuzzy score semantics", () => {
		const texts = [
			"",
			"Release Planner /work/widget fixed the node\n  CVE",
			"A\t \nB  xx alpha Z",
			"a__b release planner rwfxce",
			"foo 5a A5 İSTANBUL ΟΣ α Σ こんにちは 😊",
			`${"nonmatching transcript ".repeat(500)}tailNeedle final phrase`,
		];
		const queries = [
			"",
			"ff",
			"rls plnr",
			'"node cve"',
			"re:/WORK/\\w+",
			"re:(",
			"re:",
			'"unclosed',
			"a5",
			"5a",
			'"a b"',
			"alpha",
			"こんにちは",
			"İST",
			'"α σ"',
			"😊",
			"re:^A[\\s\\S]*Z$",
			"rwfxce",
			"tailNeedle",
			'"final phrase"',
			"ab",
			"aa",
			"re:tailNeedle final phrase$",
		];
		for (const text of texts) {
			const corpus = new PreparedSearchText(text);
			for (const query of queries) {
				const expected = matchSearchText(text, parseSearchQuery(query));
				expect(preparedResult(corpus, query), `${query} score`).toEqual(expected);
				expect(prepareSearchMatcher(query)(corpus), `${query} prepared`).toBe(matchesSearchText(text, query));
				expect(prepareSearchMatcher(query)(text), `${query} raw`).toBe(matchesSearchText(text, query));
			}
		}
		expect(preparedResult(new PreparedSearchText("xx alpha"), "alpha").score).toBeCloseTo(0.3);
		expect(prepareSearchMatcher("rwfxce")(new PreparedSearchText(texts[1]!))).toBe(false);
		expect(prepareSearchMatcher('"final phrase"')(new PreparedSearchText(texts.at(-1)!))).toBe(true);
	});

	it("normalizes lazily and retains only the most recent query result without shared mutable results", () => {
		const corpus = new PreparedSearchText("ALPHA\n beta");
		expect(prepareSearchMatcher("")(corpus)).toBe(true);
		expect(Reflect.get(corpus, "normalizedText")).toBeUndefined();
		expect(prepareSearchMatcher("re:ALPHA\\n beta")(corpus)).toBe(true);
		expect(Reflect.get(corpus, "normalizedText")).toBeUndefined();
		expect(prepareSearchMatcher("alpha")(corpus)).toBe(true);
		expect(Reflect.get(corpus, "normalizedText")).toBe("alpha beta");
		const first = preparedResult(corpus, "alpha");
		first.matches = false;
		first.score = 1000;
		expect(preparedResult(corpus, "alpha")).toEqual({ matches: true, score: 0 });
		expect(prepareSearchMatcher("beta")(corpus)).toBe(true);
		expect(Reflect.get(corpus, "lastQuery")).toBe("beta");
		corpus.clear();
		expectReleased(corpus);
		expect(prepareSearchMatcher("alpha")(corpus)).toBe(true);
	});
});

describe("agents view search corpus cache", () => {
	it("reuses unchanged searchable fragments when daemon and saved metadata wrappers change", () => {
		const cache = new UnifiedSessionSearchCache();
		const live = daemon();
		const persisted = saved("root");
		const first = reconcileUnifiedSessions([live], [persisted], [], cache)[0]!;
		const corpus = first.preparedSearchText!;
		expect(prepareSearchMatcher("needle")(corpus)).toBe(true);
		const memo = Reflect.get(corpus, "lastResult");
		const updated = reconcileUnifiedSessions(
			[{ ...live, attachedClients: 12, isStreaming: true, usage: { inputTokens: 5, outputTokens: 6, cost: 7 } }],
			[
				{
					...persisted,
					modified: new Date(1234),
					messageCount: 100,
					usage: { inputTokens: 8, outputTokens: 9, cost: 10 },
				},
			],
			[],
			cache,
		)[0]!;
		expect(updated).not.toBe(first);
		expect(updated.preparedSearchText).toBe(corpus);
		expect(prepareSearchMatcher("needle")(updated.preparedSearchText!)).toBe(true);
		expect(Reflect.get(corpus, "lastResult")).toBe(memo);
		expect(updated.daemon?.usage?.cost).toBe(7);
		expect(updated.saved?.messageCount).toBe(100);
		expect(cache.size).toBe(1);
	});

	it("invalidates renamed or changed searchable data and releases the old normalized corpus", () => {
		const cache = new UnifiedSessionSearchCache();
		const first = reconcileUnifiedSessions([], [saved("root", { allMessagesText: "old payload" })], [], cache)[0]!;
		expect(prepareSearchMatcher('"old payload"')(first.preparedSearchText!)).toBe(true);
		const changed = reconcileUnifiedSessions(
			[],
			[saved("root", { name: "renamed", allMessagesText: "new payload" })],
			[],
			cache,
		)[0]!;
		expect(changed.preparedSearchText).not.toBe(first.preparedSearchText);
		expectReleased(first.preparedSearchText!);
		expect(prepareSearchMatcher('"old payload"')(changed.preparedSearchText!)).toBe(false);
		expect(prepareSearchMatcher('"new payload"')(changed.preparedSearchText!)).toBe(true);
		expect(prepareSearchMatcher("renamed")(changed.preparedSearchText!)).toBe(true);
	});

	it("preserves joined-field boundaries and raw regex whitespace exactly", () => {
		const live = daemon({ sessionName: "head\n", firstMessage: "middle" });
		const persisted = saved("root", { firstMessage: "left", allMessagesText: "right\n  tail" });
		const cache = new UnifiedSessionSearchCache();
		const uncached = reconcileUnifiedSessions([live], [persisted])[0]!;
		const cached = reconcileUnifiedSessions([live], [persisted], [], cache)[0]!;
		expect(cached.searchableText).toBe(uncached.searchableText);
		for (const query of ['"left right"', "re:left right\\n  tail", "re:head\\n middle", '"head middle"']) {
			expect(prepareSearchMatcher(query)(cached.preparedSearchText!)).toBe(true);
			expect(prepareSearchMatcher(query)(cached.preparedSearchText!)).toBe(
				matchesSearchText(uncached.searchableText, query),
			);
		}
	});

	it("prunes removed entries on an authoritative catalog and clears references on finish", () => {
		const cache = new UnifiedSessionSearchCache();
		const before = reconcileUnifiedSessions([], [saved("keep"), saved("remove")], [], cache);
		for (const record of before) prepareSearchMatcher("needle")(record.preparedSearchText!);
		const current = reconcileUnifiedSessions([], [saved("keep")], [], cache);
		expect(cache.size).toBe(1);
		expect(current[0]?.preparedSearchText).toBe(before[0]?.preparedSearchText);
		expectReleased(before[1]!.preparedSearchText!);
		cache.clear();
		expect(cache.size).toBe(0);
		expectReleased(current[0]!.preparedSearchText!);
		const reentered = reconcileUnifiedSessions([], [saved("keep")], [], cache);
		expect(reentered[0]?.preparedSearchText).not.toBe(current[0]?.preparedSearchText);
		reconcileUnifiedSessions([], [], [], cache);
		expect(cache.size).toBe(0);
	});

	it("filters prepared full text with the same ancestor closure and record order", () => {
		const cache = new UnifiedSessionSearchCache();
		const rows = reconcileUnifiedSessions(
			[
				daemon(),
				daemon({
					id: "child-active",
					activeSessionId: "child-active",
					sessionId: "child",
					sessionFile: "/tmp/prepared-search/child.jsonl",
					parentActiveSessionId: "active-root",
					runtimeKind: "subagent",
				}),
			],
			[saved("child", { allMessagesText: "uniquely searchable tail" }), saved("other")],
			[],
			cache,
		);
		const matches = prepareSearchMatcher('"uniquely searchable tail"');
		const prepared = filterUnifiedSessions(rows, (text, record) => matches(record.preparedSearchText ?? text));
		const legacy = filterUnifiedSessions(rows, (text) => matchesSearchText(text, '"uniquely searchable tail"'));
		expect(prepared).toEqual(legacy);
		expect(prepared.map((record) => record.daemon?.sessionId)).toEqual(["root", "child"]);
		expect(prepared[0]).toBe(rows[0]);
		expect(prepared[1]).toBe(rows[1]);
	});
});
