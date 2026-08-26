import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import {
	type AgentsViewRow,
	type AgentsViewSection,
	type AgentsViewSectionHeadingRow,
	type AgentsViewSessionRow,
	buildAgentsViewRows,
	buildAgentsViewSectionRows,
	formatAgentsViewSectionHeadingLabel,
	isAgentsViewSectionHeadingRow,
	isAgentsViewSessionRow,
	resolveAgentsViewSelectionState,
	toggleAgentsViewCollapsedSection,
} from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { initTheme, stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "active-1",
		activeSessionId: "active-1",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

/** Reduce a rendered row to its plain text, dropping SGR codes and row markers. */
function stripAnsi(line: string): string {
	return line
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\0[^\0]*\0/g, "")
		.trimEnd();
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

function headingTitles(rows: readonly AgentsViewRow[]): string[] {
	return rows.filter(isAgentsViewSectionHeadingRow).map((row) => row.title);
}

describe("Agents View section heading rows", () => {
	it("emits a selectable heading for every section in order, including empty ones", () => {
		const running = summary({ sessionId: "running", id: "running", activity: "working" });
		const rows = buildAgentsViewSectionRows(buildAgentsViewRows([running]));

		expect(headingTitles(rows)).toEqual(["Pinned", "Running", "Idle", "Inactive"]);
		const headings = rows.filter(isAgentsViewSectionHeadingRow);
		expect(headings.every((row) => row.selectable)).toBe(true);
		expect(headings.map((row) => row.section)).toEqual<AgentsViewSection[]>([
			"pinned",
			"running",
			"idle",
			"inactive",
		]);
		// The Running heading precedes its only session row.
		const runningHeading = rows.findIndex((row) => row.kind === "section-heading" && row.section === "running");
		const runningRow = rows.findIndex((row) => row.kind === "agent" && row.sessionId === "running");
		expect(runningHeading).toBeGreaterThanOrEqual(0);
		expect(runningRow).toBe(runningHeading + 1);
	});

	it("hides a collapsed section's rows and labels the heading with its count", () => {
		const first = summary({ sessionId: "idle-1", id: "idle-1" });
		const second = summary({ sessionId: "idle-2", id: "idle-2" });
		const sessionRows = buildAgentsViewRows([first, second]);

		const expanded = buildAgentsViewSectionRows(sessionRows);
		const expandedHeading = expanded.filter(isAgentsViewSectionHeadingRow).find((row) => row.section === "idle");
		expect(expandedHeading?.collapsed).toBe(false);
		expect(formatAgentsViewSectionHeadingLabel(expandedHeading!)).toBe("Idle");
		expect(expanded.filter((row) => row.kind === "agent")).toHaveLength(2);

		const collapsed = buildAgentsViewSectionRows(sessionRows, {
			collapsedSections: new Set<AgentsViewSection>(["idle"]),
		});
		const collapsedHeading = collapsed.filter(isAgentsViewSectionHeadingRow).find((row) => row.section === "idle");
		expect(collapsedHeading?.collapsed).toBe(true);
		expect(collapsedHeading?.count).toBe(2);
		expect(formatAgentsViewSectionHeadingLabel(collapsedHeading!)).toBe("Idle 2");
		expect(collapsed.filter((row) => row.kind === "agent")).toHaveLength(0);
		// Every heading remains present and selectable while a section is collapsed.
		expect(collapsed.filter((row) => row.kind === "section-heading")).toHaveLength(4);
	});

	it("toggles one section without disturbing the others", () => {
		const collapsed = toggleAgentsViewCollapsedSection(["inactive"], "idle");
		expect(collapsed).toEqual<AgentsViewSection[]>(["idle", "inactive"]);
		expect(toggleAgentsViewCollapsedSection(collapsed, "inactive")).toEqual<AgentsViewSection[]>(["idle"]);
	});
});

describe("Agents View heading activation", () => {
	function headingSelf(collapsedSections: AgentsViewSection[] = []) {
		const sessionRows = buildAgentsViewRows([
			summary({ sessionId: "idle-1", id: "idle-1" }),
			summary({ sessionId: "idle-2", id: "idle-2" }),
		]);
		const self = {
			sessionRows,
			rows: [] as AgentsViewRow[],
			selectedIndex: 0,
			persistentState: { collapsedSections } as { collapsedSections: AgentsViewSection[] },
			applyAgentsViewStateOperation: vi.fn(() => true),
			expandedSubagentParents: new Set<string>(),
			programShownParents: new Set<string>(),
			scopeKey: undefined,
			selectionAnchorPending: false,
			isPendingDeleteRow: () => false,
			setStatusMessage: vi.fn(),
			syncSelectedRowState: vi.fn(),
			ui: { requestRender: vi.fn() },
			getCollapsedSectionsForDisplay() {
				return new Set(self.persistentState.collapsedSections);
			},
			hasNoSearchMatches() {
				return false;
			},
			getActiveSearchQuery() {
				return "";
			},
			findCollapsedSectionHeadingIndexForSelection() {
				return -1;
			},
			rebuildSectionRows() {
				self.rows = buildAgentsViewSectionRows(self.sessionRows, {
					collapsedSections: self.getCollapsedSectionsForDisplay(),
				});
			},
			rebuildRows() {
				self.rebuildSectionRows();
			},
			toggleSectionCollapsed(section: AgentsViewSection) {
				return invoke("toggleSectionCollapsed", self, section);
			},
			expandSelectedSection() {
				return invoke("expandSelectedSection", self);
			},
		};
		self.rebuildSectionRows();
		self.selectedIndex = self.rows.findIndex((row) => row.kind === "section-heading" && row.section === "idle");
		return self;
	}

	it("collapses and re-expands the selected section on Enter, keeping selection on the heading", () => {
		const self = headingSelf();
		expect(self.rows.filter((row) => row.kind === "agent")).toHaveLength(2);

		invoke("openSelected", self);

		expect(self.persistentState.collapsedSections).toEqual<AgentsViewSection[]>(["idle"]);
		expect(self.applyAgentsViewStateOperation).toHaveBeenCalledWith({
			type: "setSectionCollapsed",
			section: "idle",
			collapsed: true,
		});
		expect(self.rows.filter((row) => row.kind === "agent")).toHaveLength(0);
		const stillSelected = self.rows[self.selectedIndex];
		expect(stillSelected?.kind).toBe("section-heading");
		expect((stillSelected as AgentsViewSectionHeadingRow).section).toBe("idle");

		invoke("openSelected", self);

		expect(self.persistentState.collapsedSections).toEqual<AgentsViewSection[]>([]);
		expect(self.rows.filter((row) => row.kind === "agent")).toHaveLength(2);
		expect(self.rows[self.selectedIndex]?.kind).toBe("section-heading");
	});

	it("expands a collapsed section on Right and leaves an expanded one alone", () => {
		const self = headingSelf(["idle"]);
		expect(self.rows.filter((row) => row.kind === "agent")).toHaveLength(0);

		invoke("expandSelectedSection", self);

		expect(self.persistentState.collapsedSections).toEqual<AgentsViewSection[]>([]);
		expect(self.rows.filter((row) => row.kind === "agent")).toHaveLength(2);

		self.applyAgentsViewStateOperation.mockClear();
		invoke("expandSelectedSection", self);

		// Already expanded: no state change and nothing persisted.
		expect(self.persistentState.collapsedSections).toEqual<AgentsViewSection[]>([]);
		expect(self.applyAgentsViewStateOperation).not.toHaveBeenCalled();
		expect(self.rows.filter((row) => row.kind === "agent")).toHaveLength(2);
	});
});

describe("Agents View collapsed section search reveal", () => {
	function searchSelf(query: string, collapsedSections: AgentsViewSection[]) {
		const self = {
			rows: [] as AgentsViewRow[],
			sessionRows: buildAgentsViewRows([summary({ sessionId: "idle-1", id: "idle-1" })]),
			selectedIndex: 0,
			persistentState: { collapsedSections: [...collapsedSections] },
			editor: { getText: () => query },
			replyTarget: undefined,
			renameTarget: undefined,
			actionModeSearchQuery: undefined,
			getActiveSearchQuery() {
				return invoke("getActiveSearchQuery", self) as string;
			},
			getCollapsedSectionsForDisplay() {
				return invoke("getCollapsedSectionsForDisplay", self) as ReadonlySet<AgentsViewSection>;
			},
		};
		self.rows = buildAgentsViewSectionRows(self.sessionRows, {
			collapsedSections: self.getCollapsedSectionsForDisplay(),
		});
		return self;
	}

	it("reveals rows inside a collapsed section while searching, without saving the change", () => {
		const searching = searchSelf("idle-1", ["idle"]);
		expect(searching.rows.filter((row) => row.kind === "agent")).toHaveLength(1);
		// The saved preference is untouched, so clearing the query restores collapse.
		expect(searching.persistentState.collapsedSections).toEqual<AgentsViewSection[]>(["idle"]);

		const cleared = searchSelf("", ["idle"]);
		expect(cleared.rows.filter((row) => row.kind === "agent")).toHaveLength(0);
		expect(cleared.persistentState.collapsedSections).toEqual<AgentsViewSection[]>(["idle"]);
	});
});

describe("Agents View section rendering", () => {
	beforeAll(() => {
		initTheme("dark", true);
		return () => stopThemeWatcher();
	});

	function renderSelf(collapsedSections: AgentsViewSection[]) {
		const sessionRows = buildAgentsViewRows([summary({ sessionId: "idle-1", id: "idle-1", sessionName: "Alpha" })]);
		const self = {
			sessionRows,
			rows: buildAgentsViewSectionRows(sessionRows, { collapsedSections: new Set(collapsedSections) }),
			selectedIndex: 0,
			visibleListRows: () => 40,
			renderRow(row: AgentsViewRow, width: number) {
				return invoke("renderRow", self, row, width) as string;
			},
			renderSectionHeadingRow(row: AgentsViewSectionHeadingRow, width: number, selected: boolean) {
				return invoke("renderSectionHeadingRow", self, row, width, selected) as string;
			},
			isPendingDeleteRow: () => false,
			isPendingKillSubagentRow: () => false,
			getRowIcon: () => "*",
			formatRowIcon: (_section: string, icon: string) => icon,
		};
		return self;
	}

	function renderedLines(collapsedSections: AgentsViewSection[]): string[] {
		const self = renderSelf(collapsedSections);
		return (invoke("renderSessionRows", self, 80, 40) as string[]).map(stripAnsi);
	}

	it("shows clean expanded titles, No agents for an empty expanded section, and a count when collapsed", () => {
		const expanded = renderedLines([]);
		expect(expanded).toContain("Pinned");
		expect(expanded).toContain("Idle");
		// An empty expanded section keeps the existing placeholder.
		expect(expanded.indexOf("  No agents")).toBe(expanded.indexOf("Pinned") + 1);
		expect(expanded.some((line) => line.includes("Alpha"))).toBe(true);

		const collapsed = renderedLines(["pinned", "idle"]);
		// Collapsed headings carry the count and drop the "No agents" line.
		expect(collapsed).toContain("Pinned 0");
		expect(collapsed).toContain("Idle 1");
		expect(collapsed[collapsed.indexOf("Pinned 0") + 1]).not.toBe("  No agents");
		expect(collapsed.some((line) => line.includes("Alpha"))).toBe(false);
		// Expanded empty sections keep their plain title and placeholder.
		expect(collapsed).toContain("Running");
		expect(collapsed).toContain("Inactive");
		expect(collapsed[collapsed.indexOf("Running") + 1]).toBe("  No agents");
	});
});

describe("Agents View section rows across refresh", () => {
	it("keeps headings and collapse after a catalog refresh rebuilds the roster", () => {
		const record = {
			identity: "session:idle-1",
			identityAliases: ["session:idle-1"],
			section: "idle" as const,
			searchableText: "idle-1",
			daemon: summary({ sessionId: "idle-1", id: "idle-1" }),
		};
		const self = {
			rows: [] as AgentsViewRow[],
			sessionRows: [] as AgentsViewSessionRow[],
			selectedIndex: 0,
			scopedRecords: [record],
			scopeKey: undefined,
			expandedSubagentParents: new Set<string>(),
			programShownParents: new Set<string>(),
			persistentState: { collapsedSections: ["idle"] as AgentsViewSection[] },
			editor: { getText: () => "" },
			replyTarget: undefined,
			renameTarget: undefined,
			actionModeSearchQuery: undefined,
			unifiedRecords: [record],
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			getActiveSearchQuery() {
				return invoke("getActiveSearchQuery", self) as string;
			},
			getCollapsedSectionsForDisplay() {
				return invoke("getCollapsedSectionsForDisplay", self) as ReadonlySet<AgentsViewSection>;
			},
			getRowBuildOptions() {
				return invoke("getRowBuildOptions", self);
			},
			getFilteredRecords() {
				return invoke("getFilteredRecords", self);
			},
			rebuildSectionRows() {
				return invoke("rebuildSectionRows", self);
			},
			hasNoSearchMatches() {
				return invoke("hasNoSearchMatches", self) as boolean;
			},
		};

		invoke("rebuildRows", self);

		// A rebuild must not drop the heading rows or ignore the saved collapse.
		expect(headingTitles(self.rows)).toEqual(["Pinned", "Running", "Idle", "Inactive"]);
		expect(self.sessionRows).toHaveLength(1);
		expect(self.rows.filter((row) => row.kind === "agent")).toHaveLength(0);
		expect(self.rows.filter(isAgentsViewSectionHeadingRow).find((row) => row.section === "idle")?.count).toBe(1);
	});
});

describe("Agents View empty roster", () => {
	function rosterSelf(query: string, sessionRows: AgentsViewSessionRow[]) {
		const self = {
			rows: [] as AgentsViewRow[],
			sessionRows,
			persistentState: { collapsedSections: [] as AgentsViewSection[] },
			editor: { getText: () => query },
			replyTarget: undefined,
			renameTarget: undefined,
			actionModeSearchQuery: undefined,
			getActiveSearchQuery() {
				return invoke("getActiveSearchQuery", self) as string;
			},
			getCollapsedSectionsForDisplay() {
				return invoke("getCollapsedSectionsForDisplay", self) as ReadonlySet<AgentsViewSection>;
			},
			hasNoSearchMatches() {
				return invoke("hasNoSearchMatches", self) as boolean;
			},
		};
		return self;
	}

	it("keeps all four selectable headings when every section is empty", () => {
		const self = rosterSelf("", []);

		invoke("rebuildSectionRows", self);

		expect(headingTitles(self.rows)).toEqual(["Pinned", "Running", "Idle", "Inactive"]);
		const headings = self.rows.filter(isAgentsViewSectionHeadingRow);
		expect(headings.every((row) => row.selectable)).toBe(true);
		// Expanded headings carry no count, even at zero.
		expect(headings.map(formatAgentsViewSectionHeadingLabel)).toEqual(["Pinned", "Running", "Idle", "Inactive"]);
		expect(self.rows.filter(isAgentsViewSessionRow)).toHaveLength(0);
	});

	it("renders every empty expanded section with its own No agents line", () => {
		const self = rosterSelf("", []);
		invoke("rebuildSectionRows", self);
		const harness = {
			...self,
			selectedIndex: 0,
			visibleListRows: () => 40,
			renderRow(row: AgentsViewRow, width: number) {
				return invoke("renderRow", harness, row, width) as string;
			},
			renderSectionHeadingRow(row: AgentsViewSectionHeadingRow, width: number, selected: boolean) {
				return invoke("renderSectionHeadingRow", harness, row, width, selected) as string;
			},
			isPendingDeleteRow: () => false,
			isPendingKillSubagentRow: () => false,
			getRowIcon: () => "*",
			formatRowIcon: (_section: string, icon: string) => icon,
		};

		const lines = (invoke("renderSessionRows", harness, 80, 40) as string[]).map(stripAnsi);

		expect(lines).not.toContain("  No sessions match your search.");
		for (const title of ["Pinned", "Running", "Idle", "Inactive"]) {
			expect(lines).toContain(title);
			expect(lines[lines.indexOf(title) + 1]).toBe("  No agents");
		}
	});

	it("falls back to the single-line notice only when a search matches nothing", () => {
		const searching = rosterSelf("no-such-session", []);

		invoke("rebuildSectionRows", searching);

		expect(searching.rows).toEqual([]);
		const harness = {
			...searching,
			selectedIndex: 0,
			visibleListRows: () => 40,
		};
		const lines = (invoke("renderSessionRows", harness, 80, 40) as string[]).map(stripAnsi);
		expect(lines).toEqual(["Running", "  No sessions match your search."]);
	});
});

describe("Agents View initial selection with headings", () => {
	function rowsWithSession() {
		return buildAgentsViewSectionRows(buildAgentsViewRows([summary({ sessionId: "idle-1", id: "idle-1" })]));
	}

	it("prefers the first session row when no identity or key is stored", () => {
		const rows = rowsWithSession();
		// Headings are selectable and sit at index 0, so a fresh view must not
		// park the cursor on Pinned.
		expect(rows[0]?.kind).toBe("section-heading");

		const resolution = resolveAgentsViewSelectionState(rows, 0, undefined, undefined);

		expect(resolution.resolved).toBe(false);
		expect(rows[resolution.index]?.kind).toBe("agent");
	});

	it("still restores a saved heading identity", () => {
		const rows = rowsWithSession();
		const resolution = resolveAgentsViewSelectionState(rows, 0, "section:inactive", undefined);

		expect(resolution.resolved).toBe(true);
		const restored = rows[resolution.index];
		expect(restored && isAgentsViewSectionHeadingRow(restored) && restored.section).toBe("inactive");
	});

	it("keeps the bounded fallback when a stored session identity disappears", () => {
		const rows = rowsWithSession();
		const sessionIndex = rows.findIndex(isAgentsViewSessionRow);

		const resolution = resolveAgentsViewSelectionState(rows, sessionIndex, "session:gone", {
			sessionId: "gone",
		});

		expect(resolution.resolved).toBe(false);
		expect(resolution.index).toBe(sessionIndex);
	});

	it("selects the first heading when the roster is empty", () => {
		const rows = buildAgentsViewSectionRows([]);
		const resolution = resolveAgentsViewSelectionState(rows, 0, undefined, undefined);

		expect(resolution.index).toBe(0);
		expect(rows[0] && isAgentsViewSectionHeadingRow(rows[0]) && rows[0].section).toBe("pinned");
	});

	it("keeps a heading selection usable on an empty roster without a session row", () => {
		const rows = buildAgentsViewSectionRows([]);
		const self = {
			rows,
			selectedIndex: 0,
			selectionAnchorPending: false,
			selectedActiveSessionId: "stale" as string | undefined,
			selectedRowIdentity: undefined as string | undefined,
			selectedSessionKey: undefined as unknown,
			persistentState: {} as Record<string, unknown>,
			getSelectedSessionRow() {
				return invoke("getSelectedSessionRow", self);
			},
		};

		invoke("syncSelectedRowState", self);

		// A heading keeps its identity for restore but clears session-scoped state.
		expect(self.selectedRowIdentity).toBe("section:pinned");
		expect(self.selectedActiveSessionId).toBeUndefined();
		expect(self.selectedSessionKey).toBeUndefined();
		expect(invoke("getSelectedSessionRow", self)).toBeUndefined();
	});
});

describe("Agents View search and collapse interaction with selection anchors", () => {
	/**
	 * A realistic mode slice: real records, real row building, real selection
	 * plumbing. Only daemon I/O and rendering are stubbed.
	 */
	function makeView(options: { collapsedSections?: AgentsViewSection[] } = {}) {
		const idle = summary({ sessionId: "idle-1", id: "idle-1", activeSessionId: "idle-1", sessionName: "Alpha" });
		const inactive = summary({
			sessionId: "kept-1",
			id: "kept-1",
			activeSessionId: "kept-1",
			sessionName: "Zulu",
			activity: "working",
		});
		const records = [idle, inactive].map((daemon) => ({
			daemon,
			identity: `session:${daemon.sessionId}`,
			identityAliases: [`session:${daemon.sessionId}`, `active:${daemon.activeSessionId}`],
			section: daemon.activity === "working" ? ("running" as const) : ("idle" as const),
			searchableText: `${daemon.sessionName} ${daemon.sessionId}`,
		}));
		let query = "";
		const self = {
			rows: [] as AgentsViewRow[],
			sessionRows: [] as AgentsViewSessionRow[],
			selectedIndex: 0,
			selectedRowIdentity: undefined as string | undefined,
			selectedSessionKey: undefined as unknown,
			selectedActiveSessionId: undefined as string | undefined,
			selectionAnchorPending: false,
			scopedRecords: records,
			unifiedRecords: records,
			scopeKey: undefined,
			expandedSubagentParents: new Set<string>(),
			programShownParents: new Set<string>(),
			persistentState: {
				collapsedSections: [...(options.collapsedSections ?? [])] as AgentsViewSection[],
			} as Record<string, unknown>,
			replyTarget: undefined,
			renameTarget: undefined,
			actionModeSearchQuery: undefined,
			editor: { getText: () => query },
			applyAgentsViewStateOperation: vi.fn(() => true),
			setStatusMessage: vi.fn(),
			isPendingDeleteRow: () => false,
			finish: vi.fn(),
			ui: { requestRender: vi.fn() },
			setQuery(next: string) {
				query = next;
			},
			// Real implementations under test.
			getActiveSearchQuery: () => invoke("getActiveSearchQuery", self) as string,
			getCollapsedSectionsForDisplay: () =>
				invoke("getCollapsedSectionsForDisplay", self) as ReadonlySet<AgentsViewSection>,
			hasNoSearchMatches: () => invoke("hasNoSearchMatches", self) as boolean,
			getRowBuildOptions: () => invoke("getRowBuildOptions", self),
			getFilteredRecords: () => invoke("getFilteredRecords", self),
			rebuildSectionRows: () => invoke("rebuildSectionRows", self),
			rebuildRows: () => invoke("rebuildRows", self),
			restoreSelection: () => invoke("restoreSelection", self),
			findCollapsedSectionHeadingIndexForSelection: (identity: string | undefined, key: unknown) =>
				invoke("findCollapsedSectionHeadingIndexForSelection", self, identity, key) as number,
			syncSelectedRowState: () => invoke("syncSelectedRowState", self),
			getSelectedSessionRow: () => invoke("getSelectedSessionRow", self),
			getSelectableRowIndexes: () => invoke("getSelectableRowIndexes", self) as number[],
			openSelected: () => invoke("openSelected", self),
			expandSelectedSection: () => invoke("expandSelectedSection", self),
			toggleSectionCollapsed: (section: AgentsViewSection) => invoke("toggleSectionCollapsed", self, section),
			selectRow(predicate: (row: AgentsViewRow) => boolean) {
				self.selectedIndex = self.rows.findIndex(predicate);
				expect(self.selectedIndex).toBeGreaterThanOrEqual(0);
				self.syncSelectedRowState();
			},
			selectedSection() {
				const row = self.rows[self.selectedIndex];
				return row && isAgentsViewSectionHeadingRow(row) ? row.section : undefined;
			},
		};
		self.rebuildRows();
		return self;
	}

	it("re-anchors the original session when clearing a search that excluded it", () => {
		const view = makeView();
		view.selectRow((row) => isAgentsViewSessionRow(row) && row.sessionId === "idle-1");
		const anchor = view.selectedRowIdentity;
		expect(anchor).toBe("session:idle-1");

		// A search that excludes the selected session drops it from the rows.
		view.setQuery("Zulu");
		view.rebuildRows();
		expect(view.rows.some((row) => isAgentsViewSessionRow(row) && row.sessionId === "idle-1")).toBe(false);

		// Clearing the search must return selection to the original session, not
		// leave it stranded on whatever row was visible while filtered.
		view.setQuery("");
		view.rebuildRows();

		const selected = view.rows[view.selectedIndex];
		expect(selected && isAgentsViewSessionRow(selected) && selected.sessionId).toBe("idle-1");
		expect(view.selectionAnchorPending).toBe(false);
	});

	it("snaps to the owning section heading when clearing a search re-hides the selection", () => {
		const view = makeView({ collapsedSections: ["idle"] });
		// Idle is collapsed, so the session is only reachable through search.
		expect(view.rows.some((row) => isAgentsViewSessionRow(row) && row.sessionId === "idle-1")).toBe(false);

		view.setQuery("Alpha");
		view.rebuildRows();
		view.selectRow((row) => isAgentsViewSessionRow(row) && row.sessionId === "idle-1");

		view.setQuery("");
		view.rebuildRows();

		// The session is hidden by collapse, not missing: land on its own heading.
		expect(view.selectedSection()).toBe("idle");
		expect(view.selectionAnchorPending).toBe(false);
		expect(view.selectedRowIdentity).toBe("section:idle");

		// Enter from there expands Idle and never touches another section.
		view.applyAgentsViewStateOperation.mockClear();
		view.openSelected();

		expect(view.persistentState.collapsedSections).toEqual<AgentsViewSection[]>([]);
		expect(view.applyAgentsViewStateOperation).toHaveBeenCalledTimes(1);
		expect(view.applyAgentsViewStateOperation).toHaveBeenCalledWith({
			type: "setSectionCollapsed",
			section: "idle",
			collapsed: false,
		});
		expect(view.selectedSection()).toBe("idle");
		expect(view.rows.some((row) => isAgentsViewSessionRow(row) && row.sessionId === "idle-1")).toBe(true);
	});

	it("blocks Enter and Right on a fallback heading while a genuine anchor is pending", () => {
		const view = makeView({ collapsedSections: ["idle"] });
		// A desired session that exists in no catalog yet: a real pending anchor.
		view.selectedRowIdentity = "session:not-streamed-yet";
		view.selectedSessionKey = { sessionId: "not-streamed-yet" };
		view.persistentState.selectedRowIdentity = "session:not-streamed-yet";
		view.restoreSelection();
		expect(view.selectionAnchorPending).toBe(true);
		// Park the fallback on a heading to prove neither key can erase the anchor.
		view.selectedIndex = view.rows.findIndex(isAgentsViewSectionHeadingRow);
		const collapsedBefore = [...(view.persistentState.collapsedSections as AgentsViewSection[])];
		view.applyAgentsViewStateOperation.mockClear();
		view.setStatusMessage.mockClear();

		view.openSelected();
		view.expandSelectedSection();

		expect(view.persistentState.collapsedSections).toEqual(collapsedBefore);
		expect(view.applyAgentsViewStateOperation).not.toHaveBeenCalled();
		expect(view.selectionAnchorPending).toBe(true);
		expect(view.selectedRowIdentity).toBe("session:not-streamed-yet");
		expect(view.setStatusMessage).toHaveBeenCalledWith("Waiting for the selected session to load");
	});

	it("does not collapse while a search is active and does not advertise the blocked action", () => {
		const view = makeView();
		view.setQuery("Alpha");
		view.rebuildRows();
		view.selectedIndex = view.rows.findIndex(isAgentsViewSectionHeadingRow);
		const collapsedBefore = [...(view.persistentState.collapsedSections as AgentsViewSection[])];
		view.applyAgentsViewStateOperation.mockClear();

		view.openSelected();
		view.expandSelectedSection();

		// No preference written and no durable operation queued.
		expect(view.persistentState.collapsedSections).toEqual(collapsedBefore);
		expect(view.applyAgentsViewStateOperation).not.toHaveBeenCalled();

		// The hint must not promise a collapse/expand that search has disabled.
		const hintSelf = {
			...view,
			isCtrlCExitHintVisible: () => false,
			statusMessage: undefined,
			selectedRowCanShowProgram: () => false,
			renderReplyComposerHints: () => "",
		};
		const hints = stripAnsi(invoke("renderHints", hintSelf, 400) as string);
		// No key is advertised as collapsing or expanding a section while blocked.
		expect(hints).not.toContain("collapse section");
		expect(hints).not.toContain("expand section");
		expect(hints).toContain("sections stay open while searching");
	});

	it("keeps ordinary heading Enter and Right working with no search and no pending anchor", () => {
		const view = makeView();
		view.selectRow((row) => isAgentsViewSectionHeadingRow(row) && row.section === "idle");

		view.openSelected();
		expect(view.persistentState.collapsedSections).toEqual<AgentsViewSection[]>(["idle"]);
		expect(view.rows.some((row) => isAgentsViewSessionRow(row) && row.sessionId === "idle-1")).toBe(false);
		expect(view.selectedSection()).toBe("idle");

		view.expandSelectedSection();
		expect(view.persistentState.collapsedSections).toEqual<AgentsViewSection[]>([]);
		expect(view.rows.some((row) => isAgentsViewSessionRow(row) && row.sessionId === "idle-1")).toBe(true);
		expect(view.selectedSection()).toBe("idle");
	});
});
