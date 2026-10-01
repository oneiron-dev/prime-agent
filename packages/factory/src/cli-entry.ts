#!/usr/bin/env node
import { isBuiltin } from "node:module";
import { FACTORY_HELP } from "./help.js";
import { supportsFactoryRuntime } from "./runtime.js";

// Help never opens SQLite, a session or a daemon; everything else needs node:sqlite, loaded only after this check.
const args = process.argv.slice(2);
if (!args.length || ["help", "--help", "-h"].includes(args[0]!)) {
	console.log(FACTORY_HELP);
} else if (!supportsFactoryRuntime(process.versions) || !isBuiltin("node:sqlite")) {
	console.error("prime-agent-factory requires Node 22.13+ with node:sqlite.");
	process.exitCode = 1;
} else {
	const { watchFactoryParent } = await import("./parent.js");
	const closeParentWatch = watchFactoryParent();
	try {
		const { runFactoryCli } = await import("./cli.js");
		await runFactoryCli(args);
	} catch (error) {
		console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		process.exitCode = 1;
	} finally {
		closeParentWatch();
	}
}
