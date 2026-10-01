//! Generic Responses WebSocket provider behavior, driven through
//! `stream_openai_responses` against the scripted loopback server: the
//! transport selection matrix, handshake headers, socket reuse and delta
//! continuation, fallback rules, terminal handling, ownership, and the
//! transport half of the drop/retry/continuation/fallback scenario.

use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::mock_server::{self, MockServer, Record, SseReply, Turn, Upgrade};
use super::resolve_responses_websocket_url;
use crate::providers::openai_responses::{stream_openai_responses, OpenAIResponsesOptions};
use crate::types::{
    AssistantContent, AssistantMessage, CacheRetention, Context, Message, Model, StopReason,
    StreamOptions, Transport, UserMessage, UserMessageContent,
};

fn model(base_url: &str, compat: Option<Value>) -> Model {
    let mut model = json!({
        "id": "gpt-ws", "name": "gpt-ws", "api": "openai-responses", "provider": "cpa-r",
        "baseUrl": base_url, "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 100_000, "maxTokens": 1000,
    });
    if let Some(compat) = compat {
        model["compat"] = compat;
    }
    serde_json::from_value(model).expect("test model")
}

fn ws_model(server: &MockServer) -> Model {
    model(&server.base_url, Some(json!({ "supportsWebSocket": true })))
}

fn user(text: &str) -> Message {
    Message::User(UserMessage {
        content: UserMessageContent::Text(text.to_string()),
        timestamp: 1,
        rest: Map::default(),
    })
}

/// No system prompt, so input counts are exactly the conversation items.
fn context(messages: Vec<Message>) -> Context {
    Context {
        system_prompt: None,
        messages,
        tools: None,
    }
}

fn options(session_id: Option<&str>, transport: Option<Transport>) -> OpenAIResponsesOptions {
    OpenAIResponsesOptions::from_base(StreamOptions {
        api_key: Some("test-key".to_string()),
        session_id: session_id.map(str::to_string),
        transport,
        ..StreamOptions::default()
    })
}

async fn run(
    model: &Model,
    context: &Context,
    options: &OpenAIResponsesOptions,
) -> AssistantMessage {
    stream_openai_responses(model, context, Some(options))
        .result()
        .await
}

/// A complete text response: lifecycle, one message item, terminal.
fn response(id: &str, text: &str) -> Vec<Value> {
    let mut events = vec![json!({ "type": "response.created", "response": { "id": id } })];
    events.extend(text_item(id, text));
    events.push(completed(id));
    events
}

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
            "type": "response.output_item.done",
            "item": { "type": "message", "id": item_id, "role": "assistant", "status": "completed",
                      "content": [{ "type": "output_text", "text": text }] },
        }),
    ]
}

fn completed(id: &str) -> Value {
    json!({
        "type": "response.completed",
        "response": { "id": id, "status": "completed",
                      "usage": { "input_tokens": 5, "output_tokens": 3, "total_tokens": 8 } },
    })
}

fn text_of(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            AssistantContent::Text(text) => Some(text.text.as_str()),
            AssistantContent::Thinking(_) | AssistantContent::ToolCall(_) => None,
        })
        .collect()
}

/// The compact shape of one observed request: where it went, which
/// response it continues, and how many input items it carries.
#[derive(Debug, PartialEq, Eq)]
enum Seen {
    Upgrade(usize),
    Ws {
        connection: usize,
        previous: Option<String>,
        inputs: usize,
    },
    Sse {
        previous: Option<String>,
        inputs: usize,
    },
}

