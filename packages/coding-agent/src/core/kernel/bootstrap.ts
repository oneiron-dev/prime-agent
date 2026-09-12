import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../../config.js";
import { isProcessAlive, spawnHidden } from "../../utils/child-process.js";
import { tryAcquireDirLock } from "../../utils/dir-lock.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";

const BOOTSTRAP_SCHEMA = 9;
const PYTHON_VERSION = "3.11";
const RUNTIME_REQUIREMENT = "prime-agent-runtime";
// Serializes the kernel's user namespace so it can be revived across session
// resume. Internal-only; intentionally not surfaced to the model as an import.
const STATE_SNAPSHOT_REQUIREMENT = "dill";
const DEFAULT_RLM_EXTRA_PACKAGES = [
	{ uvArg: "requests", importName: "requests", promptLabel: "requests" },
	{ uvArg: "httpx", importName: "httpx", promptLabel: "httpx" },
	{ uvArg: "pyyaml", importName: "yaml", promptLabel: "yaml (PyYAML)" },
	{ uvArg: "tomli", importName: "tomli", promptLabel: "tomli" },
	{ uvArg: "python-dotenv", importName: "dotenv", promptLabel: "dotenv (python-dotenv)" },
	{ uvArg: "pandas", importName: "pandas", promptLabel: "pandas" },
	{ uvArg: "numpy", importName: "numpy", promptLabel: "numpy" },
	{ uvArg: "scipy", importName: "scipy", promptLabel: "scipy" },
	{ uvArg: "beautifulsoup4", importName: "bs4", promptLabel: "bs4 (Beautiful Soup)" },
	{ uvArg: "lxml", importName: "lxml", promptLabel: "lxml" },
	{ uvArg: "pydantic", importName: "pydantic", promptLabel: "pydantic" },
	{ uvArg: "tyro", importName: "tyro", promptLabel: "tyro" },
];
export const DEFAULT_RLM_EXTRA_UV_ARGS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.uvArg);
export const DEFAULT_RLM_EXTRA_IMPORT_NAMES = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.importName);
export const DEFAULT_RLM_EXTRA_IMPORT_LABELS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.promptLabel);
const WINDOWS_PATHEXT_DEFAULT = [".COM", ".EXE", ".BAT", ".CMD"];
const WINDOWS_SUPPORTED_EXECUTABLE_EXTENSIONS = new Set(
	WINDOWS_PATHEXT_DEFAULT.map((extension) => extension.toLowerCase()),
);

export interface BatchShimInvocation {
	args: string[];
	env: NodeJS.ProcessEnv;
}

