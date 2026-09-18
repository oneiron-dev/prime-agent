import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function save(path: string, data: unknown): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

export function publishAppliedReceipt(path: string, data: unknown): void {
	const staged = `${path}.applied`;
	save(staged, data);
	renameSync(staged, path);
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}