fn seen(records: Vec<Record>) -> Vec<Seen> {
    let summary = |body: &Value| {
        (
            body.get("previous_response_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            body.get("input")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
        )
    };
    records
        .into_iter()
        .map(|record| match record {
            Record::Upgrade { connection, .. } => Seen::Upgrade(connection),
            Record::WsRequest { connection, body } => {
                let (previous, inputs) = summary(&body);
                Seen::Ws {
                    connection,
                    previous,
                    inputs,
                }
            }
            Record::SseRequest { body, .. } => {
                let (previous, inputs) = summary(&body);
                Seen::Sse { previous, inputs }
            }
        })
        .collect()
}

fn diagnostic(message: &AssistantMessage, kind: &str) -> Option<Value> {
    message
        .diagnostics
        .as_deref()?
        .iter()
        .find(|diagnostic| diagnostic.type_ == kind)
        .map(|diagnostic| {
            let mut value = serde_json::to_value(diagnostic).expect("diagnostic json");
            value.as_object_mut().expect("object").remove("timestamp");
            value
        })
}

#[test]
fn websocket_urls_derive_from_the_base_url() {
    for (base, expected) in [
        ("", "wss://api.openai.com/v1/responses"),
        (
            "  https://api.example.com/v1/  ",
            "wss://api.example.com/v1/responses",
        ),
        (
            "http://127.0.0.1:8317/v1",
            "ws://127.0.0.1:8317/v1/responses",
        ),
        (
            "http://127.0.0.1:8317/v1/responses",
            "ws://127.0.0.1:8317/v1/responses",
        ),
        (
            "https://gw.example.com/v1?team=a",
            "wss://gw.example.com/v1/responses?team=a",
        ),
        ("https://gw.example.com", "wss://gw.example.com/responses"),
    ] {
        assert_eq!(
            resolve_responses_websocket_url(base).as_deref(),
            Ok(expected),
            "{base:?}"
        );
    }
}

/// `auto` uses the socket only for an opted-in model; `sse` never does;
/// the explicit WebSocket transports do regardless of the opt-in.
#[tokio::test]
async fn transport_selection_follows_the_opt_in_and_explicit_modes() {
    let cases: [(Option<Value>, Option<Transport>, bool); 7] = [
        (None, None, false),
        (
            Some(json!({ "supportsWebSocket": false })),
            Some(Transport::Auto),
            false,
        ),
        (Some(json!({ "supportsWebSocket": true })), None, true),
        (
            Some(json!({ "supportsWebSocket": true })),
            Some(Transport::Sse),
            false,
        ),
        (None, Some(Transport::Websocket), true),
        (
            Some(json!({ "supportsWebSocket": false })),
            Some(Transport::WebsocketCached),
            true,
        ),
        (Some(json!({ "sendSessionIdHeader": true })), None, false),
    ];
    for (compat, transport, uses_socket) in cases {
        let mut server = mock_server::spawn(
            vec![Upgrade::Accept(vec![Turn::Events(response(
                "resp_1", "hi",
            ))])],
            vec![SseReply::Events(response("resp_1", "hi"))],
        )
        .await;
        let message = run(
            &model(&server.base_url, compat.clone()),
            &context(vec![user("hello")]),
            &options(None, transport),
        )
        .await;
        assert_eq!(text_of(&message), "hi", "{compat:?} {transport:?}");
        let expected = if uses_socket {
            vec![
                Seen::Upgrade(1),
                Seen::Ws {
                    connection: 1,
                    previous: None,
                    inputs: 1,
                },
            ]
        } else {
            vec![Seen::Sse {
                previous: None,
                inputs: 1,
            }]
        };
        assert_eq!(seen(server.drain()), expected, "{compat:?} {transport:?}");
    }
}

/// The affinity-relevant handshake headers of the first upgrade in
/// `records`, sorted by name (the mock lowercases names).
fn upgrade_headers(records: &[Record]) -> Vec<(String, String)> {
    let Some(Record::Upgrade { headers, .. }) = records.first() else {
        panic!("expected an upgrade first: {records:?}");
    };
    let mut ours: Vec<(String, String)> = headers
        .iter()
        .filter(|(name, _)| {
            matches!(
                name.as_str(),
                "x-team" | "x-model-only" | "session_id" | "x-client-request-id" | "authorization"
            )
        })
        .cloned()
        .collect();
    ours.sort();
    ours
}

fn pair(name: &str, value: &str) -> (String, String) {
    (name.to_string(), value.to_string())
}

/// A WebSocket model with two model headers, one of which a request
/// header overrides (case-insensitively) in the tests below.
fn model_with_headers(server: &MockServer, compat: Value) -> Model {
    let mut ws = model(&server.base_url, Some(compat));
    ws.headers = Some(
        [pair("X-Team", "model"), pair("X-Model-Only", "m")]
            .into_iter()
            .collect(),
    );
    ws
}

/// The handshake carries the SSE header set in the TS order: model
/// headers, the cache/session affinity pair, request overrides (case
/// insensitive), then the bearer credential; the body is the SSE body
/// framed as `response.create`, cache key included.
#[tokio::test]
async fn handshake_headers_follow_the_sse_precedence() {
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![Turn::Events(response("resp_1", "a"))])],
        Vec::new(),
    )
    .await;
    let ws = model_with_headers(&server, json!({ "supportsWebSocket": true }));
    let mut request = options(Some("hdr-session"), None);
    request.base.headers = Some([pair("x-team", "override")].into_iter().collect());
    run(&ws, &context(vec![user("one")]), &request).await;
    let records = server.drain();
    assert_eq!(
        upgrade_headers(&records),
        vec![
            pair("authorization", "Bearer test-key"),
            pair("session_id", "hdr-session"),
            pair("x-client-request-id", "hdr-session"),
            pair("x-model-only", "m"),
            pair("x-team", "override"),
        ]
    );
    let Record::WsRequest { body, .. } = &records[1] else {
        panic!("expected the request: {records:?}");
    };
    assert_eq!(body["type"], json!("response.create"));
    assert_eq!(body["prompt_cache_key"], json!("hdr-session"));
}

