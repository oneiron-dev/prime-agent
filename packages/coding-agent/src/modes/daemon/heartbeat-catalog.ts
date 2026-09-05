import type { AgentConnectionHeartbeat } from "../agent-connection/types.js";
import type { DaemonTransportClient } from "./daemon-client.js";
import { deserializeDaemonError } from "./daemon-errors.js";
import { isUnknownDaemonCommandError } from "./daemon-protocol.js";

export const HEARTBEAT_CATALOG_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000] as const;

export function isHeartbeatCatalogUnavailableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return /^Cannot list heartbeats while session worker is (starting|recovering|disconnected)$/.test(message);
}

export async function listDaemonHeartbeats(
	client: DaemonTransportClient,
	activeSessionId?: string,
): Promise<AgentConnectionHeartbeat[]> {
	if (!client.hello) await client.waitForHello();
	if (!client.supportsServerCapability("heartbeat_catalog")) return [];
	try {
		const command = { type: "heartbeats_list", ...(activeSessionId ? { activeSessionId } : {}) } as const;
		const response = await client.request(command);
		if (!response.success) {
			throw deserializeDaemonError(response);
		}
		return (response.data as { heartbeats: AgentConnectionHeartbeat[] }).heartbeats;
	} catch (error) {
		if (isUnknownDaemonCommandError(error, "heartbeats_list")) {
			return [];
		}
		throw error;
	}
}
