#!/usr/bin/env node
/**
 * Fail production builds when either side of the current snapshot contract is stale:
 * JavaScript owns the configured limits; the packaged Python REPL owns serialization.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_MARKER = "// dist/core/kernel/state-snapshot.js";
const NEXT_MODULE_MARKER = "\n// dist/core/";
const JS_REQUIRED_MARKERS = [
	"DEFAULT_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024",
	"DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 8 * 1024 * 1024",
];
const JS_FORBIDDEN_MARKERS = [
	"DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024",
	"DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024",
];
const RUNTIME_REQUIRED_MARKERS = [
	"DEFAULT_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024",
	"DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 8 * 1024 * 1024",
	"def _has_filehandle_reducer(blob: bytes | bytearray) -> bool:",
	"candidate_names = stable_names + list(reversed(data_names))",
	"isinstance(value, io.IOBase)",
	"gc.collect()",
	'"version": 2',
	'"purgedFileHandles": sorted(unsafe_handles)',
	"unsafe legacy dill file-handle reducer rejected",
];
const RUNTIME_FORBIDDEN_MARKERS = [
	"DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024",
	"DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024",
	'"version": 1',
];

function snapshotSections(source) {
	const sections = [];
	let start = source.indexOf(MODULE_MARKER);
	while (start !== -1) {
		const next = source.indexOf(NEXT_MODULE_MARKER, start + MODULE_MARKER.length);
		sections.push(source.slice(start, next === -1 ? source.length : next));
		start = source.indexOf(MODULE_MARKER, start + MODULE_MARKER.length);
	}
	return sections;
}

function requireMarkers(source, required, forbidden, label) {
	for (const marker of required) {
		if (!source.includes(marker)) throw new Error(`${label} is missing required marker: ${marker}`);
	}
	for (const marker of forbidden) {
		if (source.includes(marker)) throw new Error(`${label} contains forbidden legacy marker: ${marker}`);
	}
}

export function verifyBundledStateSnapshot(outdir) {
	const chunks = [];
	for (const name of readdirSync(outdir).filter((entry) => entry.endsWith(".js")).sort()) {
		const source = readFileSync(join(outdir, name), "utf8");
		for (const section of snapshotSections(source)) {
			requireMarkers(section, JS_REQUIRED_MARKERS, JS_FORBIDDEN_MARKERS, `bundled state snapshot in ${name}`);
			chunks.push(name);
		}
	}
	if (chunks.length === 0) throw new Error(`no bundled state snapshot module found under ${outdir}`);

	const runtimePath = resolve(outdir, "..", "prime-agent-runtime", "src", "rlm", "repl.py");
	const runtime = readFileSync(runtimePath, "utf8");
	requireMarkers(runtime, RUNTIME_REQUIRED_MARKERS, RUNTIME_FORBIDDEN_MARKERS, `packaged REPL ${runtimePath}`);
	const reducerGuard = runtime.indexOf("if _has_filehandle_reducer(blob):");
	const restoreLoad = runtime.lastIndexOf("dill.loads(blob)");
	if (reducerGuard === -1 || restoreLoad === -1 || reducerGuard >= restoreLoad) {
		throw new Error(`packaged REPL ${runtimePath} does not guard legacy reducers before dill.loads`);
	}
	return { chunks: [...new Set(chunks)], runtime: runtimePath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const outdir = process.argv[2];
		if (!outdir) throw new Error("usage: verify-bundled-state-snapshot.mjs <bundle-dir>");
		const result = verifyBundledStateSnapshot(outdir);
		console.log(JSON.stringify({ status: "PASS", bundle: basename(outdir), ...result }));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
