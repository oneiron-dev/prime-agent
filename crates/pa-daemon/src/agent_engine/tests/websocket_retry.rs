//! The Responses WebSocket transport under the engine's retry driver, end
//! to end: a session on an opted-in `openai-responses` route streams over
//! pa-ai's scripted loopback server, and a socket that drops mid-response
//! is re-issued by the session on a fresh connection.
#[path = "websocket_recovery.rs"]
mod websocket_recovery;

use super::*;
use pa_ai::test_support::{spawn, MockServer, Record, SseReply, Turn, Upgrade};

/// An engine on the `cpa-r` route the loopback server serves (the
/// provider opts every model into the WebSocket transport), with a custom
/// generic retry schedule (transport retries still use exactly 2/4/8s).
fn websocket_engine(server: &MockServer, api: &str) -> (AgentSessionEngine, tempfile::TempDir) {
    websocket_engine_with_backup(server, api, None)
}

fn websocket_engine_with_backup(
    server: &MockServer,
    api: &str,
    backup: Option<&MockServer>,
) -> (AgentSessionEngine, tempfile::TempDir) {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let mut models = json!({
        "providers": {
            "cpa-r": {
                "api": api,
                "baseUrl": server.base_url,
                "apiKey": "e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoibW9jayJ9fQ.fixture",
                "compat": { "supportsWebSocket": true },
                "models": [{
                    "id": "gpt-ws", "name": "GPT WS",
                    "contextWindow": 128_000, "maxTokens": 4096,
                }],
            },
        },
    });
    let mut settings = json!({
        "defaultProvider": "cpa-r",
        "defaultModel": "gpt-ws",
        "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 1 },
        "compaction": { "enabled": false },
    });
    if let Some(backup) = backup {
        models["providers"]["backup"] = models["providers"]["cpa-r"].clone();
        models["providers"]["backup"]["baseUrl"] = json!(backup.base_url);
        // A normal retry would walk the backup immediately; caps must not.
        settings["retry"]["failover"] = json!({ "enabled": true, "maxRetries": 0 });
    }
    std::fs::write(agent_dir.join("models.json"), models.to_string()).unwrap();
    std::fs::write(agent_dir.join("settings.json"), settings.to_string()).unwrap();
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
    json!({ "type": "response.created", "response": { "id": id, "status": "in_progress", "output": [] } })
}

fn completed(id: &str, output: &[Value]) -> Value {
    json!({
        "type": "response.completed",
        "response": { "id": id, "status": "completed", "output": output,
                      "usage": { "input_tokens": 5, "output_tokens": 3, "total_tokens": 8 } },
    })
}

/// One assistant text item's events, including its completed wire item.
fn text_item(id: &str, text: &str) -> Vec<Value> {
    let item_id = format!("msg_{id}");
    let part = json!({ "type": "output_text", "text": text, "annotations": [] });
    vec![
        json!({
            "type": "response.output_item.added", "output_index": 0,
            "item": { "type": "message", "id": item_id, "role": "assistant", "status": "in_progress", "content": [] },
        }),
        json!({
            "type": "response.content_part.added", "item_id": item_id, "output_index": 0, "content_index": 0,
            "part": { "type": "output_text", "text": "", "annotations": [] },
        }),
        json!({
            "type": "response.output_text.delta", "item_id": item_id, "output_index": 0, "content_index": 0,
            "delta": text,
        }),
        json!({
            "type": "response.output_text.done", "item_id": item_id, "output_index": 0, "content_index": 0,
            "text": text,
        }),
        json!({
            "type": "response.content_part.done", "item_id": item_id, "output_index": 0, "content_index": 0,
            "part": part,
        }),
        json!({
            "type": "response.output_item.done", "output_index": 0,
            "item": { "type": "message", "id": item_id, "role": "assistant", "status": "completed",
                      "content": [part] },
        }),
    ]
}

/// A complete text response.
fn text_response(id: &str, text: &str) -> Vec<Value> {
    let mut events = vec![created(id)];
    events.extend(text_item(id, text));
    let item = events.last().unwrap()["item"].clone();
    events.push(completed(id, &[item]));
    events
}

/// A complete response calling the `probe` tool with `marker`.
fn tool_call(id: &str, call_id: &str, marker: &str) -> Vec<Value> {
    let arguments = json!({ "marker": marker }).to_string();
    let item_id = format!("fc_{id}");
    let item = json!({ "type": "function_call", "id": item_id, "call_id": call_id,
                      "name": "probe", "arguments": arguments, "status": "completed" });
    vec![
        created(id),
        json!({
            "type": "response.output_item.added", "output_index": 0,
            "item": { "type": "function_call", "id": item_id, "call_id": call_id,
                      "name": "probe", "arguments": "", "status": "in_progress" },
        }),
        json!({
            "type": "response.function_call_arguments.delta", "item_id": item_id, "output_index": 0,
            "delta": arguments,
        }),
        json!({
            "type": "response.function_call_arguments.done", "item_id": item_id, "output_index": 0,
            "arguments": arguments,
        }),
        json!({
            "type": "response.output_item.done", "output_index": 0,
            "item": item,
        }),
        completed(id, &[item]),
    ]
}

