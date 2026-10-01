import { isAbsolute, resolve } from "node:path";
import { type CommandHost, hostPythonSpec, requestHostProgram } from "./adapters/command.js";

/**
 * The agent binary the factory drives: which one, where it lives on the runner host, how a native seat calls it
 * and what environment it never inherits. The factory itself never links the agent; it runs it as a subprocess.
 */

/** Selects the agent binary when neither `launch --prime-agent-bin` nor the launcher's `primeAgentBin` names one. */
export const AGENT_BINARY_ENV = "PRIME_AGENT_FACTORY_AGENT_BIN";
/** Looked up on the runner host's PATH when nothing names the agent binary. */
export const DEFAULT_AGENT_COMMAND = "prime-agent";
/** A seat's JSON stream without the progressive `message_update` and `tool_execution_update` snapshots. */
export const FACTORY_JSON_EVENT_PROFILE = "factory-completed";
/** Who holds a native seat's session: the seat process itself, or the agent daemon (`--daemon-hosted`). */
export type SeatHosting = "owned" | "daemon";

/** The selection in precedence order: the launch flag, the launcher setting, the environment, then PATH. */
export function agentSelection(
	flag: string | undefined,
	launcher: string | undefined,
	env: NodeJS.ProcessEnv,
): string {
	return flag || launcher || env[AGENT_BINARY_ENV] || DEFAULT_AGENT_COMMAND;
}

/** The agent binary as the runner host sees it: an absolute path there and the bytes it held when resolved. */
export interface AgentExecutable {
	binary: string;
	sha256: string;
}
/** The pinned agent binary of a factory: the configured host it was resolved on and what it was there. */
export interface AgentPin extends AgentExecutable {
	host: string;
}

// Run on the runner host, the same way the command runner is: the selection arrives on stdin, never in a shell
// command line. A bare name goes through that host's PATH; symlinks are kept as written, since a launcher script
// that pins its own environment must stay the thing the seats run.
const AGENT_RESOLVER_SOURCE = String.raw`
import hashlib, json, os, shutil, sys
selection = json.load(sys.stdin)["selection"]
path = shutil.which(selection) if os.sep not in selection else selection
path = os.path.abspath(path) if path else None
if not path or not os.path.isfile(path) or not os.access(path, os.X_OK):
    print(json.dumps({"error": "not found, or not an executable file"}))
else:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    print(json.dumps({"binary": path, "sha256": digest.hexdigest()}))
`;

/**
 * Resolve the agent binary on the host that runs the ticket runners. A relative path is read from this process's
 * directory on a local host and refused for an SSH host; a bare command name is looked up on that host's PATH.
 */
export async function resolveAgentExecutable(
	host: CommandHost,
	selection: string,
	timeoutMs = 20_000,
): Promise<AgentExecutable> {
	if (!selection.trim() || /[\0\n]/.test(selection)) throw new Error("The agent binary selection is empty or invalid");
	const relative = selection.includes("/") && !isAbsolute(selection);
	if (relative && host.type === "ssh")
		throw new Error(`The agent binary for an SSH host must be absolute or a bare command name: ${selection}`);
	const request = relative ? resolve(selection) : selection;
	const reply = await requestHostProgram(
		hostPythonSpec(host, AGENT_RESOLVER_SOURCE),
		JSON.stringify({ selection: request }),
		timeoutMs,
		"Host transport timed out while resolving the agent binary",
	);
	const result = (reply ?? {}) as { binary?: unknown; sha256?: unknown; error?: unknown };
	if (typeof result.binary !== "string" || !isAbsolute(result.binary) || typeof result.sha256 !== "string")
		throw new Error(
			`Cannot resolve the agent binary ${JSON.stringify(selection)} on the runner host: ${typeof result.error === "string" ? result.error : "invalid reply"}. Pass --prime-agent-bin, set launcher.primeAgentBin or ${AGENT_BINARY_ENV}.`,
		);
	return { binary: result.binary, sha256: result.sha256 };
}

/** What one native seat call asks of the agent binary; the prompt itself goes to stdin. */
export interface NativeSeatRequest {
	provider: string;
	model: string;
	thinking: string;
	cwd: string;
	hosting: SeatHosting;
	sessionDir?: string;
	/** An absolute session file to continue instead of the newest one in `sessionDir`. */
	resume?: string;
	continueSession: boolean;
	appendSystemPrompt?: string;
}

/** The agent's print-mode argv, in the order the factory has always passed it. */
export function nativeSeatArgv(agentArgv: readonly string[], request: NativeSeatRequest): string[] {
	let hosting: string[];
	switch (request.hosting) {
		case "owned":
			hosting = [];
			break;
		case "daemon":
			hosting = ["--daemon-hosted"];
			break;
	}
	return [
		...agentArgv,
		"-p",
		"--mode",
		"json",
		"--json-event-profile",
		FACTORY_JSON_EVENT_PROFILE,
		...hosting,
		"--offline",
		"--provider",
		request.provider,
		"--model",
		request.model,
		"--thinking",
		request.thinking,
		"--cwd",
		request.cwd,
		"--no-extensions",
		"--no-skills",
		...(request.sessionDir ? ["--session-dir", request.sessionDir] : []),
		...(request.resume ? ["--resume", request.resume] : request.continueSession ? ["-c"] : []),
		...(request.appendSystemPrompt ? ["--append-system-prompt", request.appendSystemPrompt] : []),
	];
}

/** The ticket runner's own routing credentials; a seat never sees them. */
const ROUTING_CREDENTIALS = ["TYPESAFE_JEV_API_KEY", "FACTORY_ADVISOR_API_KEY"];
/** A daemon worker's or an owned worker's authority (role, token, sockets, leases) is never inherited by a seat. */
const WORKER_AUTHORITY_PREFIX = "PRIME_AGENT_INTERNAL_";

/**
 * The overlay that removes inherited worker authority and the routing credentials from a seat's environment. Each
 * removed name maps to undefined, which a spawned child does not receive; everything else is inherited unchanged.
 */
export function seatEnvironmentOverlay(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const overlay: NodeJS.ProcessEnv = {};
	for (const name of Object.keys(base)) if (name.startsWith(WORKER_AUTHORITY_PREFIX)) overlay[name] = undefined;
	for (const name of ROUTING_CREDENTIALS) overlay[name] = undefined;
	return overlay;
}
