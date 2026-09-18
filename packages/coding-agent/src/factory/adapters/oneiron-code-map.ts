import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { assertByteLimit, FACTORY_EVIDENCE_LIMITS } from "../evidence.js";
import type { OneironPin } from "./oneiron-review.js";

export interface CapsuleSymbol {
	name: string;
	start: number;
	end: number;
}
export interface CapsuleFile {
	path: string;
	size: number;
	language: string;
	symbols: CapsuleSymbol[];
	imports: string[];
	truncated?: true;
}
export interface CapsuleCommand {
	cwd: string;
	command: string;
}
export interface OneironCapsule {
	version: 1;
	head: string;
	packet: OneironPin;
	capsule_seat: string;
	files: CapsuleFile[];
	tests: Array<{ path: string; command: CapsuleCommand | null }>;
	commands: { check: CapsuleCommand | null; test: CapsuleCommand[]; changelog: string | null };
	hotspots: Array<{ path: string; line: number; text: string }>;
	notes: Array<{ kind: "observation"; text: string }>;
}
export interface CapsulePacket {
	capsule?: boolean;
	allowedFiles?: string[];
	touchedFiles?: string[];
	namedSymbols?: string[];
}
export function readCapsulePacket(text: string): CapsulePacket {
	if (/^capsule:\s*(false|off)\s*$/im.test(text)) return { capsule: false };
	if (!text.trimStart().startsWith("{")) return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Invalid capsule packet JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capsule packet");
	const packet = value as CapsulePacket;
	if (packet.capsule !== undefined && typeof packet.capsule !== "boolean") throw new Error("Invalid capsule flag");
	for (const field of ["allowedFiles", "touchedFiles", "namedSymbols"] as const) {
		const entries = packet[field];
		if (entries !== undefined && (!Array.isArray(entries) || entries.some((s) => typeof s !== "string" || !s.trim())))
			throw new Error(`Invalid capsule packet ${field}`);
	}
	return packet;
}
export const CAPSULE_DETERMINISTIC_DEADLINE_MS = 30_000;
export const CAPSULE_TEST_LIMIT = 32;
export const CAPSULE_TEST_READ_BYTES = 256 * 1024;
const CAPSULE_TREE_FILE_LIMIT = 20_000;
const CAPSULE_CONTEXT_IDENTITY_BYTES = 16 * 1024;
const ignored = new Set([".git", "node_modules", "target", "dist", ".venv", ".claude", ".cache"]);
function gitPaths(workspace: string, args: string[], deadline: number): string[] {
	if (performance.now() >= deadline) return [];
	return execFileSync("git", args, {
		cwd: workspace,
		encoding: "utf8",
		timeout: Math.max(1, Math.min(20_000, Math.ceil(deadline - performance.now()))),
		maxBuffer: 8 * 1024 * 1024,
	})
		.split("\0")
		.filter(Boolean);
}
function treeFiles(workspace: string, deadline: number): string[] {
	const files: string[] = [];
	if (existsSync(join(workspace, ".git"))) {
		for (const path of [
			...new Set(gitPaths(workspace, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], deadline)),
		].sort()) {
			if (performance.now() >= deadline || files.length >= CAPSULE_TREE_FILE_LIMIT) break;
			files.push(path);
		}
		return files;
	}
	const visit = (path: string) => {
		if (performance.now() >= deadline || files.length >= CAPSULE_TREE_FILE_LIMIT) return;
		for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (performance.now() >= deadline || files.length >= CAPSULE_TREE_FILE_LIMIT) break;
			if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
			const child = join(path, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile()) files.push(relative(workspace, child));
		}
	};
	visit(workspace);
	return files;
}
export function capsuleOwnsPath(path: string, text: string, metadata = readCapsulePacket(text)): boolean {
	let mentioned = false;
	for (let index = path ? text.indexOf(path) : -1; index >= 0; index = text.indexOf(path, index + path.length)) {
		if (!/(?:^|[\s"'`()[\]{},;:!?])$/u.test(text.slice(0, index))) continue;
		const suffix = text.slice(index + path.length);
		if (/^(?:$|[\s"'`()[\]{},;:!?]|\.(?=$|[\s"'`()[\]{},;:!?]))/u.test(suffix)) {
			mentioned = true;
			break;
		}
	}
	return (
		mentioned ||
		[...(metadata.allowedFiles ?? []), ...(metadata.touchedFiles ?? [])].some((entry) => {
			const normalized = normalize(entry);
			return normalized === path || (isAbsolute(normalized) && normalized.endsWith(`${sep}${path}`));
		})
	);
}
const commonNames = new Set(
	`abstract arguments async await boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for from function if implements import in infer instanceof interface keyof let module namespace never new null number object of package private protected public readonly require return static string super switch symbol this throw true try type typeof undefined unknown var void while with yield self None True False and as assert def del elif except global is lambda nonlocal not or pass raise struct trait impl pub use mod mut ref match move unsafe where loop crate extern dyn system usage serve check emit action response ignored value data result error input output options source text name path file files test tests main constructor prototype length process console window document arguments then catch resolve reject state context request message body content result status config default exports module helper answer language imports rules`.split(
		/\s+/,
	),
);
function admissionName(name: string): boolean {
	return name.length >= 4 && /^[A-Za-z_$][\w$]*$/.test(name) && !commonNames.has(name);
}
function pathStem(path: string): string {
	return basename(path)
		.replace(/\.[^.]+$/, "")
		.replace(/(?:[._-](?:test|spec))$/, "")
		.replace(/^(?:test|spec)[._-]/, "")
		.replaceAll("_", "-");
}
function stemMatches(test: string, path: string): boolean {
	const testStem = pathStem(test),
		fileStem = pathStem(path);
	return testStem === fileStem || testStem.endsWith(`-${fileStem}`);
}
function capsuleLocalPath(workspace: string, path: string): string {
	const absolute = resolve(workspace, path),
		rel = relative(workspace, absolute);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("Capsule path outside workspace");
	if (
		existsSync(absolute) &&
		(lstatSync(absolute).isSymbolicLink() || realpathSync(absolute) !== join(realpathSync(workspace), rel))
	)
		throw new Error("Capsule does not follow symlinks");
	return rel;
}
export const CAPSULE_SYMBOL_SPAN_LIMIT = 20_000;
export function scanCapsuleSymbols(text: string, language: string): CapsuleSymbol[] {
	if (!["typescript", "rust", "python"].includes(language)) return [];
	const code = text.replace(
		/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/g,
		(match) => match.replace(/[^\r\n]/g, " "),
	);
	const lines = code.split("\n"),
		symbols: CapsuleSymbol[] = [];
	const pattern =
		language === "python"
			? /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/
			: language === "rust"
				? /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern)\s+)*(?:fn|struct|enum|trait|type|mod|static|const)\s+([A-Za-z_]\w*)/
				: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
	// Index matching brackets once; an unclosed declaration must not rescan the remaining file.
	const closes = new Int32Array(code.length).fill(-1),
		lineAt = new Uint32Array(code.length);
	const stack: number[] = [],
		starts = [0];
	let line = 0;
	for (let cursor = 0; cursor < code.length; cursor++) {
		const char = code[cursor];
		lineAt[cursor] = line;
		if (char === "\n") {
			line++;
			starts.push(cursor + 1);
		}
		if (char === "{" || char === "(" || char === "[") stack.push(cursor);
		else if (char === "}" || char === ")" || char === "]") {
			const open = stack.pop();
			if (open !== undefined) closes[open] = cursor;
		}
	}
	for (let index = 0; index < lines.length; index++) {
		const match = pattern.exec(lines[index]);
		if (!match) continue;
		let end = index;
		if (language === "python") {
			while (
				end + 1 < lines.length &&
				starts[end + 1] - starts[index] < CAPSULE_SYMBOL_SPAN_LIMIT &&
				(!lines[end + 1].trim() || /^\s/.test(lines[end + 1]))
			)
				end++;
			while (end > index && !lines[end].trim()) end--;
		} else {
			const limit = Math.min(code.length, starts[index] + CAPSULE_SYMBOL_SPAN_LIMIT);
			let opened = false,
				closed = false;
			for (let cursor = starts[index]; cursor < limit; cursor++) {
				const char = code[cursor];
				if (char === "{" || char === "(" || char === "[") {
					const close = closes[cursor];
					if (close < 0 || close >= limit) break;
					opened = true;
					cursor = close;
				}
				const currentLine = lineAt[cursor];
				if (
					char === ";" ||
					cursor === code.length - 1 ||
					(char === "\n" && (opened || pattern.test(lines[currentLine + 1] ?? "")))
				) {
					end = currentLine;
					closed = true;
					break;
				}
			}
			if (!closed) end = index;
		}
		symbols.push({ name: match[1], start: index + 1, end: end + 1 });
	}
	return symbols;
}
function language(path: string): string {
	return (
		({ ".ts": "typescript", ".tsx": "typescript", ".rs": "rust", ".py": "python" } as Record<string, string>)[
			extname(path)
		] ??
		(extname(path).slice(1) || "text")
	);
}
function imports(text: string, path: string, files: Set<string>): string[] {
	const found = new Set<string>();
	const add = (stem: string) => {
		for (const candidate of [
			stem,
			stem.replace(/\.js$/, ".ts"),
			`${stem}.ts`,
			`${stem}.tsx`,
			`${stem}/index.ts`,
			`${stem}.py`,
			`${stem}/__init__.py`,
			`${stem}.rs`,
			`${stem}/mod.rs`,
		])
			if (files.has(candidate)) {
				found.add(candidate);
				break;
			}
	};
	for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.[^"']+)["']/g))
		add(join(dirname(path), match[1]));
	for (const match of text.matchAll(/^\s*(?:pub\s+)?(?:use\s+crate::([\w:]+)|mod\s+(\w+)\s*;)/gm)) {
		if (match[1]) {
			const segments = match[1].split("::");
			while (segments.length) {
				add(join("src", ...segments));
				segments.pop();
			}
		} else add(join(dirname(path), match[2]));
	}
	for (const match of text.matchAll(/^(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm)) {
		const name = match[1] ?? match[2];
		add(name.startsWith(".") ? join(dirname(path), name.slice(1).replaceAll(".", "/")) : name.replaceAll(".", "/"));
	}
	return [...found].sort();
}
function rules(workspace: string, path: string): { text: string; cwd: string } {
	let directory = dirname(join(workspace, path));
	while (true) {
		const agents = join(directory, "AGENTS.md");
		if (existsSync(agents) && statSync(agents).isFile())
			return { text: readFileSync(agents, "utf8"), cwd: directory };
		if (directory === workspace) return { text: "", cwd: workspace };
		directory = dirname(directory);
	}
}
function capsuleShellPath(path: string): string {
	return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\"'\"'")}'`;
}
function testCommand(workspace: string, path: string): CapsuleCommand | null {
	const rule = rules(workspace, path);
	const marker = path.search(/\/(?:test|tests)\//);
	const cwd = marker >= 0 ? join(workspace, path.slice(0, marker)) : workspace;
	const testPath = relative(cwd, join(workspace, path));
	if (/\.[cm]?[jt]sx?$/.test(path)) {
		const template = rule.text.match(/`(npx tsx [^`\n]+ --run [^`\n]+)`/)?.[1];
		return template ? { cwd, command: template.replace(/--run\s+\S+/, `--run ${capsuleShellPath(testPath)}`) } : null;
	}
	if (path.endsWith(".py")) {
		const template = rule.text.match(/`((?:uv run )?(?:python3? -m )?pytest [^`\n]*?)([^\s`]+\.py)([^`\n]*)`/);
		return template ? { cwd, command: `${template[1]}${capsuleShellPath(testPath)}${template[3]}` } : null;
	}
	if (path.endsWith(".rs") && testPath.startsWith("tests/") && !testPath.slice(6).includes("/")) {
		const template = rule.text.match(/`(cargo test [^`\n]*?--test )([^\s`]+)([^`\n]*)`/);
		return template
			? { cwd, command: `${template[1]}${capsuleShellPath(testPath.slice(6, -3))}${template[3]}` }
			: null;
	}
	return null;
}
export function boundOneironCapsule(
	capsule: OneironCapsule,
	limit: number = FACTORY_EVIDENCE_LIMITS.capsuleBytes,
): OneironCapsule {
	const result = structuredClone(capsule),
		bytes = () => Buffer.byteLength(`${JSON.stringify(result)}\n`);
	while (bytes() > limit && result.notes.length) result.notes.pop();
	while (bytes() > limit && result.hotspots.length) result.hotspots.pop();
	while ((bytes() > limit || result.tests.length > CAPSULE_TEST_LIMIT) && result.tests.length) {
		result.tests.pop();
		result.commands.test = result.tests.flatMap((test) => (test.command ? [test.command] : []));
	}
	for (let i = result.files.length - 1; bytes() > limit && i >= 0; i--) {
		result.files[i].symbols = [];
		result.files[i].imports = [];
		result.files[i].truncated = true;
	}
	// Packet-owned identities and commands on retained tests must remain intact.
	assertByteLimit("capsule", bytes(), limit);
	return result;
}
export function generateOneironCapsule(
	workspace: string,
	head: string,
	packet: OneironPin,
	text: string,
): OneironCapsule {
	if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Capsule requires a full worktree head");
	const deadline = performance.now() + CAPSULE_DETERMINISTIC_DEADLINE_MS;
	const metadata = readCapsulePacket(text),
		paths = treeFiles(workspace, deadline),
		known = new Set(paths);
	const owned = new Set(
		[...(metadata.allowedFiles ?? []), ...(metadata.touchedFiles ?? [])].map((p) => capsuleLocalPath(workspace, p)),
	);
	for (const path of paths) {
		if (performance.now() >= deadline) break;
		if (capsuleOwnsPath(path, text, metadata)) owned.add(capsuleLocalPath(workspace, path));
	}
	const selected = new Set(owned);
	if (existsSync(join(workspace, ".git"))) {
		let identityBytes = 0;
		for (const path of [
			...gitPaths(workspace, ["diff", "--name-only", "-z", "HEAD"], deadline),
			...gitPaths(workspace, ["ls-files", "--others", "--exclude-standard", "-z"], deadline),
		]) {
			if (performance.now() >= deadline) break;
			if (selected.has(path)) continue;
			identityBytes += Buffer.byteLength(JSON.stringify(path)) + 128;
			if (identityBytes > CAPSULE_CONTEXT_IDENTITY_BYTES) break;
			selected.add(capsuleLocalPath(workspace, path));
		}
	}
	const files: CapsuleFile[] = [],
		hotspots: OneironCapsule["hotspots"] = [];
	for (const path of [...owned].sort().concat([...selected].filter((path) => !owned.has(path)).sort())) {
		if (performance.now() >= deadline) break;
		const absolute = join(workspace, path),
			size = existsSync(absolute) ? statSync(absolute).size : 0;
		const lang = language(path),
			source =
				size <= 1024 * 1024 && existsSync(absolute) && statSync(absolute).isFile()
					? readFileSync(absolute, "utf8")
					: "";
		const symbols = scanCapsuleSymbols(source, lang);
		files.push({
			path,
			size,
			language: lang,
			symbols,
			imports: imports(source, path, known),
			...(!source ? { truncated: true as const } : {}),
		});
		const lines = source.split(/\r?\n/);
		for (const symbol of symbols)
			if (
				(metadata.namedSymbols ?? []).includes(symbol.name) ||
				new RegExp(`\\b${symbol.name.replace(/[$]/g, "\\$")}\\b`).test(text)
			) {
				for (let line = symbol.start; line <= symbol.end && hotspots.length < 20; line++)
					hotspots.push({ path, line, text: lines[line - 1] });
			}
	}
	const namedSymbols = new Set(
		[
			...(metadata.namedSymbols ?? []),
			...files.filter((file) => owned.has(file.path)).flatMap((file) => file.symbols.map((symbol) => symbol.name)),
		].filter(admissionName),
	);
	const ranked: Array<{ path: string; stem: boolean; matches: number }> = [];
	for (const path of paths) {
		if (performance.now() >= deadline) break;
		if (extname(path) === ".json") continue;
		if (!/(?:^|\/)(?:test|tests)\/|(?:[._-]test|[._-]spec)\.[^.]+$|(?:^|\/)test_[^/]+\.py$/.test(path)) continue;
		const absolute = join(workspace, capsuleLocalPath(workspace, path));
		if (!existsSync(absolute)) continue;
		const info = statSync(absolute);
		if (!info.isFile() || info.size > CAPSULE_TEST_READ_BYTES) continue;
		const source = readFileSync(absolute, "utf8");
		const matched = new Set(
			[...source.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*(?![\w$])/g)]
				.map((match) => match[0])
				.filter((name) => namedSymbols.has(name)),
		);
		const stem = [...owned].some((selectedPath) => stemMatches(path, selectedPath));
		if (stem || matched.size) ranked.push({ path, stem, matches: matched.size });
	}
	ranked.sort((a, b) => Number(b.stem) - Number(a.stem) || b.matches - a.matches || a.path.localeCompare(b.path));
	const tests: OneironCapsule["tests"] = [];
	for (const { path } of ranked.slice(0, CAPSULE_TEST_LIMIT)) {
		if (performance.now() >= deadline) break;
		tests.push({ path, command: testCommand(workspace, path) });
	}
	const rule = rules(workspace, [...selected][0] ?? "AGENTS.md");
	const check = rule.text.match(/`((?:npm|bun) run check)`/)?.[1];
	const fragment = text.match(/(?:packages\/[\w-]+\/)?\.changes\/[\w-]+\.md/)?.[0];
	return boundOneironCapsule({
		version: 1,
		head,
		packet,
		capsule_seat: "none",
		files,
		tests,
		commands: {
			check: check ? { cwd: rule.cwd, command: check } : null,
			test: tests.flatMap((test) => (test.command ? [test.command] : [])),
			changelog: fragment ?? null,
		},
		hotspots,
		notes: [],
	});
}
