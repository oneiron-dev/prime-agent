import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, inject, it } from "vitest";
import type { CommandHost } from "../src/adapters/command.js";
import { OneironTicketRunner } from "../src/adapters/oneiron-ticket.js";
import type { OneironLauncherSettings } from "../src/adapters/oneiron-settings.js";
import {
	AGENT_BINARY_ENV,
	agentSelection,
	DEFAULT_AGENT_COMMAND,
	nativeSeatArgv,
	resolveAgentExecutable,
	seatEnvironmentOverlay,
} from "../src/agent-command.js";
import type { FactoryEvent } from "../src/types.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** A PATH that reaches Python 3 (the resolver's runtime) and nothing else, so no ambient prime-agent is found. */
function pythonOnlyPath(root: string): string {
	const bin = join(root, "python-only");
	mkdirSync(bin);
	const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
	symlinkSync(python, join(bin, "python3"));
	return bin;
}

describe("agent binary selection", () => {
	it("takes the launch flag, then the launcher setting, then the environment, then prime-agent", () => {
		const env = { [AGENT_BINARY_ENV]: "/env/agent" };
		expect([
			agentSelection("/flag/agent", "/launcher/agent", env),
			agentSelection(undefined, "/launcher/agent", env),
			agentSelection(undefined, undefined, env),
			agentSelection(undefined, undefined, {}),
		]).toEqual(["/flag/agent", "/launcher/agent", "/env/agent", DEFAULT_AGENT_COMMAND]);
	});

	it("resolves the selection on the runner host to an absolute executable, keeping a launcher symlink as written", async () => {
		const root = temporary("factory-agent-");
		const host: CommandHost = { type: "local", runnerRoot: join(root, "attempts") };
		const real = join(root, "real-agent");
		writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
		mkdirSync(join(root, "bin"));
		const launcher = join(root, "bin", "prime-agent");
		symlinkSync(real, launcher);
		writeFileSync(join(root, "plain-file"), "", { mode: 0o644 });
		expect(await resolveAgentExecutable(host, launcher)).toEqual({ binary: launcher, sha256: sha256(real) });
		// A bare name goes through that host's PATH, the way the runner would find it.
		const previous = process.env.PATH;
		process.env.PATH = `${join(root, "bin")}:${pythonOnlyPath(root)}`;
		try {
			expect(await resolveAgentExecutable(host, "prime-agent")).toEqual({ binary: launcher, sha256: sha256(real) });
			await expect(resolveAgentExecutable(host, "no-such-agent")).rejects.toThrow(
				'Cannot resolve the agent binary "no-such-agent" on the runner host: not found, or not an executable file.',
			);
		} finally {
			process.env.PATH = previous;
		}
		await expect(resolveAgentExecutable(host, join(root, "plain-file"))).rejects.toThrow(
			"not found, or not an executable file",
		);
		await expect(resolveAgentExecutable(host, "")).rejects.toThrow("empty or invalid");
		await expect(
			resolveAgentExecutable({ type: "ssh", sshHost: "factory-host", runnerRoot: "/attempts" }, "bin/prime-agent"),
		).rejects.toThrow("The agent binary for an SSH host must be absolute or a bare command name: bin/prime-agent");
	});

	it("builds the print-mode argv in the factory's order, adding --daemon-hosted only for daemon custody", () => {
		const request = {
			provider: "cpa-r",
			model: "gpt-6-astra",
			thinking: "xhigh",
			cwd: "/work/wt/T-1",
			sessionDir: "/work/tickets/T-1/sessions/write",
			continueSession: true,
			appendSystemPrompt: "You are the writer.",
		};
		const tail = [
			"--offline",
			"--provider",
			"cpa-r",
			"--model",
			"gpt-6-astra",
			"--thinking",
			"xhigh",
			"--cwd",
			"/work/wt/T-1",
			"--no-extensions",
			"--no-skills",
			"--session-dir",
			"/work/tickets/T-1/sessions/write",
			"-c",
			"--append-system-prompt",
			"You are the writer.",
		];
		const head = ["/opt/prime-agent-rs", "-p", "--mode", "json", "--json-event-profile", "factory-completed"];
		expect(nativeSeatArgv(["/opt/prime-agent-rs"], { ...request, hosting: "owned" })).toEqual([...head, ...tail]);
		expect(nativeSeatArgv(["/opt/prime-agent-rs"], { ...request, hosting: "daemon" })).toEqual([
			...head,
			"--daemon-hosted",
			...tail,
		]);
		// An explicit session file wins over -c.
		expect(
			nativeSeatArgv(["agent"], {
				...request,
				hosting: "owned",
				sessionDir: undefined,
				resume: "/work/s.jsonl",
				appendSystemPrompt: undefined,
			}).slice(-2),
		).toEqual(["--resume", "/work/s.jsonl"]);
	});

	it("removes inherited worker authority and routing credentials, and nothing else", () => {
		const parent = {
			PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "worker-token",
			PRIME_AGENT_INTERNAL_OWNED_WORKER: "1",
			PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID: "owner",
			TYPESAFE_JEV_API_KEY: "jev",
			FACTORY_ADVISOR_API_KEY: "advisor",
			PRIME_FACTORY_ATTEMPT_ID: "attempt",
			PRIME_AGENT_DAEMON_SOCKET: "/run/pa-rs/daemon.sock",
			PATH: "/preserved",
		};
		const copy = { ...parent };
		const merged = { ...parent, ...seatEnvironmentOverlay(parent) };
		expect(parent).toEqual(copy);
		expect(Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined))).toEqual({
			PRIME_FACTORY_ATTEMPT_ID: "attempt",
			PRIME_AGENT_DAEMON_SOCKET: "/run/pa-rs/daemon.sock",
			PATH: "/preserved",
		});
	});
});

