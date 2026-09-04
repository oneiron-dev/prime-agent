import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FACTORY_HELP } from "../factory/help.js";

export function factoryArguments(args: readonly string[]): string[] | undefined {
	if (args[0] === "factory") return args.slice(1);
	if (args[0] === "help" && args[1] === "factory") return ["help"];
	return undefined;
}

export function supportsFactoryRuntime(versions: { node?: string; bun?: string }): boolean {
	if (versions.bun || !versions.node) return false;
	const [major = 0, minor = 0] = versions.node.split(".").map(Number);
	return major > 22 || (major === 22 && minor >= 13);
}

export function factoryEntrypoint(moduleUrl = import.meta.url, management = false): string {
	const base = dirname(fileURLToPath(moduleUrl));
	const name = management ? "manage-entry" : "cli-entry";
	const candidates = [
		join(base, management ? "factory-manage.js" : "factory-cli.js"),
		join(base, "..", "factory", `${name}.js`),
		join(base, "..", "factory", `${name}.ts`),
	];
	const entry = candidates.find((candidate) => existsSync(candidate));
	if (!entry) throw new Error("Factory entrypoint is unavailable. Use the Node distribution of Prime Agent.");
	return entry;
}

export async function maybeRunFactory(args: readonly string[]): Promise<boolean> {
	const factoryArgs = factoryArguments(args);
	if (!factoryArgs) return false;
	if (!factoryArgs.length || ["help", "--help", "-h"].includes(factoryArgs[0]!)) {
		console.log(FACTORY_HELP);
		return true;
	}
	if (!supportsFactoryRuntime(process.versions) || !isBuiltin("node:sqlite")) {
		console.error(
			"Factory mode requires Node 22.13+ with node:sqlite. Use the Node distribution; ordinary Prime remains available.",
		);
		process.exitCode = 1;
		return true;
	}
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					...process.execArgv,
					factoryEntrypoint(import.meta.url, factoryArgs[0] === "manage"),
					...(factoryArgs[0] === "manage" ? factoryArgs.slice(1) : factoryArgs),
				],
				{
					stdio: ["inherit", "inherit", "inherit", "ipc"],
					env: { ...process.env, PRIME_FACTORY_PARENT: "1" },
				},
			);
			const forwardInterrupt = () => child.kill("SIGINT");
			const forwardTerminate = () => child.kill("SIGTERM");
			process.on("SIGINT", forwardInterrupt);
			process.on("SIGTERM", forwardTerminate);
			const cleanup = () => {
				process.off("SIGINT", forwardInterrupt);
				process.off("SIGTERM", forwardTerminate);
			};
			child.once("error", (error) => {
				cleanup();
				reject(error);
			});
			child.once("exit", (code, signal) => {
				cleanup();
				process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
				resolve();
			});
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
	return true;
}
