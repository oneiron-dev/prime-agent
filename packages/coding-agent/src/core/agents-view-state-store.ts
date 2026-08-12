import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { lockSync } from "proper-lockfile";
import { appendRotatingLog, getAgentLogPath, getAgentsViewStatePath } from "../config.js";

export const AGENTS_VIEW_STATE_VERSION = 1;
export type AgentsViewManualOrder = Record<string, string[]>;
export type AgentsViewStateOperation =
	| { type: "togglePin"; sessionId: string }
	| { type: "setGroupOrder"; group: string; orderedIds: readonly string[] }
	| { type: "removeSession"; sessionId: string };
export interface AgentsViewState {
	version: 1;
	pinnedRootSessionIds: string[];
	manualOrder: AgentsViewManualOrder;
}
export interface AgentsViewStateResult {
	state: AgentsViewState;
	persistenceError?: Error;
}

const EMPTY_STATE = (): AgentsViewState => ({ version: 1, pinnedRootSessionIds: [], manualOrder: {} });

function diagnostic(message: string, cause?: unknown): Error {
	const error = new Error(message);
	if (cause instanceof Error) error.cause = cause;
	return error;
}

function uniqueStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.length === 0 || seen.has(item)) continue;
		seen.add(item);
		result.push(item);
	}
	return result;
}

function normalize(value: unknown): AgentsViewState {
	const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const manualOrder: AgentsViewManualOrder = {};
	if (input.manualOrder && typeof input.manualOrder === "object") {
		for (const key of Object.keys(input.manualOrder as object).sort()) {
			const ids = uniqueStrings((input.manualOrder as Record<string, unknown>)[key]);
			if (ids.length > 0) manualOrder[key] = ids;
		}
	}
	return { version: 1, pinnedRootSessionIds: uniqueStrings(input.pinnedRootSessionIds), manualOrder };
}

function withLock<T>(path: string, action: () => T): T {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	let release: (() => void) | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			release = lockSync(path, { realpath: false, lockfilePath: `${path}.lock`, stale: 30_000 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 99) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (!release) throw new Error("Could not coordinate Agents View state");
	try {
		return action();
	} finally {
		release();
	}
}

function readState(path: string): AgentsViewState {
	if (!existsSync(path)) return EMPTY_STATE();
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || (parsed as Record<string, unknown>).version !== 1) {
		throw diagnostic("Agents View state is corrupt or unsupported; changes will not persist");
	}
	return normalize(parsed);
}

function writeState(path: string, state: AgentsViewState): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(tempPath, "w", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(tempPath, path);
		try {
			const dir = openSync(dirname(path), "r");
			try {
				fsyncSync(dir);
			} finally {
				closeSync(dir);
			}
		} catch {
			/* best effort */
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try {
			unlinkSync(tempPath);
		} catch {
			/* already renamed or unavailable */
		}
	}
}

export class AgentsViewStateStore {
	constructor(private readonly path = getAgentsViewStatePath()) {}
	get filePath(): string {
		return this.path;
	}
	load(): AgentsViewStateResult {
		try {
			return { state: withLock(this.path, () => readState(this.path)) };
		} catch (error) {
			const persistenceError = diagnostic("Agents View state could not be loaded; changes will not persist", error);
			appendRotatingLog(getAgentLogPath(), `Agents View state: ${persistenceError.message}`);
			return { state: EMPTY_STATE(), persistenceError };
		}
	}
	private mutate(operation: AgentsViewStateOperation): AgentsViewStateResult {
		try {
			return {
				state: withLock(this.path, () => {
					const state = readState(this.path);
					switch (operation.type) {
						case "togglePin": {
							const pins = new Set(state.pinnedRootSessionIds);
							if (pins.has(operation.sessionId)) pins.delete(operation.sessionId);
							else pins.add(operation.sessionId);
							state.pinnedRootSessionIds = [...pins];
							break;
						}
						case "setGroupOrder": {
							const requested = uniqueStrings(operation.orderedIds);
							const existing = state.manualOrder[operation.group] ?? [];
							state.manualOrder[operation.group] = [
								...requested,
								...existing.filter((id) => !requested.includes(id)),
							];
							break;
						}
						case "removeSession":
							for (const key of Object.keys(state.manualOrder)) {
								if (key.startsWith(`children:${operation.sessionId}:`)) delete state.manualOrder[key];
								else
									state.manualOrder[key] = state.manualOrder[key]!.filter((id) => id !== operation.sessionId);
							}
							state.pinnedRootSessionIds = state.pinnedRootSessionIds.filter((id) => id !== operation.sessionId);
							break;
					}
					state.pinnedRootSessionIds = uniqueStrings(state.pinnedRootSessionIds);
					state.manualOrder = normalize(state).manualOrder;
					writeState(this.path, state);
					return state;
				}),
			};
		} catch (error) {
			const persistenceError = diagnostic("Agents View state change will not persist", error);
			appendRotatingLog(getAgentLogPath(), `Agents View state: ${persistenceError.message}`);
			return { state: EMPTY_STATE(), persistenceError };
		}
	}
	apply(operation: AgentsViewStateOperation): AgentsViewStateResult {
		return this.mutate(operation);
	}
}
