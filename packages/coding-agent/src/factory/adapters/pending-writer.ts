import { existsSync, type FSWatcher, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getProcessStartId } from "../../core/session-lease.js";

/**
 * Productive waiting belongs to the factory. A writer that starts a durable validation registers it here before it
 * yields its turn; the factory then waits for the job's own terminal record without spending model rounds, and
 * resumes the same session with the actual result. A job that disappears without that record is a custody
 * failure, never a success.
 */
export interface PendingWriterJob {
	version: 1;
	ticket: string;
	session: string;
	/** 8 to 128 letters, digits, `_` or `-`; a consumed id is never accepted again. */
	jobId: string;
	/** The durable controller, not a worker or a service MainPID that will change. */
	pid: number;
	/** The controller's process start identity, as `getProcessStartId` reports it. */
	startId: string;
	/** Absolute path of the terminal JSON, inside the ticket directory or the worktree. */
	terminalPath: string;
}
/** The producer publishes this atomically, for success or failure, with the job's exact identity. */
export interface PendingWriterTerminal {
	version: 1;
	ticket: string;
	session: string;
	jobId: string;
	pid: number;
	startId: string;
	exitCode: number;
}
export interface CompletedPendingWriter {
	job: PendingWriterJob;
	terminal: PendingWriterTerminal;
	path: string;
	archive: string;
	custodyPath: string;
}

function atomic(path: string, value: unknown): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

export function pendingWriterPath(directory: string, session: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("invalid writer session name");
	return join(directory, "pending-jobs", `${session}.json`);
}

/** The terminal record of the registered job, or undefined while none exists. Waits without any deadline. */
export async function waitForPendingWriter(options: {
	directory: string;
	worktree: string;
	ticket: string;
	session: string;
	log?: (step: string, message?: string) => void;
}): Promise<CompletedPendingWriter | undefined> {
	const { directory, worktree, ticket, session } = options;
	const log = options.log ?? (() => {});
	const path = pendingWriterPath(directory, session);
	if (!existsSync(path)) return undefined;
	const fail = (reason: string): Error =>
		new Error(
			`pending writer validation incomplete: ${reason}; preserve ${path}; reconcile custody, do not relaunch the job`,
		);
	const job = JSON.parse(readFileSync(path, "utf8")) as PendingWriterJob;
	if (
		job.version !== 1 ||
		job.ticket !== ticket ||
		job.session !== session ||
		!/^[a-zA-Z0-9_-]{8,128}$/.test(job.jobId ?? "") ||
		!Number.isSafeInteger(job.pid) ||
		job.pid <= 0 ||
		typeof job.startId !== "string" ||
		!job.startId ||
		!isAbsolute(job.terminalPath ?? "")
	)
		throw fail("invalid exact job/session receipt");
	const terminalPath = resolve(job.terminalPath);
	if (
		![directory, worktree].some((base) => terminalPath.startsWith(`${resolve(base)}/`)) ||
		terminalPath === resolve(path)
	)
		throw fail("terminal path must be a distinct artifact within this ticket or worktree");
	if (!existsSync(dirname(terminalPath))) throw fail("terminal parent directory missing");
	const receiptDirectory = dirname(path);
	const archive = join(receiptDirectory, `${session}.${job.jobId}.consumed.json`);
	if (existsSync(archive)) throw fail("job ID was already consumed; the producer must use a new ID");
	const custodyPath = join(receiptDirectory, `${session}.custody.json`);
	const readTerminal = (): PendingWriterTerminal | undefined => {
		if (!existsSync(terminalPath)) return undefined;
		let terminal: PendingWriterTerminal;
		try {
			terminal = JSON.parse(readFileSync(terminalPath, "utf8")) as PendingWriterTerminal;
		} catch {
			throw fail("terminal JSON is malformed; the producer must publish atomically");
		}
		if (
			terminal.version !== 1 ||
			terminal.ticket !== ticket ||
			terminal.session !== session ||
			terminal.jobId !== job.jobId ||
			terminal.pid !== job.pid ||
			terminal.startId !== job.startId ||
			!Number.isInteger(terminal.exitCode)
		)
			throw fail("terminal producer identity or exitCode does not match the registered job");
		return terminal;
	};
	atomic(custodyPath, {
		...job,
		status: "waiting",
		terminalCondition: "atomic terminal JSON with exact producer identity and integer exitCode",
	});
	log("writer:wait", `${session} job=${job.jobId} pid=${job.pid} startId=${job.startId} terminal=${terminalPath}`);
	const completed = (terminal: PendingWriterTerminal): CompletedPendingWriter => {
		atomic(custodyPath, { ...job, status: "terminal", terminal });
		log(
			"writer:wait",
			`${session} job=${job.jobId} terminal exitCode=${terminal.exitCode}; resume the same session, not DONE`,
		);
		return { job, terminal, path, archive, custodyPath };
	};
	// A terminal written before the watch starts is read here; one written after is caught by the watch.
	const already = readTerminal();
	if (already) return completed(already);
	return new Promise((resolveWait, rejectWait) => {
		let watcher: FSWatcher | undefined;
		let timer: NodeJS.Timeout | undefined;
		let checking = false;
		let finished = false;
		const finish = (error: unknown, terminal?: PendingWriterTerminal) => {
			if (finished) return;
			finished = true;
			watcher?.close();
			clearInterval(timer);
			if (error || !terminal) rejectWait(error);
			else {
				try {
					resolveWait(completed(terminal));
				} catch (failure) {
					rejectWait(failure);
				}
			}
		};
		const inspect = async () => {
			if (checking || finished) return;
			checking = true;
			try {
				let terminal = readTerminal();
				if (terminal) return finish(undefined, terminal);
				if (getProcessStartId(job.pid) !== job.startId) {
					// A controller may exit just after publishing its result atomically.
					await new Promise((next) => setImmediate(next));
					terminal = readTerminal();
					if (terminal) return finish(undefined, terminal);
					finish(
						fail(
							"the registered controller vanished or changed without its terminal result (a service MainPID change is not inferred)",
						),
					);
				}
			} catch (error) {
				finish(error);
			} finally {
				checking = false;
			}
		};
		try {
			watcher = watch(dirname(terminalPath), () => void inspect());
			watcher.on("error", (error) => finish(error));
			// Custody checks only: no model call, no deadline, no kill and no synthetic progress.
			timer = setInterval(() => void inspect(), 5_000);
			void inspect();
		} catch (error) {
			finish(error);
		}
	});
}

/** The same session consumed the result: archive the receipt, and keep any next job the writer registered. */
export function acknowledgePendingWriter(completed: CompletedPendingWriter): void {
	atomic(completed.archive, { ...completed.job, status: "delivered-to-same-session", terminal: completed.terminal });
	if (existsSync(completed.path)) {
		const current = JSON.parse(readFileSync(completed.path, "utf8")) as PendingWriterJob;
		if (current.jobId === completed.job.jobId) unlinkSync(completed.path);
	}
	atomic(completed.custodyPath, {
		...completed.job,
		status: "delivered-to-same-session",
		terminal: completed.terminal,
	});
}
