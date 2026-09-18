export const FACTORY_USAGE_FIELDS = ["input", "output", "cache_read", "cache_write", "total"] as const;
export type FactoryUsage = Record<(typeof FACTORY_USAGE_FIELDS)[number], number>;
export interface FactoryCallCost {
	calls: number;
	usage: FactoryUsage | null;
	cost_usd: number | null;
	priced: boolean;
}

export function readFactoryUsage(value: unknown): FactoryUsage | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid token usage");
	const data = value as Record<string, unknown>;
	const tuple = [
		data.input,
		data.output,
		data.cache_read ?? data.cacheRead,
		data.cache_write ?? data.cacheWrite,
		data.total ?? data.totalTokens,
	] as const;
	if (!tuple.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0))
		throw new Error("Token usage must contain five non-negative safe integers");
	return Object.fromEntries(FACTORY_USAGE_FIELDS.map((key, i) => [key, tuple[i]])) as FactoryUsage;
}

export function sumFactoryCosts(calls: FactoryCallCost[]): FactoryCallCost {
	const usage = Object.fromEntries(
		FACTORY_USAGE_FIELDS.map((key) => [key, calls.reduce((sum, call) => sum + (call.usage?.[key] ?? 0), 0)]),
	) as FactoryUsage;
	const priced = calls.every((call) => call.priced && call.cost_usd !== null);
	return {
		calls: calls.reduce((sum, call) => sum + call.calls, 0),
		usage: calls.every((call) => call.usage !== null) ? readFactoryUsage(usage)! : null,
		cost_usd: priced ? calls.reduce((sum, call) => sum + call.cost_usd!, 0) : null,
		priced,
	};
}
