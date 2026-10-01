//! The Responses WebSocket transport under the engine's retry driver, end
//! to end: a session on an opted-in `openai-responses` route streams over
//! pa-ai's scripted loopback server, and a socket that drops mid-response
//! is re-issued by the session on a fresh connection.
use super::*;
use pa_ai::test_support::{spawn, MockServer, Record, Turn, Upgrade};

/// An engine on the `cpa-r` route the loopback server serves (the
/// provider opts every model into the WebSocket transport), with 1ms
/// quick retries and compaction off.
fn websocket_engine(server: &MockServer) -> (AgentSessionEngine, tempfile::TempDir) {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "cpa-r": {
                    "api": "openai-responses",
                    "baseUrl": server.base_url,
                    "apiKey": "test-key",
                    "compat": { "supportsWebSocket": true },
                    "models": [{
                        "id": "gpt-ws",
                        "name": "GPT WS",
                        "contextWindow": 128_000,
                        "maxTokens": 4096,
                    }],
                },
            },
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "defaultProvider": "cpa-r",
            "defaultModel": "gpt-ws",
            "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 1 },
            "compaction": { "enabled": false },
        })
        .to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    (engine, dir)
}

fn created(id: &str) -> Value {
    json!({ "type": "response.created", "response": { "id": id } })
}

fn completed(id: &str) -> Value {
    json!({
        "type": "response.completed",
        "response": { "id": id, "status": "completed",
                      "usage": { "input_tokens": 5, "output_tokens": 3, "total_tokens": 8 } },
    })
}

/// One assistant text item's events.
fn text_item(id: &str, text: &str) -> Vec<Value> {
    let item_id = format!("msg_{id}");
    vec![
        json!({
            "type": "response.output_item.added", "output_index": 0,
            "item": { "type": "message", "id": item_id, "role": "assistant", "status": "in_progress", "content": [] },
        }),
        json!({
            "type": "response.content_part.added", "output_index": 0, "content_index": 0,
            "part": { "type": "output_text", "text": "" },
        }),
        json!({
            "type": "response.output_text.delta", "output_index": 0, "content_index": 0,
            "delta": text,
        }),
        json!({
            "type": "response.output_item.done", "output_index": 0,
            "item": { "type": "message", "id": item_id, "role": "assistant", "status": "completed",
                      "content": [{ "type": "output_text", "text": text }] },
        }),
    ]
}

/// A complete text response.
fn text_response(id: &str, text: &str) -> Vec<Value> {
    let mut events = vec![created(id)];
    events.extend(text_item(id, text));
    events.push(completed(id));
    events
}

/// A complete response calling the `probe` tool with `marker`.
fn tool_call(id: &str, call_id: &str, marker: &str) -> Vec<Value> {
    let arguments = json!({ "marker": marker }).to_string();
    vec![
        created(id),
        json!({
            "type": "response.output_item.added", "output_index": 0,
            "item": { "type": "function_call", "id": format!("fc_{id}"), "call_id": call_id,
                      "name": "probe", "arguments": "" },
        }),
        json!({
            "type": "response.function_call_arguments.delta", "output_index": 0,
            "delta": arguments,
        }),
        json!({
            "type": "response.output_item.done", "output_index": 0,
            "item": { "type": "function_call", "id": format!("fc_{id}"), "call_id": call_id,
                      "name": "probe", "arguments": arguments, "status": "completed" },
        }),
        completed(id),
    ]
}

/// The compact shape of one request the server saw.
#[derive(Debug, PartialEq)]
enum Seen {
    Upgrade(usize),
    Ws {
        connection: usize,
        previous: Option<String>,
        inputs: usize,
    },
}