/**
 * A stand-in agent binary: a shell script, so running it as `node <binary>` would fail. It hands its argv, stdin
 * and environment to a recorder, which answers with a stream captured from the Rust prime-agent.
 */
function fakeAgent(root: string, name = "prime-agent-rs"): { binary: string; record: string } {
	const binary = join(root, name);
	const record = join(root, `${name}.record.json`);
	const recorder = join(root, "recorder.cjs");
	const capture = fileURLToPath(new URL("./fixtures/rust-jsonl/owned-writer-done.stdout.jsonl", import.meta.url));
	writeFileSync(
		recorder,
		`const fs = require("node:fs");
const [self, record, ...argv] = process.argv.slice(2);
fs.writeFileSync(record, JSON.stringify({ self, argv, stdin: fs.readFileSync(0, "utf8"), env: process.env }));
process.stdout.write(fs.readFileSync(${JSON.stringify(capture)}));
`,
	);
	writeFileSync(
		binary,
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$0" ${JSON.stringify(record)} "$@"\n`,
		{ mode: 0o755 },
	);
	return { binary, record };
}

describe("native seats", () => {
	it.each([
		["launcher.primeAgentBin", "owned"],
		[AGENT_BINARY_ENV, "daemon"],
		["prime-agent on PATH", "owned"],
	] as const)("run the agent binary chosen by %s directly, %s-hosted, prompt on stdin", async (selection, hosting) => {
		const root = temporary("factory-native-seat-");
		const bin = join(root, "bin");
		mkdirSync(bin);
		const agent = fakeAgent(bin, selection === "prime-agent on PATH" ? "prime-agent" : "prime-agent-rs");
		const launcher: OneironLauncherSettings = {
			host: "local",
			repo: join(root, "repo"),
			work: join(root, "work"),
			seatHosting: hosting,
			seats: { writer: { provider: "cpa-r", model: "gpt-6-astra", thinking: "xhigh" } },
			...(selection === "launcher.primeAgentBin" ? { primeAgentBin: agent.binary } : {}),
		};
		const env: NodeJS.ProcessEnv = {
			PATH: `${bin}:${process.env.PATH}`,
			PRIME_FACTORY_ATTEMPT_ID: "attempt-7",
			PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "inherited-token",
			PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "1",
			TYPESAFE_JEV_API_KEY: "jev",
			FACTORY_ADVISOR_API_KEY: "advisor",
			...(selection === AGENT_BINARY_ENV ? { [AGENT_BINARY_ENV]: agent.binary } : {}),
		};
		const runner = new OneironTicketRunner(
			{ version: 1, key: "T-1", title: "T", contract: "c", acceptance: "a", blockedBy: [], launcher },
			{ env, routing: {} },
		);
		mkdirSync(runner.worktree, { recursive: true });
		const prompt = `${"p".repeat(300_000)}\nfinish the contract`;
		const result = await runner.seat("writer", prompt, {
			system: "You are the writer.",
			session: "write",
			continueSession: true,
			logName: "write.r1.jsonl",
		});
		expect([result.code, result.final, result.activity]).toEqual([
			0,
			"Implemented the change.\nPR BODY:\nAdded the function.\nDONE capture-one",
			true,
		]);
		const recorded = JSON.parse(readFileSync(agent.record, "utf8")) as {
			self: string;
			argv: string[];
			stdin: string;
			env: Record<string, string>;
		};
		expect([recorded.self, recorded.stdin]).toEqual([agent.binary, prompt]);
		expect(recorded.argv).toEqual([
			"-p",
			"--mode",
			"json",
			"--json-event-profile",
			"factory-completed",
			...(hosting === "daemon" ? ["--daemon-hosted"] : []),
			"--offline",
			"--provider",
			"cpa-r",
			"--model",
			"gpt-6-astra",
			"--thinking",
			"xhigh",
			"--cwd",
			runner.worktree,
			"--no-extensions",
			"--no-skills",
			"--session-dir",
			join(runner.directory, "sessions", "write"),
			"-c",
			"--append-system-prompt",
			"You are the writer.",
		]);
		const seen = Object.keys(recorded.env).filter(
			(name) => name.startsWith("PRIME_AGENT_INTERNAL_") || /API_KEY$/.test(name),
		);
		expect([seen, recorded.env.PRIME_FACTORY_ATTEMPT_ID, recorded.env.GIT_OPTIONAL_LOCKS]).toEqual([
			[],
			"attempt-7",
			"0",
		]);
	});
});