/// Generic Responses reconnects; Codex pins the session to SSE after a
/// WebSocket transport failure. Both continue through the session retry driver.
async fn recovery_server(api: &str, initial: Vec<Turn>, recovered: Vec<Vec<Value>>) -> MockServer {
    if api == "openai-codex-responses" {
        spawn(
            vec![Upgrade::Accept(initial)],
            recovered.into_iter().map(SseReply::Events).collect(),
        )
        .await
    } else {
        assert_eq!(api, "openai-responses");
        spawn(
            vec![
                Upgrade::Accept(initial),
                Upgrade::Accept(recovered.into_iter().map(Turn::Events).collect()),
            ],
            Vec::new(),
        )
        .await
    }
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
    Sse {
        inputs: usize,
    },
}

/// The upgrades and generation requests in arrival order, plus their bodies.
/// Each scenario asserts its provider's exact transport sequence.
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
            Record::SseRequest { body, .. } => {
                assert!(body.get("previous_response_id").is_none());
                seen.push(Seen::Sse {
                    inputs: body["input"].as_array().unwrap().len(),
                });
                bodies.push(body);
            }
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
    for api in ["openai-responses", "openai-codex-responses"] {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut partial = vec![created("resp_drop")];
        partial.extend(
            text_item("resp_drop", "partial reply cut off")
                .into_iter()
                .take(3),
        );
        partial[3]["delta"] = json!("partial ");
        partial.push(
            json!({"type": "response.output_text.delta", "output_index": 0,
            "content_index": 0, "item_id": "msg_resp_drop", "delta": "reply "}),
        );
        partial.push(
            json!({"type": "response.output_text.delta", "output_index": 0,
            "content_index": 0, "item_id": "msg_resp_drop", "delta": "cut off"}),
        );
        let mut server = runtime.block_on(recovery_server(
            api,
            vec![
                Turn::Events(text_response("resp_1", "one")),
                Turn::EventsThenFin(partial),
            ],
            vec![
                text_response("resp_2", "two"),
                text_response("resp_3", "three"),
            ],
        ));
        let (engine, _dir) = websocket_engine(&server, api);
        let mut first = Vec::new();
        admit(&engine, "u1".to_string(), &mut first);
        let mut second = Vec::new();
        admit(&engine, "u2".to_string(), &mut second);
        // Persisted history retains the failed attempt for audit, but a
        // context rebuild and terminal selection must use the recovered reply.
        {
            let guard = engine.session.blocking_lock();
            let core = guard.as_deref().unwrap();
            engine.runtime.block_on(async {
                let persistence = core.session.shared_persistence();
                let entries = persistence.lock().await.get_entries();
                let terminal = pa_core::session_engine::headless::select_from_entries(&entries);
                assert_eq!(
                    terminal.primary.unwrap().stdout_text().as_deref(),
                    Some("two")
                );
                core.session.rebuild_branch_context(entries).await.unwrap();
            });
        }
        let mut third = Vec::new();
        admit(&engine, "u3".to_string(), &mut third);
        assert_eq!(assistant_texts(&first), vec!["one".to_string()]);
        assert_eq!(assistant_texts(&third), vec!["three".to_string()]);
        assert_eq!(retry_events(&second), vec![(true, 1), (false, 1)]);
        assert!(second.iter().any(|event| matches!(
            event,
            EngineEvent::AutoRetryStart {
                delay_ms: 2000,
                max_attempts: 3,
                ..
            }
        )));
        let failed = second
            .iter()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) if message["stopReason"] == "error" => {
                    Some(message)
                }
                _ => None,
            })
            .expect("the drop is an error, never a committed partial");
        assert!(failed["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| {
                diagnostic["type"] == "provider_stream_failure"
                    && diagnostic["details"]["kind"] == "transport"
            }));
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
        let mut expected = vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: *first_inputs,
            },
            Seen::Ws {
                connection: 1,
                previous: Some("resp_1".to_string()),
                inputs: 1,
            },
        ];
        if api == "openai-codex-responses" {
            expected.extend([Seen::Sse { inputs: full }, Seen::Sse { inputs: full + 2 }]);
        } else {
            expected.extend([
                Seen::Upgrade(2),
                Seen::Ws {
                    connection: 2,
                    previous: None,
                    inputs: full,
                },
                Seen::Ws {
                    connection: 2,
                    previous: Some("resp_2".to_string()),
                    inputs: 1,
                },
            ]);
        }
        assert_eq!(seen, expected, "{api}");
        assert!(
            !bodies[2].to_string().contains("partial reply cut off"),
            "the failed partial never re-enters the request: {}",
            bodies[2]
        );
    }
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
    for api in ["openai-responses", "openai-codex-responses"] {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut cut_call = vec![created("resp_cut")];
        cut_call.extend(
            tool_call("resp_cut", "call_cut", "cut")
                .into_iter()
                .skip(1)
                .take(2),
        );
        let mut server = runtime.block_on(recovery_server(
            api,
            vec![
                Turn::Events(tool_call("resp_tool", "call_once", "once")),
                Turn::EventsThenFin(cut_call),
            ],
            vec![text_response("resp_done", "done")],
        ));
        let (engine, _dir) = websocket_engine(&server, api);
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
        let first_inputs = bodies[0]["input"].as_array().unwrap().len();
        let mut expected = vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: first_inputs,
            },
            Seen::Ws {
                connection: 1,
                previous: Some("resp_tool".to_string()),
                inputs: 1,
            },
        ];
        if api == "openai-codex-responses" {
            expected.push(Seen::Sse {
                inputs: first_inputs + 2,
            });
        } else {
            expected.extend([
                Seen::Upgrade(2),
                Seen::Ws {
                    connection: 2,
                    previous: None,
                    inputs: first_inputs + 2,
                },
            ]);
        }
        assert_eq!(seen, expected, "{api}");
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("done")
        );
        let retried = bodies[2].to_string();
        assert!(retried.contains("call_once"), "{retried}");
        assert!(retried.contains("function_call_output"), "{retried}");
        assert!(retried.contains("probe ran once"), "{retried}");
        assert!(!retried.contains("call_cut"), "{retried}");
    }
}

