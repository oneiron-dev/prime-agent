import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CommandAdapter, type CommandHost } from "./adapters/command.js";

export interface FactoryConfig {
	version: 1;
	hosts: Record<string, CommandHost>;
	pauseFile?: string;
}

export function readFactoryJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function readFactoryHosts(path: string): Record<string, CommandHost> {
	const value = readFactoryJson(path);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hosts must be a JSON object");
	const hosts = value as Record<string, CommandHost>;
	for (const host of Object.values(hosts)) {
		if (
			!host ||
			typeof host !== "object" ||
			typeof host.runnerRoot !== "string" ||
			(host.python !== undefined && typeof host.python !== "string")
		)
			throw new Error("Invalid host configuration");
	}
	new CommandAdapter(hosts);
	return hosts;
}

export function readFactoryConfig(directory: string): FactoryConfig {
	const value = readFactoryJson(join(directory, "config.json")) as FactoryConfig;
	if (!value || value.version !== 1 || !value.hosts || typeof value.hosts !== "object")
		throw new Error("Invalid factory config");
	if (value.pauseFile !== undefined && (typeof value.pauseFile !== "string" || !isAbsolute(value.pauseFile))) {
		throw new Error("Owner pauseFile must be an absolute path");
	}
	new CommandAdapter(value.hosts, { pauseFile: value.pauseFile });
	return value;
}
