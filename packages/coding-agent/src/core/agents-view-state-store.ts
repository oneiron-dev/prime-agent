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
	| { type: "setPin"; sessionId: string; pinned: boolean }
	| {
			group: string;
			type: "placePeer";
			sessionId: string;
			neighborSessionId: string;
			before: boolean;
			baseOrder: readonly string[];
	  }
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
export interface AgentsViewStateCoordination {
	acquire(path: string): () => void;
}

const empty = (): AgentsViewState => ({
	version: 1,
	pinnedRootSessionIds: [],
	manualOrder: Object.create(null) as AgentsViewManualOrder,
});

function report(message: string, cause?: unknown): Error {
	const error = new Error(message);
	if (cause instanceof Error) error.cause = cause;
	return error;
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.length > 0 && !seen.has(item)) {
			seen.add(item);
			result.push(item);
		}
	}
	return result;
}

function normalize(value: unknown): AgentsViewState {
	const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const manualOrder = Object.create(null) as AgentsViewManualOrder;
	if (input.manualOrder && typeof input.manualOrder === "object") {
		for (const key of Object.keys(input.manualOrder as object).sort()) {
			const ids = strings((input.manualOrder as Record<string, unknown>)[key]);
			if (ids.length > 0) manualOrder[key] = ids;
		}
	}
	return { version: 1, pinnedRootSessionIds: strings(input.pinnedRootSessionIds), manualOrder };
}

const defaultCoordination: AgentsViewStateCoordination = {
	acquire(path) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		for (let i = 0; i < 100; i++) {
			try {
				return lockSync(path, { realpath: false, lockfilePath: `${path}.lock`, stale: 30_000 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || i === 99) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
		throw new Error("Could not coordinate Agents View state");
	},
};

function withLock<T>(path: string, coordination: AgentsViewStateCoordination, action: () => T): T {
	const release = coordination.acquire(path);
	let actionError: unknown;
	try {
		return action();
	} catch (error) {
		actionError = error;
		throw error;
	} finally {
		try {
			release();
		} catch (error) {
			// A committed action remains successful even if housekeeping cannot unlock.
			appendRotatingLog(
				getAgentLogPath(),
				`Agents View state lock release failed: ${error instanceof Error ? error.message : "unknown error"}`,
			);
			if (actionError) {
				// Preserve the action failure; a release failure is only diagnostic.
			}
		}
	}
}

function readState(path: string): AgentsViewState {
	if (!existsSync(path)) return empty();
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || (parsed as Record<string, unknown>).version !== 1) {
		throw report("Agents View state is corrupt or unsupported; changes will not persist");
	}
	return normalize(parsed);
}

function writeState(path: string, state: AgentsViewState): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temp, "w", 0o600);
		writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
		try {
			const dir = openSync(dirname(path), "r");
			try {
				fsyncSync(dir);
			} finally {
				closeSync(dir);
			}
		} catch {}
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temp);
		} catch {}
	}
}

export class AgentsViewStateStore {
	constructor(
		private readonly path = getAgentsViewStatePath(),
		private readonly coordination: AgentsViewStateCoordination = defaultCoordination,
	) {}

	load(): AgentsViewStateResult {
		try {
			return { state: withLock(this.path, this.coordination, () => readState(this.path)) };
		} catch (cause) {
			const persistenceError = report("Agents View state could not be loaded; changes will not persist", cause);
			appendRotatingLog(getAgentLogPath(), `Agents View state: ${persistenceError.message}`);
			return { state: empty(), persistenceError };
		}
	}

	apply(operation: AgentsViewStateOperation): AgentsViewStateResult {
		try {
			return {
				state: withLock(this.path, this.coordination, () => {
					const state = readState(this.path);
					switch (operation.type) {
						case "setPin": {
							const pins = new Set(state.pinnedRootSessionIds);
							if (operation.pinned) pins.add(operation.sessionId);
							else pins.delete(operation.sessionId);
							state.pinnedRootSessionIds = [...pins];
							break;
						}
						case "placePeer": {
							const base = strings(operation.baseOrder);
							const current = state.manualOrder[operation.group] ?? [];
							const ids = [...current, ...base.filter((id) => !current.includes(id))];
							const target = ids.indexOf(operation.sessionId);
							const neighbor = ids.indexOf(operation.neighborSessionId);
							if (
								target >= 0 &&
								neighbor >= 0 &&
								((operation.before && target > neighbor) || (!operation.before && target < neighbor))
							) {
								[ids[target], ids[neighbor]] = [ids[neighbor]!, ids[target]!];
							}
							if (ids.length > 0) state.manualOrder[operation.group] = ids;
							break;
						}
						case "removeSession":
							state.pinnedRootSessionIds = state.pinnedRootSessionIds.filter((id) => id !== operation.sessionId);
							for (const key of Object.keys(state.manualOrder)) {
								if (key.startsWith(`children:${operation.sessionId}:`)) delete state.manualOrder[key];
								else
									state.manualOrder[key] = state.manualOrder[key]!.filter((id) => id !== operation.sessionId);
							}
							break;
					}
					const normalized = normalize(state);
					writeState(this.path, normalized);
					return normalized;
				}),
			};
		} catch (cause) {
			const persistenceError = report("Agents View state change will not persist", cause);
			appendRotatingLog(getAgentLogPath(), `Agents View state: ${persistenceError.message}`);
			return { state: empty(), persistenceError };
		}
	}
}