describe("launch", () => {
	function launchFixture() {
		const root = temporary("factory-launch-agent-");
		const factory = join(root, "factory");
		const hosts = join(root, "hosts.json");
		const plan = join(root, "plan.json");
		const manifest = join(root, "w7-manifest.json");
		const mint = join(root, "mint-plan.json");
		const launcher = join(root, "launcher.json");
		writeFileSync(hosts, JSON.stringify({ local: { type: "local", runnerRoot: join(root, "attempts") } }));
		writeFileSync(plan, JSON.stringify({ version: 1, tickets: [], slots: [], actions: [] }));
		writeFileSync(manifest, JSON.stringify({ tickets: [{ key: "T-1", title: "One", blocked_by: [] }] }));
		writeFileSync(mint, JSON.stringify({ creates: [{ key: "T-1", contract: "Do one.", acceptance: "passes" }] }));
		const settings = (extra: Record<string, unknown> = {}) =>
			writeFileSync(
				launcher,
				JSON.stringify({ host: "local", repo: join(root, "repo"), work: join(root, "work"), ...extra }),
			);
		settings();
		const entry = join(inject("factoryDist"), "cli-entry.js");
		const cli = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
			execFileSync(process.execPath, [entry, ...args], {
				cwd: root,
				encoding: "utf8",
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		cli(["init", factory, plan, "--hosts", hosts]);
		const launch = (args: string[] = [], env?: NodeJS.ProcessEnv) =>
			JSON.parse(cli(["launch", factory, manifest, mint, "--launcher", launcher, ...args], env)) as {
				agentBinary: string | null;
				imported: string[];
			};
		const events = () => JSON.parse(cli(["events", factory])) as FactoryEvent[];
		const persisted = () => ({
			config: JSON.parse(readFileSync(join(factory, "config.json"), "utf8")).launcher.primeAgentBin,
			ticket: JSON.parse(readFileSync(join(root, "work", "tickets", "T-1", "ticket.json"), "utf8")).launcher
				.primeAgentBin,
		});
		return { root, launch, events, persisted, settings };
	}

	it("resolves the agent binary on the runner host, persists it for every stage and pins it apart from the factory", () => {
		const f = launchFixture();
		const first = fakeAgent(f.root, "first-agent");
		const second = fakeAgent(f.root, "second-agent");
		const third = fakeAgent(f.root, "third-agent");
		// The environment chooses when nothing else names a binary.
		expect(f.launch([], { ...process.env, [AGENT_BINARY_ENV]: first.binary })).toMatchObject({
			agentBinary: first.binary,
			imported: ["T-1"],
		});
		expect(f.persisted()).toEqual({ config: first.binary, ticket: first.binary });
		const pin = (agent: { binary: string }) => ({ host: "local", binary: agent.binary, sha256: sha256(agent.binary) });
		expect(f.events().filter((event) => event.kind === "agent_pinned").map((event) => event.detail)).toEqual([
			{ previous: null, agent: pin(first), reason: "launch" },
		]);
		// A relaunch keeps the recorded binary over the environment; launcher.json and the flag outrank both. A
		// relative selection is read from the launching directory and stored absolute.
		expect(f.launch([], { ...process.env, [AGENT_BINARY_ENV]: second.binary }).agentBinary).toBe(first.binary);
		f.settings({ primeAgentBin: "./second-agent" });
		expect(f.launch().agentBinary).toBe(second.binary);
		expect(f.launch(["--prime-agent-bin", "./third-agent"]).agentBinary).toBe(third.binary);
		expect(f.persisted()).toEqual({ config: third.binary, ticket: third.binary });
		expect(f.events().filter((event) => event.kind === "agent_changed").map((event) => event.detail)).toEqual([
			{ previous: pin(first), agent: pin(second), reason: "launch" },
			{ previous: pin(second), agent: pin(third), reason: "launch" },
		]);
		// A launch replaces config.json through a temporary file of its own; another launch's is never taken over.
		const foreign = join(f.root, "factory", "config.json.tmp");
		writeFileSync(foreign, "another launch's config");
		expect(f.launch(["--prime-agent-bin", "./third-agent"]).agentBinary).toBe(third.binary);
		expect([readFileSync(foreign, "utf8"), f.persisted()]).toEqual([
			"another launch's config",
			{ config: third.binary, ticket: third.binary },
		]);
	});

	it("refuses a launch whose native seats have no agent binary, and allows one whose seats are all commands", () => {
		const f = launchFixture();
		const env = { ...process.env, PATH: pythonOnlyPath(f.root), [AGENT_BINARY_ENV]: "" };
		expect(() => f.launch([], env)).toThrow(/Cannot resolve the agent binary \\"prime-agent\\" on the runner host/);
		expect(f.events().some((event) => event.kind === "agent_pinned")).toBe(false);
		const command = { command: ["/bin/true"] };
		f.settings({ seats: { writer: command, pack: command, grok: command, opus: command } });
		expect(f.launch([], env)).toMatchObject({ agentBinary: null, imported: ["T-1"] });
		expect(f.persisted()).toEqual({ config: undefined, ticket: undefined });
	});
});
