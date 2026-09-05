import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const roots: string[] = [];
const shim = resolve("src/factory/adapters/oneiron-corpus-foreground.py");
const load = `import importlib.util,sys,os,json,hashlib,time
spec=importlib.util.spec_from_file_location("shim",${JSON.stringify(shim)})
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
`;
const fixture = `class FetchError(RuntimeError): pass
class GH:
 def __init__(self,deadline): self.deadline=deadline;self.calls=[]
def canonical(value): return json.dumps(value).encode()
def sha_bytes(value): return hashlib.sha256(value).hexdigest()
`;
function setup() {
	const directory = mkdtempSync(join(tmpdir(), "oneiron-corpus-test-"));
	roots.push(directory);
	return directory;
}
function alive(pid: number): boolean {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]![0] !== "Z";
	} catch {
		return false;
	}
}
afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Oneiron legacy corpus foreground transport adaptation", () => {
	test("keeps JSON/receipt call metadata and inherits the controller process group", () => {
		const program = `${load}${fixture}
legacy=sys.modules[__name__]
transport=s.foreground_class(legacy)(time.monotonic()+3)
result=transport.run([sys.executable,"-c","import os,json;print(json.dumps({'group':os.getpgrp()}))"])
assert result['group']==os.getpgrp()
assert len(transport.calls)==1 and transport.calls[0]['rc']==0
print(json.dumps({'result':result,'calls':transport.calls}))`;
		const result = JSON.parse(execFileSync("python3", ["-c", program], { encoding: "utf8", timeout: 5000 })) as {
			calls: Array<{ stdout_sha256: string }>;
		};
		expect(result.calls[0]!.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
	});
	test("terminates an expired foreground fetch and rejects helper hash drift", () => {
		const directory = setup();
		const childFile = join(directory, "child.pid");
		const child = `import os,signal;open(${JSON.stringify(childFile)},'w').write(str(os.getpid()));signal.pause()`;
		const program = `${load}${fixture}
legacy=sys.modules[__name__]
transport=s.foreground_class(legacy)(time.monotonic()+0.15)
try:
 transport.run([sys.executable,"-c",${JSON.stringify(child)}])
 raise AssertionError('timeout was accepted')
except FetchError as error:
 assert 'timeout' in str(error)
print('timeout-reaped')`;
		expect(execFileSync("python3", ["-c", program], { encoding: "utf8", timeout: 5000 })).toContain("timeout-reaped");
		expect(alive(Number(readFileSync(childFile, "utf8")))).toBe(false);
		const helper = join(directory, "helper.py");
		writeFileSync(helper, "raise Exception('must not run')");
		expect(() =>
			execFileSync(
				"python3",
				[
					"-c",
					`${load}
s.load_collector(__import__('pathlib').Path(${JSON.stringify(helper)}),'wrong')`,
				],
				{ stdio: "pipe", timeout: 5000 },
			),
		).toThrow();
	});
	test.skipIf(process.platform !== "linux")(
		"forced parent process-group termination cannot leave the GH fixture outside custody",
		async () => {
			const directory = setup();
			const marker = join(directory, "child.json");
			const child = `import os,json,signal;open(${JSON.stringify(marker)},'w').write(json.dumps({'pid':os.getpid(),'group':os.getpgrp()}));signal.pause()`;
			const program = `${load}${fixture}
s.foreground_class(sys.modules[__name__])(time.monotonic()+30).run([sys.executable,"-c",${JSON.stringify(child)}])`;
			// Only this test controller creates a group, exactly as the generic factory supervisor does.
			const parent = spawn("python3", ["-c", program], { detached: true, stdio: "ignore" });
			const closed = new Promise<void>((done) => parent.on("close", () => done()));
			try {
				await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 3000, interval: 20 });
				const info = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; group: number };
				expect(info.group).toBe(parent.pid);
				process.kill(-parent.pid!, "SIGTERM");
				await closed;
				await vi.waitFor(() => expect(alive(info.pid)).toBe(false), { timeout: 3000, interval: 20 });
			} finally {
				try {
					process.kill(-parent.pid!, "SIGKILL");
				} catch {
					/* Group already reaped. */
				}
			}
		},
	);
});