/// `cacheRetention: none` drops the affinity pair and the cache key but
/// keeps the session's socket ownership (the second request reuses it).
#[tokio::test]
async fn no_cache_retention_drops_affinity_but_keeps_the_socket() {
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![
            Turn::Events(response("resp_1", "a")),
            Turn::Events(response("resp_2", "b")),
        ])],
        Vec::new(),
    )
    .await;
    let ws = model_with_headers(&server, json!({ "supportsWebSocket": true }));
    let mut no_cache = options(Some("hdr-none"), None);
    no_cache.base.cache_retention = Some(CacheRetention::None);
    run(&ws, &context(vec![user("one")]), &no_cache).await;
    run(&ws, &context(vec![user("two")]), &no_cache).await;
    let records = server.drain();
    assert_eq!(
        upgrade_headers(&records),
        vec![
            pair("authorization", "Bearer test-key"),
            pair("x-model-only", "m"),
            pair("x-team", "model"),
        ]
    );
    let Record::WsRequest { body, .. } = &records[1] else {
        panic!("expected the request: {records:?}");
    };
    assert_eq!(body.get("prompt_cache_key"), None);
    assert_eq!(
        seen(records),
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
        ]
    );
}

/// `sendSessionIdHeader: false` drops only `session_id`; the request id
/// header stays.
#[tokio::test]
async fn send_session_id_header_false_drops_only_session_id() {
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![Turn::Events(response("resp_1", "a"))])],
        Vec::new(),
    )
    .await;
    let quiet = model_with_headers(
        &server,
        json!({ "supportsWebSocket": true, "sendSessionIdHeader": false }),
    );
    run(
        &quiet,
        &context(vec![user("one")]),
        &options(Some("hdr-quiet"), None),
    )
    .await;
    assert_eq!(
        upgrade_headers(&server.drain()),
        vec![
            pair("authorization", "Bearer test-key"),
            pair("x-client-request-id", "hdr-quiet"),
            pair("x-model-only", "m"),
            pair("x-team", "model"),
        ]
    );
}