/// Before any output, the provider's single SSE fallback is still allowed.
#[test]
fn a_socket_drop_before_the_first_event_falls_back_once() {
    for api in ["openai-responses", "openai-codex-responses"] {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut server = runtime.block_on(spawn(
            vec![Upgrade::Accept(vec![Turn::EventsThenFin(Vec::new())])],
            vec![SseReply::Events(text_response(
                "resp_sse",
                "fallback answer",
            ))],
        ));
        let (engine, _dir) = websocket_engine(&server, api);
        let mut events = Vec::new();
        admit(&engine, "hello".to_string(), &mut events);
        assert_eq!(
            assistant_texts(&events),
            vec!["fallback answer".to_string()]
        );
        assert!(retry_events(&events).is_empty());
        let records = server.drain();
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(record, Record::WsRequest { .. }))
                .count(),
            1
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(record, Record::SseRequest { .. }))
                .count(),
            1
        );
    }
}

/// Even a complete streamed tool item is uncommitted until response.completed.
#[test]
fn a_normal_close_before_completion_never_executes_the_streamed_tool_call() {
    for api in ["openai-responses", "openai-codex-responses"] {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut partial = tool_call("resp_cut", "call_cut", "cut");
        partial.pop();
        let mut server = runtime.block_on(recovery_server(
            api,
            vec![Turn::EventsThenClose(partial, 1000, "normal")],
            vec![text_response("resp_done", "done")],
        ));
        let (engine, _dir) = websocket_engine(&server, api);
        let runs = install_probe(&engine);
        let mut events = Vec::new();
        admit(&engine, "do work".to_string(), &mut events);
        assert!(runs.lock().unwrap().is_empty());
        assert!(!events
            .iter()
            .any(|event| matches!(event, EngineEvent::ToolExecutionStart { .. })));
        assert_eq!(retry_events(&events), vec![(true, 1), (false, 1)]);
        let (observed, bodies) = seen(server.drain());
        assert_eq!(bodies.len(), 2);
        let inputs = bodies[0]["input"].as_array().unwrap().len();
        let mut expected = vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs,
            },
        ];
        if api == "openai-codex-responses" {
            expected.push(Seen::Sse { inputs });
        } else {
            expected.extend([
                Seen::Upgrade(2),
                Seen::Ws {
                    connection: 2,
                    previous: None,
                    inputs,
                },
            ]);
        }
        assert_eq!(observed, expected, "{api}");
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("done")
        );
        assert!(bodies[1].get("previous_response_id").is_none());
        assert!(!bodies[1].to_string().contains("call_cut"));
    }
}

