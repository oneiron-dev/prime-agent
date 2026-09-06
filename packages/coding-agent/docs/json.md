# JSON Event Stream Mode

```bash
prime-agent --mode json "Your prompt"
```

By default, outputs all native session events as JSON lines to stdout. Useful for integrating Prime Agent into other tools or custom UIs.

## Factory completed-event profile

```bash
prime-agent --print --mode json --json-event-profile factory-completed "Your prompt"
```

`--json-event-profile` accepts `all` (the unchanged default) or `factory-completed`, and requires `--mode json`. The factory profile omits only `message_update` and `tool_execution_update`. Print mode skips those progressive snapshots **before JSON serialization and stdout output**. All other native session events pass through unchanged, including message/tool starts and ends, agent/turn lifecycle, compaction, retry, and error-bearing completed events. Completed assistant messages keep their content, SDK/provider metadata, response identity, and stop reason. The session header adds `jsonEventProfile: "factory-completed"` when this profile is selected.

This is a native completed-event log, **not full provider-wire capture**. It does not synthesize terminal events, turn an aborted response into success, truncate final content, or change interactive, RPC, or default JSON behavior. A failed or cancelled run can leave an unfinished lifecycle. Consumers must still verify process custody and successful completion.

Both Oneiron writer and coordinator select this profile automatically. New model launches require the pinned runtime capability `factory-completed-json-v1`; historical runtime/proof inspection does not. The factory's existing safety limits still apply: raw log 256 MiB, line 8 MiB, 250,000 events, 256 completed assistant records, 1,024 bytes per metadata string, and 256 KiB derived JSON. A genuinely oversized completed event still fails closed. These are factory reader/capture bounds, not CLI truncation limits.

## Event Types

Events are defined in [`AgentSessionEvent`](../src/core/agent-session.ts):

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "session_action_update"; actions: SessionActionSnapshot }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

`session_action_update` emits literal queued actions separately from active scheduler work whenever either projection changes. `compaction_start` and `compaction_end` cover both manual and automatic compaction.

Base events from [`AgentEvent`](../../agent/src/types.ts):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages from [`packages/ai/src/types.ts`](../../ai/src/types.ts):
- `UserMessage` (line 134)
- `AssistantMessage` (line 140)
- `ToolResultMessage` (line 152)

Extended messages from [`packages/coding-agent/src/core/messages.ts`](../src/core/messages.ts):
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

## Example

```bash
prime-agent --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