/// The response hook sees the synthetic 101 handshake (no headers).
#[tokio::test]
async fn the_response_hook_sees_the_synthetic_upgrade() {
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![Turn::Events(response(
            "resp_1", "ok",
        ))])],
        Vec::new(),
    )
    .await;
    let seen_responses = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = std::sync::Arc::clone(&seen_responses);
    let mut request = options(None, None);
    request.base.on_response = Some(std::sync::Arc::new(move |response, _model| {
        sink.lock()
            .unwrap()
            .push((response.status, response.headers));
    }));
    let message = run(&ws_model(&server), &context(vec![user("hi")]), &request).await;
    assert_eq!(text_of(&message), "ok");
    assert_eq!(
        *seen_responses.lock().unwrap(),
        vec![(101, std::collections::BTreeMap::new())]
    );
    server.drain();
}

/// `websocket` reuses the session's socket but always sends the full
/// request; `websocket-cached` (and `auto`) continue the previous response.
#[tokio::test]
async fn full_and_cached_modes_share_the_socket_but_not_the_delta() {
    for (transport, continues) in [
        (Transport::Websocket, false),
        (Transport::WebsocketCached, true),
    ] {
        let mut server = mock_server::spawn(
            vec![Upgrade::Accept(vec![
                Turn::Events(response("resp_1", "first")),
                Turn::Events(response("resp_2", "second")),
            ])],
            Vec::new(),
        )
        .await;
        let ws = model(&server.base_url, None);
        let session = format!("modes-{transport:?}");
        let request = options(Some(&session), Some(transport));
        let first = run(&ws, &context(vec![user("one")]), &request).await;
        run(
            &ws,
            &context(vec![user("one"), Message::Assistant(first), user("two")]),
            &request,
        )
        .await;
        let second = if continues {
            Seen::Ws {
                connection: 1,
                previous: Some("resp_1".to_string()),
                inputs: 1,
            }
        } else {
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 3,
            }
        };
        assert_eq!(
            seen(server.drain()),
            vec![
                Seen::Upgrade(1),
                Seen::Ws {
                    connection: 1,
                    previous: None,
                    inputs: 1
                },
                second,
            ],
            "{transport:?}"
        );
    }
}

/// A body change (here the model) or a rewritten history invalidates the
/// anchor: the request goes out in full on the same socket.
#[tokio::test]
async fn body_and_history_changes_send_the_full_request() {
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![
            Turn::Events(response("resp_1", "first")),
            Turn::Events(response("resp_2", "second")),
            Turn::Events(response("resp_3", "third")),
        ])],
        Vec::new(),
    )
    .await;
    let ws = ws_model(&server);
    let request = options(Some("invalidate-session"), None);
    let first = run(&ws, &context(vec![user("one")]), &request).await;
    let mut renamed = ws.clone();
    renamed.id = "gpt-ws-2".to_string();
    let second = run(
        &renamed,
        &context(vec![user("one"), Message::Assistant(first), user("two")]),
        &request,
    )
    .await;
    // A compaction-like rewrite: the summary replaces the history prefix.
    run(
        &renamed,
        &context(vec![
            user("summary"),
            Message::Assistant(second),
            user("three"),
        ]),
        &request,
    )
    .await;
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 3
            },
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 3
            },
        ]
    );
}

/// `response.incomplete` settles the request (stop reason length) without
/// waiting for a close, and a binary terminal frame ends its request too:
/// both leave the socket reusable.
#[tokio::test]
async fn incomplete_and_binary_terminals_settle_without_a_close() {
    let mut incomplete =
        vec![json!({ "type": "response.created", "response": { "id": "resp_1" } })];
    incomplete.extend(text_item("resp_1", "cut"));
    incomplete.push(json!({
        "type": "response.incomplete",
        "response": { "id": "resp_1", "status": "incomplete",
                      "incomplete_details": { "reason": "max_output_tokens" } },
    }));
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![
            Turn::Events(incomplete),
            Turn::BinaryEvents(response("resp_2", "binary")),
            Turn::Events(response("resp_3", "after")),
        ])],
        Vec::new(),
    )
    .await;
    let ws = ws_model(&server);
    let request = options(Some("terminal-session"), Some(Transport::Websocket));
    let first = run(&ws, &context(vec![user("one")]), &request).await;
    assert_eq!(
        (first.stop_reason, text_of(&first)),
        (StopReason::Length, "cut".to_string())
    );
    let second = run(&ws, &context(vec![user("two")]), &request).await;
    assert_eq!(
        (second.stop_reason, text_of(&second)),
        (StopReason::Stop, "binary".to_string())
    );
    let third = run(&ws, &context(vec![user("three")]), &request).await;
    assert_eq!(text_of(&third), "after");
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
        ]
    );
}

