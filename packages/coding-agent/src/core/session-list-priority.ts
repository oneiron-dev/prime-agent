import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";

function uniqueIds(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))]
		: [];
}

/** Read an atomic preference snapshot without taking the UI mutation lock. */
export async function readPinnedSessionIds(path: string): Promise<string[]> {
	try {
		const state: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!state || typeof state !== "object" || !("version" in state) || state.version !== 1) return [];
		return uniqueIds("pinnedRootSessionIds" in state ? state.pinnedRootSessionIds : undefined);
	} catch {
		return [];
	}
}

async function readSessionId(path: string): Promise<string | undefined> {
	try {
		const handle = await open(path, "r");
		try {
			const chunks: Buffer[] = [];
			for (let position = 0; position < 64 * 1024; position += 4096) {
				const buffer = Buffer.alloc(4096);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
				const chunk = buffer.subarray(0, bytesRead);
				const newline = chunk.indexOf(0x0a);
				chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
				if (newline !== -1 || bytesRead < buffer.length) {
					const header: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					return header &&
						typeof header === "object" &&
						"type" in header &&
						header.type === "session" &&
						"id" in header &&
						typeof header.id === "string"
						? header.id
						: undefined;
				}
			}
			return undefined;
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/** Prioritize metadata IO, leaving final result sorting and header identity authoritative. */
export async function* prioritizeSessionFiles(
	files: string[],
	priorityIds: readonly string[] = [],
): AsyncGenerator<string> {
	const ids = uniqueIds(priorityIds);
	if (ids.length === 0) {
		yield* files;
		return;
	}
	const requested = new Set(ids);
	const byName = new Map(files.map((file) => [basename(file, ".jsonl"), file]));
	const resolved = new Map<string, string>();
	const examined = new Set<string>();
	const inspect = async (file: string) => {
		examined.add(file);
		const id = await readSessionId(file);
		if (id && requested.has(id) && !resolved.has(id)) resolved.set(id, file);
	};
	for (const id of ids) {
		const candidate = byName.get(id);
		if (candidate && !examined.has(candidate)) await inspect(candidate);
	}
	const prioritized = new Set<string>();
	for (const id of ids) {
		const file = resolved.get(id);
		if (file) {
			prioritized.add(file);
			yield file;
		}
	}
	// Known pins must not wait for a missing pin's legacy/custom filename search.
	// Resolve aliases with bounded headers, never full transcript scans.
	if (resolved.size < requested.size) {
		for (const file of files) {
			if (!examined.has(file)) await inspect(file);
			if (resolved.size === requested.size) break;
		}
	}
	for (const id of ids) {
		const file = resolved.get(id);
		if (file && !prioritized.has(file)) {
			prioritized.add(file);
			yield file;
		}
	}
	yield* files.filter((file) => !prioritized.has(file));
}
