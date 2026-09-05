import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), auth: vi.fn() }));
vi.mock("@earendil-works/pi-ai", () => ({ completeSimple: mocks.complete }));
vi.mock("../src/core/auth-storage.js", () => ({ AuthStorage: { create: () => ({}) } }));
vi.mock("../src/core/model-registry.js", () => ({
	ModelRegistry: {
		create: () => ({
			getError: () => undefined,
			find: () => ({ id: "configured" }),
			getApiKeyAndHeaders: mocks.auth,
		}),
	},
}));

import { createPrimeManagementCaller } from "../src/factory/adapters/prime-management.js";

beforeEach(() => vi.resetAllMocks());

test("rechecks pause after asynchronous auth before starting inference", async () => {
	let paused = false;
	mocks.auth.mockImplementation(async () => {
		await Promise.resolve();
		paused = true;
		return { ok: true, apiKey: "fixture" };
	});
	const call = createPrimeManagementCaller(() => {
		if (paused) throw new Error("paused");
	});
	await expect(
		call("system", "packet", { provider: "test", model: "configured", effort: "low" }, "attempt"),
	).rejects.toThrow("paused");
	expect(mocks.complete).not.toHaveBeenCalled();
});

test("captures automatic transport identity separately from the requested SDK selector", async () => {
	mocks.auth.mockResolvedValue({ ok: true, apiKey: "fixture" });
	mocks.complete.mockResolvedValue({
		model: "configured",
		responseModel: "actual-served-model",
		responseModelSource: "provider-response",
		responseId: "wire-request-1",
		content: [{ type: "text", text: "{}" }],
		stopReason: "stop",
		usage: {},
	});
	const result = await createPrimeManagementCaller(() => {})(
		"system",
		"packet",
		{ provider: "test", model: "configured", effort: "low" },
		"request-id",
	);
	expect(result).toMatchObject({
		model: "configured",
		modelIdentitySource: "sdk",
		responseModel: "actual-served-model",
		responseModelSource: "provider-response",
		responseId: "wire-request-1",
	});
});