/// A provider error event followed by a close keeps the provider verdict
/// (CPA's nested 503 envelope classifies as a server error), and the
/// started request never falls back to SSE.
#[tokio::test]
async fn a_terminal_error_before_the_close_keeps_the_provider_verdict() {
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![Turn::EventsThenClose(
            vec![json!({
                "type": "error", "status": 503,
                "error": { "type": "server_error", "code": "auth_unavailable", "message": "no healthy credential" },
            })],
            1011,
            "upstream failed",
        )])],
        vec![SseReply::Events(response("resp_sse", "never"))],
    )
    .await;
    let message = run(
        &ws_model(&server),
        &context(vec![user("hi")]),
        &options(Some("verdict-session"), None),
    )
    .await;
    assert_eq!(message.stop_reason, StopReason::Error);
    assert_eq!(
        message.error_message.as_deref(),
        Some("Provider server error (server_error, auth_unavailable, 503): no healthy credential")
    );
    assert_eq!(
        diagnostic(&message, "provider_stream_failure").map(|value| value["details"].clone()),
        Some(json!({
            "kind": "server_error",
            "providerErrorType": "server_error",
            "providerErrorCode": "auth_unavailable",
            "status": 503,
            "raw": r#"{"type":"error","status":503,"providerErrorType":"server_error","providerErrorCode":"auth_unavailable","message":"no healthy credential"}"#,
        }))
    );
    assert!(
        !server
            .drain()
            .iter()
            .any(|record| matches!(record, Record::SseRequest { .. })),
        "a started request never replays over SSE"
    );
}

/// A malformed frame before any event falls back to SSE once; after the
/// first event it fails the request without a fallback.
#[tokio::test]
async fn malformed_frames_fall_back_only_before_the_first_event() {
    let mut server = mock_server::spawn(
        vec![
            Upgrade::Accept(vec![Turn::RawText(vec!["not json"])]),
            Upgrade::Accept(vec![Turn::RawText(vec![
                r#"{"type":"response.created","response":{"id":"resp_2"}}"#,
                "still not json",
            ])]),
        ],
        vec![SseReply::Events(response("resp_sse", "via sse"))],
    )
    .await;
    let ws = ws_model(&server);
    let fallback = run(&ws, &context(vec![user("one")]), &options(None, None)).await;
    assert_eq!(text_of(&fallback), "via sse");
    assert_eq!(
        diagnostic(&fallback, "provider_transport_failure").map(|value| value["details"].clone()),
        Some(json!({
            "configuredTransport": "auto",
            "fallbackTransport": "sse",
            "eventsEmitted": false,
            "phase": "before_message_stream_start",
        }))
    );
    let failed = run(&ws, &context(vec![user("two")]), &options(None, None)).await;
    assert_eq!(failed.stop_reason, StopReason::Error);
    assert_eq!(
        diagnostic(&failed, "provider_transport_failure").map(|value| value["details"].clone()),
        Some(json!({
            "configuredTransport": "auto",
            "eventsEmitted": true,
            "phase": "after_message_stream_start",
        }))
    );
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
            Seen::Sse {
                previous: None,
                inputs: 1
            },
            Seen::Upgrade(2),
            Seen::Ws {
                connection: 2,
                previous: None,
                inputs: 1
            },
        ]
    );
}

