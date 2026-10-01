import { isIP } from "node:net";

/** Refuse bearer transport outside HTTPS or the factory's private HTTP networks. */
export function factoryBearerEndpoint(value: string | undefined): string | undefined {
	const base = value?.trim().replace(/\/$/, "");
	if (!base) return undefined;
	try {
		const url = new URL(base);
		if (url.protocol === "https:") return base;
		if (url.protocol !== "http:") return undefined;
		const host = url.hostname;
		if (host === "localhost" || host === "[::1]" || host.endsWith(".ts.net")) return base;
		if (isIP(host) !== 4) return undefined;
		const [first, second] = host.split(".").map(Number);
		if (
			first === 127 ||
			first === 10 ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168) ||
			(first === 100 && second >= 64 && second <= 127)
		)
			return base;
	} catch {
		return undefined;
	}
	return undefined;
}
