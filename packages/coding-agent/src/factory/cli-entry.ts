import { runFactoryCli } from "./cli.js";
import { watchFactoryParent } from "./parent.js";

const closeParentWatch = watchFactoryParent();

try {
	await runFactoryCli(process.argv.slice(2));
} catch (error) {
	console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	process.exitCode = 1;
} finally {
	closeParentWatch();
}