/// A credential (or route) change replaces the session's socket: the new
/// connection starts without a continuation.
#[tokio::test]
async fn a_credential_change_replaces_the_socket() {
    let mut server = mock_server::spawn(
        vec![
            Upgrade::Accept(vec![Turn::Events(response("resp_1", "a"))]),
            Upgrade::Accept(vec![Turn::Events(response("resp_2", "b"))]),
        ],
        Vec::new(),
    )
    .await;
    let ws = ws_model(&server);
    let first = run(
        &ws,
        &context(vec![user("one")]),
        &options(Some("rotate"), None),
    )
    .await;
    let mut rotated = options(Some("rotate"), None);
    rotated.base.api_key = Some("rotated-key".to_string());
    run(
        &ws,
        &context(vec![user("one"), Message::Assistant(first), user("two")]),
        &rotated,
    )
    .await;
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
            Seen::Upgrade(2),
            Seen::Ws {
                connection: 2,
                previous: None,
                inputs: 3
            },
        ]
    );
}

/// A later claim owns the session slot even when an earlier connection
/// opens after it: the earlier one serves its request and closes, and the
/// next request reuses the later connection.
#[tokio::test]
async fn a_later_claim_owns_the_slot_when_an_earlier_socket_opens_late() {
    let (open_first, gate) = tokio::sync::oneshot::channel();
    let mut server = mock_server::spawn(
        vec![
            Upgrade::AcceptWhen(gate, vec![Turn::Events(response("resp_a", "late"))]),
            Upgrade::Accept(vec![
                Turn::Events(response("resp_b", "early")),
                Turn::Events(response("resp_c", "reuse")),
            ]),
        ],
        Vec::new(),
    )
    .await;
    let ws = ws_model(&server);
    let late = stream_openai_responses(
        &ws,
        &context(vec![user("a")]),
        Some(&options(Some("claims"), None)),
    );
    // The first handshake is in flight (observed), then the second claim
    // connects and finishes first.
    assert!(matches!(
        server.next_record().await,
        Record::Upgrade { connection: 1, .. }
    ));
    let early = run(
        &ws,
        &context(vec![user("b")]),
        &options(Some("claims"), None),
    )
    .await;
    assert_eq!(text_of(&early), "early");
    open_first.send(()).expect("gate");
    assert_eq!(text_of(&late.result().await), "late");
    run(
        &ws,
        &context(vec![user("c")]),
        &options(Some("claims"), None),
    )
    .await;
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(2),
            Seen::Ws {
                connection: 2,
                previous: None,
                inputs: 1
            },
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
            Seen::Ws {
                connection: 2,
                previous: None,
                inputs: 1
            },
        ]
    );
}

/// Session disposal cancels a request stalled on the socket and one still
/// connecting: both settle as aborted with the disposal text, never as a
/// transport failure, and neither replays over SSE.
#[tokio::test]
async fn session_disposal_cancels_stalled_and_connecting_requests() {
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![Turn::Stall]), Upgrade::Hang],
        vec![SseReply::Events(response("resp_sse", "never"))],
    )
    .await;
    let ws = ws_model(&server);
    let stalled = stream_openai_responses(
        &ws,
        &context(vec![user("a")]),
        Some(&options(Some("dispose-stalled"), None)),
    );
    assert!(matches!(server.next_record().await, Record::Upgrade { .. }));
    assert!(matches!(
        server.next_record().await,
        Record::WsRequest { .. }
    ));
    crate::cleanup_session_resources(Some("dispose-stalled"));
    let stalled = stalled.result().await;

    let connecting = stream_openai_responses(
        &ws,
        &context(vec![user("b")]),
        Some(&options(Some("dispose-connecting"), None)),
    );
    assert!(matches!(server.next_record().await, Record::Upgrade { .. }));
    crate::cleanup_session_resources(Some("dispose-connecting"));
    let connecting = connecting.result().await;

    for message in [&stalled, &connecting] {
        assert_eq!(message.stop_reason, StopReason::Aborted);
        assert_eq!(
            message.error_message.as_deref(),
            Some(super::SESSION_DISPOSED_MESSAGE)
        );
        let transport = diagnostic(message, "provider_transport_failure").expect("diagnostic");
        assert_eq!(
            transport["error"],
            json!({
                "name": "AbortError",
                "message": super::SESSION_DISPOSED_MESSAGE,
                "code": "session_disposed",
            })
        );
        assert_eq!(transport["details"].get("fallbackTransport"), None);
        assert_eq!(diagnostic(message, "provider_stream_failure"), None);
    }
    assert!(!server
        .drain()
        .iter()
        .any(|record| matches!(record, Record::SseRequest { .. })));
    assert_eq!(super::session::owned_request_count("dispose-stalled"), 0);
    assert_eq!(super::session::owned_request_count("dispose-connecting"), 0);
}

