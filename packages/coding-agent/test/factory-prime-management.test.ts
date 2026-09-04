import { expect, test, vi } from "vitest";

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