/// The upgrades and WebSocket requests in arrival order, plus the
/// WebSocket request bodies (SSE requests fail the test: every request
/// here must ride the socket).
fn seen(records: Vec<Record>) -> (Vec<Seen>, Vec<Value>) {
    let mut seen = Vec::new();
    let mut bodies = Vec::new();
    for record in records {
        match record {
            Record::Upgrade { connection, .. } => seen.push(Seen::Upgrade(connection)),
            Record::WsRequest {
                connection, body, ..
            } => {
                seen.push(Seen::Ws {
                    connection,
                    previous: body["previous_response_id"].as_str().map(str::to_string),
                    inputs: body["input"].as_array().map_or(0, Vec::len),
                });
                bodies.push(body);
            }
            Record::SseRequest { body, .. } => panic!("unexpected SSE request: {body}"),
            Record::FrameStarted { .. } | Record::Closed { .. } => {}
        }
    }
    (seen, bodies)
}

/// The retry events in emit order.
fn retry_events(events: &[EngineEvent]) -> Vec<(bool, u32)> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::AutoRetryStart { attempt, .. } => Some((true, *attempt)),
            EngineEvent::AutoRetryEnd { attempt, .. } => Some((false, *attempt)),
            _ => None,
        })
        .collect()
}

/// The combined drop/retry/continuation scenario through the engine (port
/// map 4.1): the second turn continues the first response with only its
/// new input, the socket drops after a partial reply, the session re-issues
/// the turn on a fresh socket with the full request (no stale
/// `previous_response_id`, no cut-off partial), and the next turn
/// continues the recovered response.
#[test]
fn a_dropped_socket_retries_the_full_request_on_a_fresh_connection() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut partial = vec![created("resp_drop")];
    partial.extend(
        text_item("resp_drop", "partial reply cut off")
            .into_iter()
            .take(3),
    );
    let mut server = runtime.block_on(spawn(
        vec![
            Upgrade::Accept(vec![
                Turn::Events(text_response("resp_1", "one")),
                Turn::EventsThenFin(partial),
            ]),
            Upgrade::Accept(vec![
                Turn::Events(text_response("resp_2", "two")),
                Turn::Events(text_response("resp_3", "three")),
            ]),
        ],
        Vec::new(),
    ));
    let (engine, _dir) = websocket_engine(&server);
    let mut first = Vec::new();
    admit(&engine, "u1".to_string(), &mut first);
    let mut second = Vec::new();
    admit(&engine, "u2".to_string(), &mut second);
    let mut third = Vec::new();
    admit(&engine, "u3".to_string(), &mut third);
    assert_eq!(assistant_texts(&first), vec!["one".to_string()]);
    assert_eq!(assistant_texts(&third), vec!["three".to_string()]);
    assert_eq!(retry_events(&second), vec![(true, 1), (false, 1)]);
    let (seen, bodies) = seen(server.drain());
    let Some(Seen::Ws {
        inputs: first_inputs,
        ..
    }) = seen.get(1)
    else {
        panic!("the first request: {seen:?}");
    };
    // The re-issued request carries the first request's input plus the
    // first reply and the second prompt — never the cut-off partial.
    let full = first_inputs + 2;
    assert_eq!(
        seen,
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: *first_inputs
            },
            Seen::Ws {
                connection: 1,
                previous: Some("resp_1".to_string()),
                inputs: 1
            },
            Seen::Upgrade(2),
            Seen::Ws {
                connection: 2,
                previous: None,
                inputs: full
            },
            Seen::Ws {
                connection: 2,
                previous: Some("resp_2".to_string()),
                inputs: 1
            },
        ]
    );
    assert!(
        !bodies[2].to_string().contains("partial reply cut off"),
        "the failed partial never re-enters the request: {}",
        bodies[2]
    );
}