/** Build a cmd.exe invocation without embedding user-controlled values in its command string. */
export function buildBatchShimInvocation(
	command: string,
	args: readonly string[],
	baseEnv: NodeJS.ProcessEnv,
	token = randomUUID().replaceAll("-", ""),
): BatchShimInvocation {
	if (!/^[A-Za-z0-9_]+$/.test(token)) {
		throw new Error("Windows batch shim token contains unsupported characters");
	}
	const values = [command, ...args];
	if (values.some((value) => /["\0\r\n]/.test(value))) {
		throw new Error("Windows batch shim paths and arguments cannot contain quotes, NUL, or line breaks");
	}
	const env = { ...baseEnv };
	const variables = values.map((value, index) => {
		const name = `PRIME_AGENT_BATCH_${token}_${index}`;
		env[name] = value;
		return `"%${name}%"`;
	});
	return {
		args: ["/d", "/v:off", "/s", "/c", `"${variables.join(" ")}"`],
		env,
	};
}

const UV_INSTALL_COMMAND = "curl -LsSf https://astral.sh/uv/install.sh | sh";
const REQUIRED_HARNESS_METHODS = [
	"create_memory",
	"update_memory",
	"delete_memory",
	"create_skill",
	"update_skill",
	"delete_skill",
	"create_subagent",
	"update_subagent",
	"delete_subagent",
	"create_prompt_note",
	"update_prompt_note",
	"delete_prompt_note",
	"record_refinement",
];
const RUNTIME_READY_CHECK = `import inspect; import rlm; from rlm import McpIntegration; import rlm.mcp as mcp; from rlm.harness import HarnessEntry; _harness_methods = ${JSON.stringify(REQUIRED_HARNESS_METHODS)}; assert callable(mcp.list_tools); assert callable(mcp.call_tool); assert callable(rlm.spawn); assert hasattr(rlm, 'rlm'); assert callable(rlm.rlm.spawn); assert inspect.signature(rlm.spawn).parameters['name'].default is inspect.Parameter.empty; assert not hasattr(rlm, 'run'); assert not hasattr(rlm.rlm, 'run'); assert callable(rlm.host_request); assert callable(rlm.find_models); assert callable(rlm.rlm.find_models); assert callable(rlm.create_session); assert callable(rlm.rlm.create_session); assert hasattr(rlm, 'harness'); assert hasattr(rlm, 'get_harness_state'); assert hasattr(rlm.rlm, 'harness'); assert hasattr(rlm.rlm, 'get_harness_state'); assert all(callable(getattr(_harness, _method, None)) for _harness in (rlm.harness, rlm.rlm.harness) for _method in _harness_methods); assert 'reference' in HarnessEntry.__dataclass_fields__; assert 'scope' in HarnessEntry.__dataclass_fields__; assert 'reference' in inspect.signature(rlm.harness.create_skill).parameters; assert 'reference' in inspect.signature(rlm.harness.update_skill).parameters; assert 'global_' in inspect.signature(rlm.harness.create_memory).parameters; assert 'global_' in inspect.signature(rlm.get_harness_state).parameters; assert not hasattr(rlm, 'background'); assert not hasattr(rlm.rlm, 'background'); from rlm.bash import BashHandle, BashResult; assert callable(rlm.bash); assert all(callable(getattr(BashHandle, _m, None)) for _m in ('tail', 'output', 'poll', 'kill')); assert {'exit_code', 'output', 'duration'} <= set(BashResult.__dataclass_fields__); import rlm.repl as _repl; assert callable(_repl.main); assert callable(_repl.emit); assert callable(_repl.host_request); assert callable(_repl.is_active); assert _repl.PROTOCOL_VERSION == 3; assert callable(rlm.emit); assert not hasattr(rlm, 'HOST_COMM_TARGET'); assert not hasattr(mcp, 'install_shutdown_hook')`;
const BOOTSTRAP_VERSION_FILE = ".bootstrap-version";
const BOOTSTRAP_LOCK_NAME = ".bootstrap.lock";
const BOOTSTRAP_LOCK_RETRY_MS = 100;
const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS = 30_000;

const DEFAULT_BOOTSTRAP_TIMEOUTS = {
	validationMs: 30_000,
	commandMs: 300_000,
	lockMs: 300_000,
	totalMs: 600_000,
};

interface InFlightBootstrap {
	promise: Promise<string>;
	controller: AbortController;
	waiters: Set<(error: unknown) => void>;
}

const inFlightEnsureKernelPython = new Map<string, InFlightBootstrap>();

class KernelBootstrapTimeoutError extends Error {
	constructor(stage: string, timeoutMs: number) {
		super(`Python kernel ${stage} timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
	}
}

export type KernelPythonSkill = PythonSkillRuntimeInfo;
export type KernelBootstrapProgressHandler = (message: string) => void;

export interface EnsureKernelPythonOptions {
	pythonSkills?: readonly KernelPythonSkill[];
	onProgress?: KernelBootstrapProgressHandler;
	signal?: AbortSignal;
	timeouts?: Partial<typeof DEFAULT_BOOTSTRAP_TIMEOUTS>;
}

function bootstrapTimeouts(options: EnsureKernelPythonOptions): typeof DEFAULT_BOOTSTRAP_TIMEOUTS {
	const timeouts = { ...DEFAULT_BOOTSTRAP_TIMEOUTS, ...options.timeouts };
	for (const [name, value] of Object.entries(timeouts)) {
		if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
			throw new Error(`Invalid Python kernel timeout ${name}: ${value}`);
		}
	}
	return timeouts;
}

function rethrowInterruption(error: unknown, options: EnsureKernelPythonOptions): void {
	options.signal?.throwIfAborted();
	if (error instanceof KernelBootstrapTimeoutError) throw error;
}

interface BootstrapPythonSkill {
	importName: string;
	packagePath: string;
	pyprojectPath: string;
	pyprojectHash: string;
}

interface BootstrapVersion {
	schema: number;
	runtime?: string;
	snapshot?: string;
	extraUvArgs?: string[];
	pythonSkills?: BootstrapPythonSkill[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function fileContentHash(filePath: string): string {
	try {
		return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
	} catch {
		return "unreadable";
	}
}

function normalizePythonSkills(pythonSkills: readonly KernelPythonSkill[] | undefined): BootstrapPythonSkill[] {
	const byKey = new Map<string, BootstrapPythonSkill>();
	const addSkill = (skill: Pick<KernelPythonSkill, "importName" | "packagePath" | "pyprojectPath">): void => {
		const packagePath = path.resolve(skill.packagePath);
		const pyprojectPath = path.resolve(skill.pyprojectPath);
		const key = `${skill.importName}\0${packagePath}`;
		if (byKey.has(key)) {
			return;
		}
		const bootstrapSkill: BootstrapPythonSkill = {
			importName: skill.importName,
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		byKey.set(key, bootstrapSkill);
		for (const dependencyName of readPythonSkillDependencyNames(bootstrapSkill)) {
			const siblingDependency = resolveSiblingPythonSkillDependency(bootstrapSkill, dependencyName);
			if (siblingDependency) {
				addSkill(siblingDependency);
			}
		}
	};
	for (const skill of pythonSkills ?? []) {
		addSkill(skill);
	}
	return [...byKey.values()].sort((a, b) => {
		const packageCompare = a.packagePath.localeCompare(b.packagePath);
		if (packageCompare !== 0) return packageCompare;
		return a.importName.localeCompare(b.importName);
	});
}

function readTomlProjectSection(pyprojectPath: string): string | undefined {
	try {
		const text = readFileSync(pyprojectPath, "utf-8");
		const match = text.match(/^\s*\[project\]\s*$/m);
		if (!match || match.index === undefined) {
			return undefined;
		}
		const sectionStart = match.index + match[0].length;
		const rest = text.slice(sectionStart);
		const nextSection = rest.search(/^\s*\[/m);
		return nextSection >= 0 ? rest.slice(0, nextSection) : rest;
	} catch {
		return undefined;
	}
}

function readPythonSkillProjectName(skill: BootstrapPythonSkill): string {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	const name = projectSection?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
	return name?.trim() || skill.importName.replaceAll("_", "-");
}

function parseDependencyPackageName(dependency: string): string | undefined {
	const withoutMarker = dependency.split(";")[0]?.trim() ?? "";
	if (!withoutMarker) {
		return undefined;
	}
	const match = withoutMarker.match(/^([A-Za-z0-9_.-]+)/);
	return match?.[1]?.replaceAll("_", "-").toLowerCase();
}

function findTomlArrayEnd(text: string, startIndex: number): number {
	let inQuote: '"' | "'" | undefined;
	let escaped = false;
	for (let index = startIndex; index < text.length; index++) {
		const char = text[index];
		if (inQuote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === inQuote) {
				inQuote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}
		if (char === "]") {
			return index;
		}
	}
	return -1;
}

function readPythonSkillDependencyNames(skill: BootstrapPythonSkill): Set<string> {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	if (!projectSection) {
		return new Set();
	}
	const dependenciesStart = projectSection.search(/^\s*dependencies\s*=\s*\[/m);
	if (dependenciesStart < 0) {
		return new Set();
	}
	const arrayStart = projectSection.indexOf("[", dependenciesStart);
	if (arrayStart < 0) {
		return new Set();
	}
	const arrayEnd = findTomlArrayEnd(projectSection, arrayStart + 1);
	if (arrayEnd < 0) {
		return new Set();
	}
	const dependenciesArray = projectSection.slice(arrayStart, arrayEnd + 1);
	const dependencies = new Set<string>();
	const dependencyPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
	for (const match of dependenciesArray.matchAll(dependencyPattern)) {
		const dependency = (match[1] ?? match[2] ?? "").replaceAll('\\"', '"').replaceAll("\\'", "'");
		const name = parseDependencyPackageName(dependency);
		if (name) {
			dependencies.add(name);
		}
	}
	return dependencies;
}

function resolveSiblingPythonSkillDependency(
	skill: BootstrapPythonSkill,
	dependencyName: string,
): BootstrapPythonSkill | undefined {
	const siblingsDir = path.dirname(skill.packagePath);
	for (const entry of readdirSync(siblingsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const packagePath = path.join(siblingsDir, entry.name);
		const pyprojectPath = path.join(packagePath, "pyproject.toml");
		if (!existsSync(pyprojectPath)) {
			continue;
		}
		const dependency: BootstrapPythonSkill = {
			importName: entry.name.replaceAll("-", "_"),
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		if (readPythonSkillProjectName(dependency).replaceAll("_", "-").toLowerCase() === dependencyName) {
			return dependency;
		}
	}
	return undefined;
}

function sortPythonSkillsForInstall(pythonSkills: readonly BootstrapPythonSkill[]): BootstrapPythonSkill[] {
	const byProjectName = new Map<string, BootstrapPythonSkill>();
	const originalIndex = new Map<BootstrapPythonSkill, number>();
	for (const [index, skill] of pythonSkills.entries()) {
		originalIndex.set(skill, index);
		byProjectName.set(readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill);
	}

	const dependenciesBySkill = new Map<BootstrapPythonSkill, BootstrapPythonSkill[]>();
	for (const skill of pythonSkills) {
		dependenciesBySkill.set(
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						byProjectName.get(dependencyName) ?? resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		);
	}

	const pending = new Set(pythonSkills);
	const sorted: BootstrapPythonSkill[] = [];
	while (pending.size > 0) {
		let progressed = false;
		for (const skill of [...pending].sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))) {
			const dependencies = dependenciesBySkill.get(skill) ?? [];
			if (dependencies.some((dependency) => pending.has(dependency))) {
				continue;
			}
			sorted.push(skill);
			pending.delete(skill);
			progressed = true;
		}
		if (!progressed) {
			// Cyclic local skill dependencies cannot be topologically ordered; keep a
			// deterministic order and let uv surface the packaging error if needed.
			sorted.push(...[...pending].sort((a, b) => a.packagePath.localeCompare(b.packagePath)));
			break;
		}
	}
	return sorted;
}

function formatPythonSkillInstallArgs(skill: BootstrapPythonSkill): string[] {
	return ["--editable", skill.packagePath];
}

function ensureKernelPythonKey(pythonSkills: readonly BootstrapPythonSkill[]): string {
	return [
		process.env.PRIME_AGENT_KERNEL_PYTHON ?? "",
		process.env.PRIME_AGENT_KERNEL_VENV ?? "",
		process.env.HOME ?? "",
		process.env.XDG_DATA_HOME ?? "",
		JSON.stringify(pythonSkills),
	].join("\0");
}

export function getKernelVenvDir(): string {
	const override = process.env.PRIME_AGENT_KERNEL_VENV;
	if (override) return path.resolve(expandHome(override));
	return path.join(os.homedir(), ".prime", "agent", "kernel-venv");
}

function getXdgKernelVenvDir(): string {
	const dataHome = process.env.XDG_DATA_HOME
		? path.resolve(expandHome(process.env.XDG_DATA_HOME))
		: path.join(os.homedir(), ".local", "share");
	return path.join(dataHome, "prime", "agent", "kernel-venv");
}

async function resolveWritableKernelVenvDir(): Promise<string> {
	const primary = getKernelVenvDir();
	try {
		await mkdir(path.dirname(primary), { recursive: true });
		return primary;
	} catch (primaryError) {
		if (process.env.PRIME_AGENT_KERNEL_VENV) {
			throw new Error(`couldn't create kernel venv parent directory for ${primary}: ${errorMessage(primaryError)}`);
		}

		const fallback = getXdgKernelVenvDir();
		try {
			await mkdir(path.dirname(fallback), { recursive: true });
			return fallback;
		} catch (fallbackError) {
			throw new Error(
				`couldn't create kernel venv directory at ${primary} or ${fallback}; set PRIME_AGENT_KERNEL_PYTHON to a python with a current prime-agent-runtime installed. ${errorMessage(fallbackError)}`,
			);
		}
	}
}

function isBatchShim(command: string): boolean {
	return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function run(
	command: string,
	args: string[],
	options: { stdio?: "ignore" | "inherit"; signal?: AbortSignal; timeoutMs: number; stage: string },
): Promise<void> {
	options.signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		// CPython must read UTF-8 .pth files even under a Windows legacy code page.
		const env = { ...process.env, ...(process.platform === "win32" ? { PYTHONUTF8: "1" } : {}) };
		const batch = isBatchShim(command) ? buildBatchShimInvocation(command, args, env) : undefined;
		const child = spawnHidden(batch ? (process.env.ComSpec ?? "cmd.exe") : command, batch?.args ?? args, {
			env: batch?.env ?? env,
			stdio: options.stdio ?? "ignore",
			detached: process.platform !== "win32",
			...(batch ? { windowsVerbatimArguments: true } : {}),
		});
		let interrupted: Error | undefined;
		const stop = (reason: Error): void => {
			if (interrupted) return;
			interrupted = reason;
			// Installers can spawn helpers. Kill their process group before releasing
			// the bootstrap lock so a retry cannot race a timed-out installer.
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch (error) {
				if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH"))
					child.kill("SIGKILL");
			}
		};
		const abort = (): void => {
			const reason: unknown = options.signal?.reason;
			stop(reason instanceof Error ? reason : new Error("Python kernel setup aborted"));
		};
		const timer = setTimeout(
			() => stop(new KernelBootstrapTimeoutError(options.stage, options.timeoutMs)),
			options.timeoutMs,
		);
		const cleanup = (): void => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		};
		child.once("error", (error) => {
			cleanup();
			reject(interrupted ?? error);
		});
		child.once("exit", (code, signal) => {
			cleanup();
			if (interrupted) {
				reject(interrupted);
				return;
			}
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${reason}`));
		});
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
}

function runInstall(command: string, args: string[], options: EnsureKernelPythonOptions): Promise<void> {
	return run(command, args, {
		signal: options.signal,
		timeoutMs: bootstrapTimeouts(options).commandMs,
		stage: "installation command",
	});
}

async function pythonImports(python: string, moduleName: string, options: EnsureKernelPythonOptions): Promise<boolean> {
	try {
		await run(python, ["-c", `import ${moduleName}`], {
			stdio: "ignore",
			signal: options.signal,
			timeoutMs: bootstrapTimeouts(options).validationMs,
			stage: `validation of ${moduleName}`,
		});
		return true;
	} catch (error) {
		rethrowInterruption(error, options);
		return false;
	}
}

async function hasPrimeAgentRuntime(python: string, options: EnsureKernelPythonOptions): Promise<boolean> {
	try {
		await run(python, ["-c", RUNTIME_READY_CHECK], {
			stdio: "ignore",
			signal: options.signal,
			timeoutMs: bootstrapTimeouts(options).validationMs,
			stage: "runtime validation",
		});
		return true;
	} catch (error) {
		rethrowInterruption(error, options);
		return false;
	}
}

async function missingRlmExtraImportLabels(python: string, options: EnsureKernelPythonOptions): Promise<string[]> {
	const missing: string[] = [];
	for (const pkg of DEFAULT_RLM_EXTRA_PACKAGES) {
		if (!(await pythonImports(python, pkg.importName, options))) {
			missing.push(pkg.promptLabel);
		}
	}
	return missing;
}

async function missingPythonSkillImportLabels(
	python: string,
	pythonSkills: readonly KernelPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<string[]> {
	const missing: string[] = [];
	for (const skill of pythonSkills) {
		if (!(await pythonImports(python, skill.importName, options))) {
			missing.push(`${skill.name} (${skill.importName})`);
		}
	}
	return missing;
}

function reportProgress(options: EnsureKernelPythonOptions, message: string): void {
	if (options.onProgress) {
		options.onProgress(message);
		return;
	}
	process.stderr.write(`${message}\n`);
}

function bootstrapLockDir(venv: string): string {
	return path.join(path.dirname(venv), `${path.basename(venv)}${BOOTSTRAP_LOCK_NAME}`);
}

async function lockMissingPidIsStale(lockDir: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockDir);
		return Date.now() - lockStat.mtimeMs > BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS;
	} catch {
		return false;
	}
}

async function acquireBootstrapLock(venv: string, options: EnsureKernelPythonOptions): Promise<() => Promise<void>> {
	const timeoutMs = bootstrapTimeouts(options).lockMs;
	const deadline = performance.now() + timeoutMs;
	const lockDir = bootstrapLockDir(venv);
	await mkdir(path.dirname(lockDir), { recursive: true });

	for (;;) {
		options.signal?.throwIfAborted();
		if (performance.now() >= deadline) throw new KernelBootstrapTimeoutError("install lock wait", timeoutMs);
		const attempt = await tryAcquireDirLock(lockDir, async (ownerPid) =>
			ownerPid === undefined ? !(await lockMissingPidIsStale(lockDir)) : isProcessAlive(ownerPid),
		);
		if (attempt === "acquired") {
			return () => rm(lockDir, { recursive: true, force: true });
		}
		if (attempt === "held") {
			await sleep(Math.min(BOOTSTRAP_LOCK_RETRY_MS, Math.max(1, deadline - performance.now())), undefined, {
				signal: options.signal,
			});
		}
	}
}

/** Try a bare command followed by supported PATHEXT extensions in the configured order. */
export function windowsExecutableCandidates(name: string, pathext: string | undefined): string[] {
	const extensions = (pathext ?? "")
		.split(";")
		.map((ext) => ext.trim().toLowerCase())
		.filter((ext) => WINDOWS_SUPPORTED_EXECUTABLE_EXTENSIONS.has(ext));
	const lowerName = name.toLowerCase();
	if (WINDOWS_PATHEXT_DEFAULT.some((ext) => lowerName.endsWith(ext.toLowerCase()))) {
		return [name];
	}
	const seen = new Set<string>([name.toLowerCase()]);
	const candidates = [name];
	for (const ext of extensions.length > 0 ? extensions : WINDOWS_PATHEXT_DEFAULT) {
		const candidate = `${name}${ext}`;
		if (seen.has(candidate.toLowerCase())) continue;
		seen.add(candidate.toLowerCase());
		candidates.push(candidate);
	}
	return candidates;
}

async function findExecutable(name: string): Promise<string | null> {
	const pathValue = process.env.PATH;
	if (!pathValue) return null;
	const candidates = process.platform === "win32" ? windowsExecutableCandidates(name, process.env.PATHEXT) : [name];
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		for (const candidate of candidates) {
			const fullPath = path.join(dir, candidate);
			if (await isExecutable(fullPath)) return fullPath;
		}
	}
	return null;
}

async function ensureUv(options: EnsureKernelPythonOptions): Promise<string> {
	options.signal?.throwIfAborted();
	const fromPath = await findExecutable("uv");
	if (fromPath) return fromPath;

	const localUv = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
	if (await isExecutable(localUv)) return localUv;

	const shouldInstallUv =
		process.env.PRIME_AGENT_INSTALL_UV === "1" || (!options.onProgress && (await confirmUvInstall(options.signal)));
	if (!shouldInstallUv) {
		throw new Error(
			`uv is required to set up the Python kernel. Install uv yourself: ${UV_INSTALL_COMMAND}, ` +
				"or set PRIME_AGENT_INSTALL_UV=1 to let prime-agent run that installer.",
		);
	}

	reportProgress(options, "› installing uv (one-time)…");
	try {
		await run("sh", ["-c", UV_INSTALL_COMMAND], {
			stdio: options.onProgress ? "ignore" : "inherit",
			signal: options.signal,
			timeoutMs: bootstrapTimeouts(options).commandMs,
			stage: "uv installation",
		});
	} catch (error) {
		throw new Error(
			`couldn't install uv from astral.sh; install it yourself: ${UV_INSTALL_COMMAND}, then re-run prime-agent. ${errorMessage(error)}`,
		);
	}

	if (await isExecutable(localUv)) return localUv;
	const installedFromPath = await findExecutable("uv");
	if (installedFromPath) return installedFromPath;
	throw new Error("uv install completed but binary not found at ~/.local/bin/uv");
}

async function confirmUvInstall(signal?: AbortSignal): Promise<boolean> {
	if (process.env.PRIME_AGENT_INSTALL_UV === "0") return false;
	if (!stdin.isTTY || !stderr.isTTY) return false;

	const rl = createInterface({ input: stdin, output: stderr });
	try {
		const answer = (
			await rl.question("Prime Agent needs uv to set up Python. Install uv from astral.sh now? [Y/n] ", { signal })
		)
			.trim()
			.toLowerCase();
		return answer !== "n" && answer !== "no";
	} finally {
		rl.close();
	}
}

async function readBootstrapVersion(venv: string): Promise<BootstrapVersion | null> {
	try {
		const raw = await readFile(path.join(venv, BOOTSTRAP_VERSION_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.schema !== "number") return null;
		const extraUvArgs =
			Array.isArray(parsed.extraUvArgs) &&
			parsed.extraUvArgs.every((v: unknown): v is string => typeof v === "string")
				? (parsed.extraUvArgs as string[])
				: undefined;
		let pythonSkills: BootstrapPythonSkill[] | undefined;
		if (Array.isArray(parsed.pythonSkills)) {
			if (
				!parsed.pythonSkills.every((v: unknown): v is BootstrapPythonSkill => {
					if (!isRecord(v)) return false;
					return (
						typeof v.importName === "string" &&
						typeof v.packagePath === "string" &&
						typeof v.pyprojectPath === "string" &&
						typeof v.pyprojectHash === "string"
					);
				})
			) {
				return null;
			}
			pythonSkills = parsed.pythonSkills as BootstrapPythonSkill[];
		}
		return {
			schema: parsed.schema,
			runtime: typeof parsed.runtime === "string" ? parsed.runtime : undefined,
			snapshot: typeof parsed.snapshot === "string" ? parsed.snapshot : undefined,
			extraUvArgs,
			pythonSkills,
		};
	} catch {
		return null;
	}
}

function extraUvArgsMatch(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function pythonSkillsMatch(a: BootstrapPythonSkill[] | undefined, b: readonly BootstrapPythonSkill[]): boolean {
	const left = a ?? [];
	if (left.length !== b.length) return false;
	return left.every((skill, index) => {
		const expected = b[index];
		return (
			skill.importName === expected.importName &&
			skill.packagePath === expected.packagePath &&
			skill.pyprojectPath === expected.pyprojectPath &&
			skill.pyprojectHash === expected.pyprojectHash
		);
	});
}

function bootstrapVersionCurrent(
	version: BootstrapVersion | null,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): boolean {
	return (
		version !== null &&
		bootstrapBaseVersionCurrent(version, runtimeIdentity) &&
		pythonSkillsMatch(version.pythonSkills, pythonSkills)
	);
}

function bootstrapBaseVersionCurrent(version: BootstrapVersion | null, runtimeIdentity: string): boolean {
	return (
		version?.schema === BOOTSTRAP_SCHEMA &&
		version.runtime === runtimeIdentity &&
		version.snapshot === STATE_SNAPSHOT_REQUIREMENT &&
		extraUvArgsMatch(version.extraUvArgs, DEFAULT_RLM_EXTRA_UV_ARGS)
	);
}

async function writeBootstrapVersion(
	venv: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<void> {
	const version: BootstrapVersion = {
		schema: BOOTSTRAP_SCHEMA,
		runtime: runtimeIdentity,
		snapshot: STATE_SNAPSHOT_REQUIREMENT,
		extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
		pythonSkills: [...pythonSkills],
	};
	await writeFile(path.join(venv, BOOTSTRAP_VERSION_FILE), `${JSON.stringify(version)}\n`, "utf8");
}

function runtimeCandidateDirs(): string[] {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	// Compiled executables use a flat sidecar layout; Node packages keep sources in dist/.
	// Resolve both from the physical package directory, outside Bun's virtual filesystem.
	return [
		path.join(getPackageDir(), "prime-agent-runtime"),
		path.join(getPackageDir(), "dist", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "..", "..", "..", "prime-agent-runtime"),
	];
}

async function resolveRuntimeSourceDir(): Promise<string | null> {
	for (const candidate of runtimeCandidateDirs()) {
		if (await exists(path.join(candidate, "pyproject.toml"))) {
			return candidate;
		}
	}
	return null;
}

// Identity of the runtime to be installed. For a local source checkout this is a
// content hash of every rlm/*.py file plus pyproject.toml, so any runtime code or
// dependency change invalidates an existing venv automatically. Falls back to the
// bare package name when the runtime resolves to a registry install (no local source).
export async function resolveRuntimeIdentity(): Promise<string> {
	const sourceDir = await resolveRuntimeSourceDir();
	if (!sourceDir) return RUNTIME_REQUIREMENT;
	return hashRuntimeSource(sourceDir);
}

// Throws if the local source can't be read. A failure here must surface rather than
// fall back to RUNTIME_REQUIREMENT: that constant is the registry-install identity, and
// recording it for a local checkout would permanently mask later source changes.
async function hashRuntimeSource(sourceDir: string): Promise<string> {
	const rlmDir = path.join(sourceDir, "src", "rlm");
	const files: string[] = [path.join(sourceDir, "pyproject.toml")];
	async function collect(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await collect(full);
			} else if (entry.isFile() && entry.name.endsWith(".py")) {
				files.push(full);
			}
		}
	}
	await collect(rlmDir);
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(sourceDir, file));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

export function kernelVenvPython(venv: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

async function bootstrapVenv(
	venv: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	await mkdir(path.dirname(venv), { recursive: true });
	const uv = await ensureUv(options);
	const python = kernelVenvPython(venv);
	const sourceDir = await resolveRuntimeSourceDir();
	const runtimeRequirement = sourceDir ?? RUNTIME_REQUIREMENT;
	const runtimeIdentity = await resolveRuntimeIdentity();

	await runInstall(uv, ["python", "install", PYTHON_VERSION], options);
	await runInstall(uv, ["venv", venv, "--python", PYTHON_VERSION, "--seed"], options);
	await runInstall(
		uv,
		[
			"pip",
			"install",
			"--python",
			python,
			runtimeRequirement,
			STATE_SNAPSHOT_REQUIREMENT,
			...DEFAULT_RLM_EXTRA_UV_ARGS,
		],
		options,
	);
	await syncPythonSkills(uv, venv, python, runtimeIdentity, pythonSkills, options);
}

async function syncPythonSkills(
	uv: string,
	venv: string,
	python: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	const version = await readBootstrapVersion(venv);
	const installedPythonSkills: BootstrapPythonSkill[] = [];
	const currentPythonSkills = new Map(
		(version?.pythonSkills ?? []).map((skill) => [`${skill.importName}\0${skill.packagePath}`, skill]),
	);
	const pythonSkillsByProjectName = new Map(
		pythonSkills.map((skill) => [readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill]),
	);
	const dependenciesBySkill = new Map(
		pythonSkills.map((skill) => [
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						pythonSkillsByProjectName.get(dependencyName) ??
						resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		]),
	);

	for (const skill of sortPythonSkillsForInstall(pythonSkills)) {
		const existingSkill = currentPythonSkills.get(`${skill.importName}\0${skill.packagePath}`);
		if (existingSkill?.pyprojectPath === skill.pyprojectPath && existingSkill.pyprojectHash === skill.pyprojectHash) {
			installedPythonSkills.push(skill);
			continue;
		}

		const localDependencies = dependenciesBySkill.get(skill) ?? [];
		const localDependencyArgs = localDependencies
			.filter((dependency) => {
				const installedDependency = currentPythonSkills.get(`${dependency.importName}\0${dependency.packagePath}`);
				const installedThisSync = installedPythonSkills.some(
					(installed) =>
						installed.importName === dependency.importName &&
						installed.packagePath === dependency.packagePath &&
						installed.pyprojectPath === dependency.pyprojectPath &&
						installed.pyprojectHash === dependency.pyprojectHash,
				);
				return !(
					installedThisSync ||
					(installedDependency?.pyprojectPath === dependency.pyprojectPath &&
						installedDependency.pyprojectHash === dependency.pyprojectHash)
				);
			})
			.flatMap(formatPythonSkillInstallArgs);

		try {
			await runInstall(
				uv,
				["pip", "install", "--python", python, ...formatPythonSkillInstallArgs(skill), ...localDependencyArgs],
				options,
			);
			installedPythonSkills.push(
				skill,
				...localDependencies.filter((dependency) => !installedPythonSkills.includes(dependency)),
			);
		} catch (error) {
			rethrowInterruption(error, options);
			reportProgress(
				options,
				`Warning: Python skill ${skill.importName} failed to install and will be unavailable: ${errorMessage(error)}`,
			);
		}
	}
	options.signal?.throwIfAborted();
	await writeBootstrapVersion(venv, runtimeIdentity, installedPythonSkills);
}

async function kernelBaseReady(
	python: string,
	venv: string,
	runtimeIdentity: string,
	options: EnsureKernelPythonOptions,
): Promise<boolean> {
	return (
		(await hasPrimeAgentRuntime(python, options)) &&
		bootstrapBaseVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity)
	);
}

async function kernelReady(
	python: string,
	venv: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<boolean> {
	return (
		(await hasPrimeAgentRuntime(python, options)) &&
		bootstrapVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity, pythonSkills)
	);
}

function formatBootstrapFailure(error: unknown): Error {
	return new Error(
		`Failed to set up the Python kernel runtime. ${errorMessage(error)}\n` +
			"First-time setup needs internet to install uv, Python, prime-agent-runtime, and default Python packages; once set up, prime-agent runs offline. " +
			"An interrupted runtime upgrade needs network once more, so re-run this while online. " +
			"Set PRIME_AGENT_KERNEL_PYTHON to a Python with a current prime-agent-runtime and default Python packages installed to skip auto-bootstrap.",
	);
}

async function ensureKernelPythonUncached(
	options: EnsureKernelPythonOptions,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<string> {
	options.signal?.throwIfAborted();
	const override = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (override) {
		const python = path.resolve(expandHome(override));
		if (isBatchShim(python)) {
			throw new Error(
				`PRIME_AGENT_KERNEL_PYTHON must point directly to a Python executable, not a Windows batch shim: ${python}`,
			);
		}
		const missing: string[] = [];
		if (!(await hasPrimeAgentRuntime(python, options))) {
			missing.push(
				"a current prime-agent-runtime with callable rlm.spawn, rlm.create_session, rlm.host_request, and explicit harness CRUD methods",
			);
		}
		if (missing.length === 0) {
			const missingExtraImports = await missingRlmExtraImportLabels(python, options);
			if (missingExtraImports.length > 0) {
				missing.push(`default Python packages (${missingExtraImports.join(", ")})`);
			}
		}
		if (missing.length === 0 && pythonSkills.length > 0) {
			const missingPythonSkills = await missingPythonSkillImportLabels(python, options.pythonSkills ?? [], options);
			if (missingPythonSkills.length > 0) {
				reportProgress(
					options,
					`Warning: Python skills unavailable in PRIME_AGENT_KERNEL_PYTHON and will be disabled: ${missingPythonSkills.join(", ")}`,
				);
			}
		}
		if (missing.length === 0) return python;
		throw new Error(`PRIME_AGENT_KERNEL_PYTHON points to a Python missing ${missing.join(" and ")}: ${python}`);
	}

	const venv = await resolveWritableKernelVenvDir();
	const python = kernelVenvPython(venv);
	const runtimeIdentity = await resolveRuntimeIdentity();
	if (await kernelReady(python, venv, runtimeIdentity, pythonSkills, options)) return python;

	const releaseLock = await acquireBootstrapLock(venv, options);
	try {
		if (await kernelReady(python, venv, runtimeIdentity, pythonSkills, options)) return python;
		if (await kernelBaseReady(python, venv, runtimeIdentity, options)) {
			await syncPythonSkills(await ensureUv(options), venv, python, runtimeIdentity, pythonSkills, options);
			return python;
		}

		options.signal?.throwIfAborted();
		const hadVenv = existsSync(venv);
		reportProgress(options, "› setting up python kernel (one-time, ~30s)…");
		if (hadVenv) {
			reportProgress(options, "rebuilding kernel venv");
			await rm(venv, { recursive: true, force: true });
		}

		await bootstrapVenv(venv, pythonSkills, options);
	} catch (error) {
		throw formatBootstrapFailure(error);
	} finally {
		await releaseLock().catch(() => undefined);
	}

	reportProgress(options, "✓ ready");
	return python;
}

function waitForBootstrap(entry: InFlightBootstrap, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (result: { value: string } | { error: unknown }): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			entry.waiters.delete(sharedAbort);
			if ("value" in result) resolve(result.value);
			else reject(result.error);
		};
		const abort = (): void => {
			finish({ error: signal?.reason ?? new Error("Python kernel setup aborted") });
			if (entry.waiters.size === 0) entry.controller.abort(signal?.reason);
		};
		const sharedAbort = (error: unknown): void => finish({ error });
		signal?.addEventListener("abort", abort, { once: true });
		entry.waiters.add(sharedAbort);
		entry.promise.then(
			(value) => finish({ value }),
			(error: unknown) => finish({ error }),
		);
		if (signal?.aborted) abort();
		else if (entry.controller.signal.aborted) sharedAbort(entry.controller.signal.reason);
	});
}

export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
	if (options.signal?.aborted) return Promise.reject(options.signal.reason);
	const pythonSkills = normalizePythonSkills(options.pythonSkills);
	const timeouts = bootstrapTimeouts(options);
	const key = `${ensureKernelPythonKey(pythonSkills)}\0${JSON.stringify(timeouts)}`;
	const existing = inFlightEnsureKernelPython.get(key);
	if (existing) return waitForBootstrap(existing, options.signal);

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new KernelBootstrapTimeoutError("setup", timeouts.totalMs)),
		timeouts.totalMs,
	);
	const promise = ensureKernelPythonUncached(
		{ ...options, signal: controller.signal, timeouts },
		pythonSkills,
	).finally(() => {
		clearTimeout(timer);
		if (inFlightEnsureKernelPython.get(key)?.promise === promise) inFlightEnsureKernelPython.delete(key);
	});
	const entry: InFlightBootstrap = { promise, controller, waiters: new Set() };
	// Hundreds of managers may share this validation. A single abort listener
	// fans out to waiters instead of exceeding AbortSignal's listener limit.
	controller.signal.addEventListener(
		"abort",
		() => {
			for (const waiter of [...entry.waiters]) waiter(controller.signal.reason);
		},
		{ once: true },
	);
	inFlightEnsureKernelPython.set(key, entry);
	return waitForBootstrap(entry, options.signal);
}
