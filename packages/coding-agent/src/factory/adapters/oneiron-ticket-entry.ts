import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OneironTicketRunner, readTicketRun, TicketFailure } from "./oneiron-ticket.js";

const HELP = `Oneiron ticket runner (the factory launches one of these per ticket stage)
  oneiron-ticket-entry submit <ticket.json>   worktree, pack, writer, tests, review, publish, bots
  oneiron-ticket-entry merge <ticket.json>    wait for blockers, sync the stack, squash-merge, clean up
Exit 0 accepts the stage in the factory ledger; any other exit rejects it. The ticket directory holds state.json and logs.`;

export async function runOneironTicketCli(args: string[]): Promise<number> {
	const [stage, path] = args;
	if (!stage || stage === "help" || stage === "--help" || !path || !["submit", "merge"].includes(stage)) {
		console.log(HELP);
		return stage === "help" || stage === "--help" ? 0 : 2;
	}
	const runner = new OneironTicketRunner(readTicketRun(resolve(path)));
	try {
		if (stage === "submit") await runner.submit();
		else await runner.merge();
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runner.save({ failure: message });
		runner.log("FAILED", message);
		return error instanceof TicketFailure ? 1 : 3;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = await runOneironTicketCli(process.argv.slice(2));
}
