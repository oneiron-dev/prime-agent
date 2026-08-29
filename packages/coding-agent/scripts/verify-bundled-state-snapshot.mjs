#!/usr/bin/env node
/**
 * Fail the production bundle when it embeds a stale kernel snapshot helper.
 * The CLI executes dist/bundle/cli.js, not the unbundled dist module.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_MARKER = "// dist/core/kernel/state-snapshot.js";
const NEXT_MODULE_MARKER = "\n// dist/core/";
const REQUIRED_MARKERS = [
	"import builtins as _b, io, json, os, sys, datetime, pickletools",
	"if _b.isinstance(value, io.IOBase):",
	'b"_create_filehandle"',
	'"version": 2',
	'"purgedFileHandles": _b.sorted(unsafe_handles)',
	"unsafe legacy dill file-handle reducer rejected",
];
const FORBIDDEN_MARKERS = ['"version": 1'];

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

export function verifyBundledStateSnapshot(outdir) {
	const chunks = [];
	for (const name of readdirSync(outdir).filter((entry) => entry.endsWith(".js")).sort()) {
		const source = readFileSync(join(outdir, name), "utf8");
		const sections = snapshotSections(source);
		for (const section of sections) {
			for (const marker of REQUIRED_MARKERS) {
				if (!section.includes(marker)) {
					throw new Error(`bundled state snapshot in ${name} is missing required marker: ${marker}`);
				}
			}
			for (const marker of FORBIDDEN_MARKERS) {
				if (section.includes(marker)) {
					throw new Error(`bundled state snapshot in ${name} contains forbidden legacy marker: ${marker}`);
				}
			}
			const reducerGuard = section.indexOf('b"_create_filehandle"');
			const restoreLoad = section.lastIndexOf("dill.loads(blob)");
			if (reducerGuard === -1 || restoreLoad === -1 || reducerGuard >= restoreLoad) {
				throw new Error(`bundled state snapshot in ${name} does not guard legacy reducers before dill.loads`);
			}
			chunks.push(name);
		}
	}
	if (chunks.length === 0) {
		throw new Error(`no bundled state snapshot module found under ${outdir}`);
	}
	return { chunks: [...new Set(chunks)] };
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
