#!/usr/bin/env node
import { isBuiltin } from "node:module";
import { runFactoryCli } from "./cli.js";
import { FACTORY_HELP } from "./help.js";
import { watchFactoryParent } from "./parent.js";
import { supportsFactoryRuntime } from "./runtime.js";

// Help never opens SQLite, a session or a daemon. Everything else needs node:sqlite, which the store loads only when it
// opens a database, after this check.
const args = process.argv.slice(2);
if (!args.length || ["help", "--help", "-h"].includes(args[0]!)) {
	console.log(FACTORY_HELP);
} else if (!supportsFactoryRuntime(process.versions) || !isBuiltin("node:sqlite")) {
	console.error("prime-agent-factory requires Node 22.13+ with node:sqlite.");
	process.exitCode = 1;
} else {
	const closeParentWatch = watchFactoryParent();
	try {
		await runFactoryCli(args);
	} catch (error) {
		console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		process.exitCode = 1;
	} finally {
		closeParentWatch();
	}
}