/// An abort from the response hook (fired at the upgrade) stops the
/// request before its frame is sent.
#[tokio::test]
async fn an_abort_from_the_response_hook_stops_before_sending() {
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![Turn::Events(response(
            "resp_1", "never",
        ))])],
        vec![SseReply::Events(response("resp_sse", "never"))],
    )
    .await;
    let signal = CancellationToken::new();
    let hook_signal = signal.clone();
    let mut request = options(Some("hook-abort"), None);
    request.base.signal = Some(signal);
    request.base.on_response = Some(std::sync::Arc::new(move |_response, _model| {
        hook_signal.cancel();
    }));
    let message = run(&ws_model(&server), &context(vec![user("hi")]), &request).await;
    assert_eq!(message.stop_reason, StopReason::Aborted);
    assert_eq!(seen(server.drain()), vec![Seen::Upgrade(1)]);
}

/// An idle connection expires after the TTL: the next request opens a new
/// socket (paused clock; no real wait).
#[tokio::test]
async fn idle_connections_expire_after_the_ttl() {
    let mut server = mock_server::spawn(
        vec![
            Upgrade::Accept(vec![Turn::Events(response("resp_1", "a"))]),
            Upgrade::Accept(vec![Turn::Events(response("resp_2", "b"))]),
        ],
        Vec::new(),
    )
    .await;
    let ws = ws_model(&server);
    let first = run(
        &ws,
        &context(vec![user("one")]),
        &options(Some("expiry"), None),
    )
    .await;
    let cached = super::session::cached_connection_id("expiry").expect("cached connection");
    tokio::time::pause();
    tokio::time::sleep(super::session::CONNECTION_IDLE_TTL + std::time::Duration::from_secs(1))
        .await;
    tokio::time::resume();
    assert_eq!(
        super::session::cached_connection_id("expiry"),
        None,
        "{cached}"
    );
    run(
        &ws,
        &context(vec![user("one"), Message::Assistant(first), user("two")]),
        &options(Some("expiry"), None),
    )
    .await;
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
            Seen::Upgrade(2),
            Seen::Ws {
                connection: 2,
                previous: None,
                inputs: 3
            },
        ]
    );
}

