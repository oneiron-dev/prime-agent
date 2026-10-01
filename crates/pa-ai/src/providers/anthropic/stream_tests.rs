//! Characterization tests for the Anthropic SSE stream, replayed through a
//! local in-process SSE server.

use serde_json::{json, Map, Value};

use crate::event_stream::AssistantMessageEventExt;
use crate::providers::anthropic::{stream_anthropic, AnthropicOptions};
use crate::types::{
    AssistantContent, AssistantMessage, AssistantMessageEvent, Context, Model, ResponseModelSource,
    StopReason, StreamOptions, ThinkingContent, ToolCall, Usage,
};

const REQUESTED_MODEL: &str = "claude-fable-5-1-exp";

/// Serve one SSE body from a loopback listener and collect every event the
/// provider stream emits for it.
async fn replay(sse: String) -> Vec<AssistantMessageEvent> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 8192];
        let _ = socket.read(&mut request).await.unwrap();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{sse}",
                    sse.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let model: Model = serde_json::from_value(json!({
        "id": REQUESTED_MODEL, "name": "Claude Test", "api": "anthropic-messages",
        "provider": "anthropic", "baseUrl": format!("http://{addr}"), "reasoning": false,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128_000, "maxTokens": 8192
    }))
    .unwrap();
    let options = AnthropicOptions::from_base(StreamOptions {
        api_key: Some("sk-ant-api-test".into()),
        ..Default::default()
    });
    let mut reader = stream_anthropic(
        &model,
        &Context {
            system_prompt: None,
            messages: vec![],
            tools: None,
        },
        Some(&options),
    );
    let mut events = Vec::new();
    while let Some(event) = reader.next_event().await {
        events.push(event);
    }
    events
}

#[tokio::test]
async fn stream_events_snapshot_current_content() {
    let mut sse = [
        r#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":2}}}"#,
        r#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        r#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think"}}"#,
        r#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}"#,
        r#"event: content_block_stop
data: {"type":"content_block_stop","index":0}"#,
        r#"event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"lookup","input":{}}}"#,
        r#"event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}}"#,
        r#"event: content_block_stop
data: {"type":"content_block_stop","index":1}"#,
        r#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}"#,
        r#"event: message_stop
data: {"type":"message_stop"}"#,
    ]
    .join("\n\n");
    sse.push_str("\n\n");
    let events = replay(sse).await;

    let thinking_base = ThinkingContent {
        thinking: String::new(),
        thinking_signature: Some(String::new()),
        redacted: None,
        rest: Map::default(),
    };
    let thinking_delta = AssistantContent::Thinking(ThinkingContent {
        thinking: "think".into(),
        ..thinking_base.clone()
    });
    let thinking_signed = AssistantContent::Thinking(ThinkingContent {
        thinking: "think".into(),
        thinking_signature: Some("sig".into()),
        ..thinking_base.clone()
    });
    let tool_call_base = ToolCall {
        id: "t1".into(),
        name: "lookup".into(),
        arguments: Map::default(),
        thought_signature: None,
        rest: Map::default(),
    };
    let tool_call_args = AssistantContent::ToolCall(ToolCall {
        arguments: json!({"a": 1}).as_object().cloned().unwrap(),
        ..tool_call_base.clone()
    });
    assert_eq!(
        events
            .iter()
            .map(|event| (event.event_type(), event.partial().content.clone()))
            .collect::<Vec<_>>(),
        vec![
            ("start", vec![]),
            (
                "thinking_start",
                vec![AssistantContent::Thinking(thinking_base)]
            ),
            ("thinking_delta", vec![thinking_delta]),
            ("thinking_end", vec![thinking_signed.clone()]),
            (
                "toolcall_start",
                vec![
                    thinking_signed.clone(),
                    AssistantContent::ToolCall(tool_call_base),
                ],
            ),
            (
                "toolcall_delta",
                vec![thinking_signed.clone(), tool_call_args.clone()]
            ),
            (
                "toolcall_end",
                vec![thinking_signed.clone(), tool_call_args.clone()]
            ),
            ("done", vec![thinking_signed, tool_call_args]),
        ]
    );
    assert_eq!(
        events.last().unwrap().partial().stop_reason,
        StopReason::ToolUse
    );
}

/// SSE body for a plain `end_turn` reply whose `message_start` carries
/// `message`.
fn end_turn_sse(message: &Value) -> String {
    let start = json!({"type": "message_start", "message": message});
    let delta = json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}});
    let stop = json!({"type": "message_stop"});
    format!(
        "event: message_start\ndata: {start}\n\n\
         event: message_delta\ndata: {delta}\n\n\
         event: message_stop\ndata: {stop}\n\n"
    )
}

/// The final reply of [`end_turn_sse`] before any response model is recorded.
fn end_turn_reply(timestamp: u64) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: "anthropic-messages".into(),
        provider: "anthropic".into(),
        model: REQUESTED_MODEL.into(),
        response_model: None,
        response_model_source: None,
        response_id: Some("msg_wire".into()),
        diagnostics: None,
        usage: Usage::default(),
        stop_reason: StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp,
        rest: Map::default(),
    }
}

/// TS `provider-response-model.test.ts`: the `message_start` model is
/// recorded beside the untouched requested selector, whatever it names.
#[tokio::test]
async fn message_start_model_is_recorded_beside_the_requested_selector() {
    for wire in [
        "claude-fable-5.1",
        "gpt-6-astra",
        REQUESTED_MODEL,
        "unapproved-model",
    ] {
        let events = replay(end_turn_sse(&json!({"id": "msg_wire", "model": wire}))).await;
        let message = events
            .last()
            .and_then(AssistantMessageEventExt::terminal_message)
            .unwrap();
        assert_eq!(
            message,
            AssistantMessage {
                response_model: Some(wire.into()),
                response_model_source: Some(ResponseModelSource::ProviderResponse),
                ..end_turn_reply(message.timestamp)
            },
            "wire model {wire}"
        );
    }
}

/// A missing, blank, or non-string `message_start` model records nothing.
#[tokio::test]
async fn message_start_without_a_usable_model_records_none() {
    for start in [
        json!({"id": "msg_wire"}),
        json!({"id": "msg_wire", "model": ""}),
        json!({"id": "msg_wire", "model": "   "}),
        json!({"id": "msg_wire", "model": null}),
    ] {
        let events = replay(end_turn_sse(&start)).await;
        let message = events
            .last()
            .and_then(AssistantMessageEventExt::terminal_message)
            .unwrap();
        assert_eq!(
            message,
            end_turn_reply(message.timestamp),
            "message_start {start}"
        );
    }
}