/// Cancelling at the observable retry start stops the real socket run before
/// its second request; it does not wait out the transport backoff.
#[test]
fn cancelling_the_transport_retry_wait_prevents_another_socket_request() {
    for api in ["openai-responses", "openai-codex-responses"] {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut partial = vec![created("resp_cut")];
        partial.extend(text_item("resp_cut", "cut").into_iter().take(3));
        let mut server = runtime.block_on(spawn(
            vec![Upgrade::Accept(vec![Turn::EventsThenFin(partial)])],
            Vec::new(),
        ));
        let (engine, _dir) = websocket_engine(&server, api);
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let mut events = Vec::new();
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: "hello".to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| cancelled.load(std::sync::atomic::Ordering::SeqCst),
            &mut |event| {
                if matches!(event, EngineEvent::AutoRetryStart { .. }) {
                    cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                events.push(event);
                true
            },
        );
        assert!(events
            .iter()
            .any(|event| matches!(event, EngineEvent::AutoRetryEnd {
                success: false, final_error: Some(error), ..
            } if error == "Retry cancelled")));
        assert_eq!(retry_events(&events), vec![(true, 1), (false, 1)], "{api}");
        let (observed, bodies) = seen(server.drain());
        assert_eq!(bodies.len(), 1);
        assert_eq!(
            observed,
            vec![
                Seen::Upgrade(1),
                Seen::Ws {
                    connection: 1,
                    previous: None,
                    inputs: bodies[0]["input"].as_array().unwrap().len()
                },
            ],
            "{api}"
        );
    }
}

/// Generic drops reconnect; Codex's first drop pins SSE. Later transient
/// provider failures must not widen that generation's transport budget.
#[test]
fn repeated_real_transport_failures_exhaust_after_three_exact_transport_waits() {
    for api in ["openai-responses", "openai-codex-responses"] {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let partial = |index| {
            let id = format!("resp_drop_{index}");
            let mut events = vec![created(&id)];
            events.extend(text_item(&id, "uncommitted").into_iter().take(3));
            events
        };
        let (upgrades, sse) = if api == "openai-codex-responses" {
            let sse = (1..4)
                .map(|index| {
                    let id = format!("resp_drop_{index}");
                    let mut events = partial(index);
                    events.push(json!({
                        "type": "response.failed",
                        "response": { "id": id, "status": "failed", "output": [],
                            "error": { "code": "server_error", "message": "temporary provider failure" } },
                    }));
                    SseReply::Events(events)
                })
                .collect();
            (
                vec![Upgrade::Accept(vec![Turn::EventsThenFin(partial(0))])],
                sse,
            )
        } else {
            let upgrades = (0..4)
                .map(|index| Upgrade::Accept(vec![Turn::EventsThenFin(partial(index))]))
                .collect();
            (upgrades, Vec::new())
        };
        let mut server = runtime.block_on(spawn(upgrades, sse));
        let (engine, _dir) = websocket_engine(&server, api);
        let mut events = Vec::new();
        admit(&engine, "hello".to_string(), &mut events);
        let delays: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::AutoRetryStart {
                    delay_ms,
                    max_attempts,
                    ..
                } => Some((*delay_ms, *max_attempts)),
                _ => None,
            })
            .collect();
        assert_eq!(delays, vec![(2000, 3), (4000, 3), (8000, 3)], "{api}");
        assert_eq!(
            retry_events(&events),
            vec![(true, 1), (true, 2), (true, 3), (false, 3)],
            "{api}",
        );
        let (observed, bodies) = seen(server.drain());
        assert_eq!(bodies.len(), 4, "{api}");
        let inputs = bodies[0]["input"].as_array().unwrap().len();
        let expected = if api == "openai-codex-responses" {
            vec![
                Seen::Upgrade(1),
                Seen::Ws {
                    connection: 1,
                    previous: None,
                    inputs,
                },
                Seen::Sse { inputs },
                Seen::Sse { inputs },
                Seen::Sse { inputs },
            ]
        } else {
            (1..=4)
                .flat_map(|connection| {
                    [
                        Seen::Upgrade(connection),
                        Seen::Ws {
                            connection,
                            previous: None,
                            inputs,
                        },
                    ]
                })
                .collect()
        };
        assert_eq!(observed, expected, "{api}");
        // Only the WebSocket envelope differs; the complete generation
        // request must remain identical, including committed history.
        let requests: Vec<_> = bodies
            .into_iter()
            .map(|mut body| {
                body.as_object_mut().unwrap().remove("type");
                body
            })
            .collect();
        assert!(
            requests.iter().all(|body| body == &requests[0]),
            "{api}: {requests:?}"
        );
        let failed: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::AssistantMessage(message) if message["stopReason"] == "error" => {
                    Some(message)
                }
                _ => None,
            })
            .collect();
        assert_eq!(failed.len(), 4, "{api}");
        assert!(events.iter().any(|event| matches!(
            event,
            EngineEvent::AutoRetryEnd {
                success: false,
                final_error: Some(_),
                ..
            }
        )));
    }
}