/// The transport half of the combined drop/retry/continuation/fallback
/// scenario (port map §4.1): delta before the failure, a mid-stream drop
/// that fails with a structured transport failure and no same-attempt SSE
/// POST, the session's re-issue on a fresh socket with the full body (no
/// stale `previous_response_id`), delta continuation from the recovered
/// response, a later pre-first-event upgrade rejection with exactly one
/// SSE fallback, and the next request trying the socket again (generic
/// Responses never pins a session to SSE).
#[tokio::test]
// One scenario, step by step in the port map's order (each step depends on
// the connection state the previous one left), so it stays one function.
#[allow(clippy::too_many_lines)]
async fn drop_retry_continuation_and_fallback_scenario() {
    let mut partial =
        vec![json!({ "type": "response.created", "response": { "id": "resp_drop" } })];
    partial.extend(text_item("resp_drop", "partial ").into_iter().take(3));
    let mut server = mock_server::spawn(
        vec![
            Upgrade::Accept(vec![
                Turn::Events(response("resp_1", "one")),
                Turn::EventsThenFin(partial),
            ]),
            Upgrade::Accept(vec![
                Turn::Events(response("resp_2", "two")),
                Turn::Events(response("resp_3", "three")),
            ]),
            Upgrade::Reject(500),
            Upgrade::Accept(vec![Turn::Events(response("resp_5", "five"))]),
        ],
        vec![SseReply::Events(response("resp_4", "four"))],
    )
    .await;
    let ws = ws_model(&server);
    let request = options(Some("scenario"), None);

    // 1. A full request anchors resp_1.
    let first = run(&ws, &context(vec![user("u1")]), &request).await;
    assert_eq!(first.response_id.as_deref(), Some("resp_1"));
    // 2-5. The next request continues resp_1 with only the new input, then
    // the socket drops after a partial delta.
    let retry_context = context(vec![user("u1"), Message::Assistant(first), user("u2")]);
    let dropped = run(&ws, &retry_context, &request).await;
    assert_eq!(dropped.stop_reason, StopReason::Error);
    assert_eq!(
        dropped.error_message.as_deref(),
        Some("WebSocket closed before response.completed")
    );
    assert_eq!(
        diagnostic(&dropped, "provider_stream_failure").map(|value| value["details"].clone()),
        Some(json!({
            "kind": "transport",
            "providerErrorType": "websocket_closed",
            "transport": { "protocol": "websocket", "cause": "closed", "closeCode": 1006, "wasClean": false },
        }))
    );
    assert_eq!(
        diagnostic(&dropped, "provider_transport_failure").map(|value| value["details"].clone()),
        Some(json!({
            "configuredTransport": "auto",
            "eventsEmitted": true,
            "phase": "after_message_stream_start",
        }))
    );
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
            Seen::Ws {
                connection: 1,
                previous: Some("resp_1".to_string()),
                inputs: 1
            },
        ],
        "no same-attempt SSE POST"
    );
    // 6-9. The session re-issues the failed request (its context without
    // the failed assistant): a fresh socket, the full body.
    let recovered = run(&ws, &retry_context, &request).await;
    assert_eq!(recovered.response_id.as_deref(), Some("resp_2"));
    // 10. Delta continuation resumes from the recovered response.
    let mut next_messages = retry_context.messages.clone();
    next_messages.push(Message::Assistant(recovered.clone()));
    next_messages.push(user("u3"));
    let third = run(&ws, &context(next_messages.clone()), &request).await;
    assert_eq!(text_of(&third), "three");
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(2),
            Seen::Ws {
                connection: 2,
                previous: None,
                inputs: 3
            },
            Seen::Ws {
                connection: 2,
                previous: Some("resp_2".to_string()),
                inputs: 1
            },
        ]
    );
    // 11-12. The idle socket expires; the next upgrade is rejected before
    // any event and the request falls back to exactly one full SSE POST.
    tokio::time::pause();
    tokio::time::sleep(super::session::CONNECTION_IDLE_TTL + std::time::Duration::from_secs(1))
        .await;
    tokio::time::resume();
    next_messages.push(Message::Assistant(third));
    next_messages.push(user("u4"));
    let fallback = run(&ws, &context(next_messages.clone()), &request).await;
    assert_eq!(text_of(&fallback), "four");
    let transport = diagnostic(&fallback, "provider_transport_failure").expect("diagnostic");
    assert_eq!(
        transport,
        json!({
            "type": "provider_transport_failure",
            "error": {
                "name": "WebSocketTransportError",
                "message": "Received network error or non-101 status code.",
            },
            "details": {
                "configuredTransport": "auto",
                "fallbackTransport": "sse",
                "eventsEmitted": false,
                "phase": "before_message_stream_start",
            },
        })
    );
    // 13. The next request tries the socket again.
    next_messages.push(Message::Assistant(fallback));
    next_messages.push(user("u5"));
    let again = run(&ws, &context(next_messages), &request).await;
    assert_eq!(text_of(&again), "five");
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(3),
            Seen::Sse {
                previous: None,
                inputs: 7
            },
            Seen::Upgrade(4),
            Seen::Ws {
                connection: 4,
                previous: None,
                inputs: 9
            },
        ]
    );
}