/// The `probe` tool: a side effect that records every marker it runs
/// with (what a retry must never repeat).
struct Probe {
    runs: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl pa_agent::types::AgentTool for Probe {
    fn name(&self) -> &'static str {
        "probe"
    }
    fn description(&self) -> &'static str {
        "record a marker"
    }
    fn parameters(&self) -> &Value {
        static PARAMETERS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        PARAMETERS.get_or_init(|| {
            json!({
                "type": "object",
                "properties": { "marker": { "type": "string" } },
                "required": ["marker"],
            })
        })
    }
    fn execute(
        self: std::sync::Arc<Self>,
        _tool_call_id: String,
        params: Value,
        _signal: pa_agent::abort::AbortSignal,
        _on_update: pa_agent::types::AgentToolUpdateCallback,
    ) -> pa_agent::BoxFut<'static, anyhow::Result<pa_agent::types::AgentToolResult>> {
        Box::pin(async move {
            let marker = params["marker"].as_str().unwrap_or_default().to_string();
            self.runs.lock().unwrap().push(marker.clone());
            Ok(pa_agent::types::AgentToolResult::text(format!(
                "probe ran {marker}"
            )))
        })
    }
}

/// Build the engine's session and add the `probe` tool beside its own
/// tools; returns the probe's run log.
fn install_probe(engine: &AgentSessionEngine) -> std::sync::Arc<std::sync::Mutex<Vec<String>>> {
    let runs = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let model = engine.resolve_model().expect("the route resolves");
    engine
        .ensure_core_session(&model)
        .expect("the session builds");
    let session = engine.session.blocking_lock();
    let core = session.as_deref().expect("the built session");
    let probe = std::sync::Arc::new(Probe {
        runs: std::sync::Arc::clone(&runs),
    });
    engine.runtime.block_on(async {
        let agent = core.session.agent();
        let mut tools = agent.state().await.tools;
        tools.push(probe);
        agent.set_tools(tools).await;
    });
    runs
}

/// A completed side-effectful tool call runs exactly once across a
/// dropped follow-up request, and a tool call cut off by the drop never
/// runs: the re-issued request carries the completed call and its real
/// output, not the partial call.
#[test]
fn a_drop_after_a_completed_tool_call_never_repeats_or_runs_a_cut_call() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut cut_call = vec![created("resp_cut")];
    cut_call.extend(
        tool_call("resp_cut", "call_cut", "cut")
            .into_iter()
            .skip(1)
            .take(2),
    );
    let mut server = runtime.block_on(spawn(
        vec![
            Upgrade::Accept(vec![
                Turn::Events(tool_call("resp_tool", "call_once", "once")),
                Turn::EventsThenFin(cut_call),
            ]),
            Upgrade::Accept(vec![Turn::Events(text_response("resp_done", "done"))]),
        ],
        Vec::new(),
    ));
    let (engine, _dir) = websocket_engine(&server);
    let runs = install_probe(&engine);
    let mut events = Vec::new();
    admit(&engine, "run the tool".to_string(), &mut events);
    // The side effect ran once, for the completed call only.
    assert_eq!(*runs.lock().unwrap(), vec!["once".to_string()]);
    let dispatched: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::ToolExecutionStart { tool_call_id, .. } => Some(tool_call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(dispatched, vec!["call_once|fc_resp_tool"]);
    assert_eq!(retry_events(&events), vec![(true, 1), (false, 1)]);
    let (seen, bodies) = seen(server.drain());
    assert!(
        matches!(
            seen.as_slice(),
            [
                Seen::Upgrade(1),
                Seen::Ws {
                    connection: 1,
                    previous: None,
                    ..
                },
                Seen::Ws {
                    connection: 1,
                    previous: Some(_),
                    ..
                },
                Seen::Upgrade(2),
                Seen::Ws {
                    connection: 2,
                    previous: None,
                    ..
                },
            ]
        ),
        "{seen:?}"
    );
    let retried = bodies[2].to_string();
    assert!(retried.contains("call_once"), "{retried}");
    assert!(retried.contains("function_call_output"), "{retried}");
    assert!(retried.contains("probe ran once"), "{retried}");
    assert!(!retried.contains("call_cut"), "{retried}");
}
