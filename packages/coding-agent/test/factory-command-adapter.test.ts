import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CommandAdapter,
	type CommandContext,
	type CommandHost,
	fingerprintCommand,
	hostLaunchSpec,
} from "../src/factory/adapters/command.js";

const roots: string[] = [];
function setup(): { root: string; host: CommandHost; context: CommandContext } {
	const root = mkdtempSync(join(tmpdir(), "prime-factory-runner-"));
	roots.push(root);
	return {
		root,
		host: { type: "local", runnerRoot: join(root, "attempts") },
		context: {
			attempt: {
				id: "attempt-one",
				actionId: "a",
				slotId: "local",
				state: "SUBMITTED",
				createdAt: new Date().toISOString(),
				submittedAt: new Date().toISOString(),
				processIdentity: null,
				receipt: null,
				uncertainty: null,
				claimReleased: false,
			},
			action: {
				id: "a",
				ticketId: "t",
				kind: "process",
				dependencies: [],
				sourceFingerprint: "opaque:test",
				command: { argv: [process.execPath, "-e", "process.stdout.write('done')"], cwd: root },
				requirements: {},
				state: "RUNNING",
			},
			slot: { id: "local", host: "local" },
		},
	};
}
async function terminal(adapter: CommandAdapter, context: CommandContext) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const result = await adapter.inspect(context);
		if (result.kind === "terminal") return result.receipt;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error("No terminal receipt within timeout");
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable factory command adapter", () => {
	it("detaches jobs, survives a replacement controller and prevents duplicate launches", async () => {
		const { root, host, context } = setup();
		const marker = join(root, "count");
		context.action.command.argv = [
			process.execPath,
			"-e",
			`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => console.log('finished'), 350)`,
		];
		const adapter = new CommandAdapter({ local: host });
		const replies = await Promise.all([adapter.launch(context), adapter.launch(context)]);
		expect(replies.some((reply) => reply.kind === "running")).toBe(true);
		const replacement = new CommandAdapter({ local: host });
		const receipt = await terminal(replacement, context);
		expect(receipt.exitCode).toBe(0);
		expect(receipt.sourceFingerprint).toBe("opaque:test");
		expect(readFileSync(marker, "utf8")).toBe("x");
		expect(readFileSync(join(host.runnerRoot, context.attempt.id, "stdout.log"), "utf8")).toContain("finished");
		expect((await replacement.launch(context)).kind).toBe("terminal");
		expect(readFileSync(marker, "utf8")).toBe("x");
	});

	it("retains uncertainty for absent receipts and mismatched attempt manifests", async () => {
		const { host, context } = setup();
		const adapter = new CommandAdapter({ local: host });
		expect((await adapter.inspect(context)).kind).toBe("uncertain");
		await adapter.launch(context);
		await terminal(adapter, context);
		const changed = structuredClone(context);
		changed.action.command.argv.push("different");
		expect((await adapter.launch(changed)).kind).toBe("uncertain");
	});

	it("checks the owner pause again before transport or launch", async () => {
		const { root, host, context } = setup();
		const pauseFile = join(root, "OWNER-PAUSE");
		writeFileSync(pauseFile, "{}");
		const adapter = new CommandAdapter({ local: host }, { pauseFile });
		expect((await adapter.launch(context)).kind).toBe("uncertain");
		expect(existsSync(host.runnerRoot)).toBe(false);
	});

	it("fingerprints tracked, dirty and untracked bytes and rejects changed source before spawn", async () => {
		const { root, host, context } = setup();
		execFileSync("git", ["init", "-q", root]);
		writeFileSync(join(root, "tracked"), "original");
		execFileSync("git", ["-C", root, "add", "tracked"]);
		execFileSync("git", [
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"initial",
		]);
		const clean = await fingerprintCommand(host, root);
		writeFileSync(join(root, "tracked"), "changed");
		const dirty = await fingerprintCommand(host, root);
		expect(dirty).not.toBe(clean);
		writeFileSync(join(root, "untracked"), "new");
		const untracked = await fingerprintCommand(host, root);
		expect(untracked).not.toBe(dirty);
		writeFileSync(join(root, ".gitignore"), "attempts/\n");
		context.action.sourceFingerprint = await fingerprintCommand(host, root);
		writeFileSync(join(root, "untracked"), "changed bytes");
		const marker = join(root, "should-not-run");
		context.action.command.argv = [
			process.execPath,
			"-e",
			`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
		];
		const adapter = new CommandAdapter({ local: host });
		await adapter.launch(context);
		const receipt = await terminal(adapter, context);
		expect(receipt.exitCode).toBe(125);
		expect(receipt.artifact?.sourceFingerprint).not.toBe(receipt.sourceFingerprint);
		expect(existsSync(marker)).toBe(false);
	});

	it("records verified output source identity separately when the command changes bytes", async () => {
		const { root, host, context } = setup();
		execFileSync("git", ["init", "-q", root]);
		writeFileSync(join(root, "tracked"), "original");
		writeFileSync(join(root, ".gitignore"), "attempts/\n");
		execFileSync("git", ["-C", root, "add", "tracked", ".gitignore"]);
		execFileSync("git", [
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"initial",
		]);
		context.action.sourceFingerprint = await fingerprintCommand(host, root);
		context.action.command.argv = [process.execPath, "-e", "require('node:fs').writeFileSync('tracked', 'changed')"];
		const adapter = new CommandAdapter({ local: host });
		await adapter.launch(context);
		const receipt = await terminal(adapter, context);
		expect(receipt.exitCode).toBe(0);
		expect(receipt.artifact?.sourceFingerprint).toBe(await fingerprintCommand(host, root));
		expect(receipt.artifact?.sourceFingerprint).not.toBe(receipt.sourceFingerprint);
	});

	it("terminates the command process group at its configured deadline", async () => {
		const { host, context } = setup();
		context.action.command.argv = [process.execPath, "-e", "setTimeout(() => {}, 30000)"];
		context.action.command.timeoutMs = 100;
		const adapter = new CommandAdapter({ local: host });
		await adapter.launch(context);
		expect((await terminal(adapter, context)).exitCode).toBe(124);
	});

	it("keeps job argv in the JSON protocol over SSH and rejects malformed receipts", async () => {
		const { context, host } = setup();
		context.action.command.argv = ["some-program", "$(touch /tmp/should-not-exist)", "quotes ' \""];
		const remote: CommandHost = { ...host, type: "ssh", sshHost: "user@configured-host" };
		const spec = hostLaunchSpec(remote);
		expect(spec.command).toBe("ssh");
		expect(spec.args.join(" ")).not.toContain("some-program");
		let observed: unknown;
		const adapter = new CommandAdapter(
			{ local: remote },
			{
				transport: async (_host, request) => {
					observed = request.manifest.command.argv;
					return {
						kind: "terminal",
						receipt: {
							attemptId: "wrong",
							sourceFingerprint: "opaque:test",
							exitCode: 0,
							finishedAt: new Date().toISOString(),
						},
					};
				},
			},
		);
		expect((await adapter.launch(context)).kind).toBe("uncertain");
		expect(observed).toEqual(context.action.command.argv);
		expect(() => hostLaunchSpec({ ...remote, sshHost: "-oProxyCommand=bad" })).toThrow();
	});
});
