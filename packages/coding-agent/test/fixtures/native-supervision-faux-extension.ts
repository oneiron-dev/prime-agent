import { existsSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, getApiProvider, registerFauxProvider } from "../../../ai/src/index.js";
import type { ExtensionAPI } from "../../src/index.js";

export default function registerNativeSupervisionFauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});
	const root = process.env.NATIVE_SUPERVISION_PROCESS_ROOT!;
	faux.setResponses([
		async () => {
			writeFileSync(join(root, "model.ready"), "ready");
			await new Promise<void>((done) => {
				const watcher = watch(root, () => {
					if (existsSync(join(root, "model.release"))) {
						watcher.close();
						done();
					}
				});
				if (existsSync(join(root, "model.release"))) {
					watcher.close();
					done();
				}
			});
			return fauxAssistantMessage("natural model boundary");
		},
		...Array.from({ length: 16 }, (_, index) => fauxAssistantMessage(`accepted response ${index + 1}`)),
	]);
	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) {
		throw new Error("Faux API provider was not registered");
	}
	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: apiProvider.streamSimple,
		models: faux.models.map((model) => ({
			api: model.api,
			baseUrl: model.baseUrl,
			contextWindow: model.contextWindow,
			cost: model.cost,
			id: model.id,
			input: model.input,
			maxTokens: model.maxTokens,
			name: model.name,
			reasoning: model.reasoning,
		})),
	});
}
