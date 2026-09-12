import { completeSimple, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../core/auth-storage.js";
import { ModelRegistry } from "../../core/model-registry.js";
import type { ManagementCaller } from "../management.js";

const EFFORTS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function createPrimeManagementCaller(beforeRequest: () => void): ManagementCaller {
	return async (system, packet, profile, requestId) => {
		if (profile.effort !== undefined && !EFFORTS.has(profile.effort))
			throw new Error(`Unsupported reasoning effort: ${profile.effort}`);
		const registry = ModelRegistry.create(AuthStorage.create());
		const error = registry.getError();
		if (error) throw new Error(error);
		const model = registry.find(profile.provider, profile.model);
		if (!model) throw new Error(`Model is not registered: ${profile.provider}/${profile.model}`);
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		beforeRequest();
		const response = await completeSimple(
			model,
			{
				systemPrompt: system,
				messages: [{ role: "user", content: packet, timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: { ...auth.headers, "X-Client-Request-Id": requestId },
				reasoning: profile.effort as ModelThinkingLevel | undefined,
				sessionId: requestId,
				maxTokens: 2000,
				timeoutMs: 120000,
				signal: AbortSignal.timeout(125000),
				transport: "sse",
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage ?? "Management request failed");
		}
		if (response.stopReason === "length" || response.content.some((block) => block.type === "toolCall")) {
			throw new Error("Management response was incomplete or requested unavailable tools");
		}
		return {
			text: response.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(""),
			model: response.model,
			modelIdentitySource: "sdk",
			usage: { ...response.usage },
		};
	};
}
