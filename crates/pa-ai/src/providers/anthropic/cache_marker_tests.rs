//! Cache-marker parity pins for the Anthropic body (TS `getCacheControl`,
//! `buildParams`, `convertMessages`, `convertTools`): the retention picks
//! the marker and its TTL, and the markers land on the system blocks, the
//! last tool definition, and the final user turn's last eligible block.
//! Markers ride the body only; the session-affinity opt-in never moves them
//! (the wire parity replay in `session_affinity_tests` covers that).

use serde_json::{json, Value};

use super::params::build_params;
use super::{get_cache_control, AnthropicOptions};
use crate::types::{CacheRetention, Context, Model, StreamOptions};

fn model(compat: Option<Value>) -> Model {
    let mut model = json!({
        "id": "claude-test", "name": "Claude Test", "api": "anthropic-messages",
        "provider": "cpa-a", "baseUrl": "http://localhost:8317", "reasoning": false,
        "input": ["text", "image"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 200_000, "maxTokens": 32_000
    });
    if let Some(compat) = compat {
        model["compat"] = compat;
    }
    serde_json::from_value(model).unwrap()
}

fn context(messages: &Value) -> Context {
    serde_json::from_value(json!({
        "systemPrompt": "You are terse.",
        "messages": messages,
        "tools": [
            {"name": "read", "description": "Read a file", "parameters": {
                "type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]
            }},
            {"name": "write", "description": "Write a file", "parameters": {
                "type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]
            }}
        ]
    }))
    .unwrap()
}

/// The params for `messages` under `retention`, as an API-key request.
fn params(model: &Model, messages: &Value, retention: CacheRetention, api_key: &str) -> Value {
    let (_, cache_control) = get_cache_control(model, Some(retention));
    let options = AnthropicOptions::from_base(StreamOptions {
        api_key: Some(api_key.into()),
        cache_retention: Some(retention),
        ..Default::default()
    });
    build_params(
        model,
        &context(messages),
        super::headers::is_oauth_token(api_key),
        Some(&options),
        cache_control.as_ref(),
    )
}

fn assistant(content: &Value, stop_reason: &str) -> Value {
    json!({
        "role": "assistant", "content": content,
        "api": "anthropic-messages", "provider": "cpa-a", "model": "claude-test",
        "usage": {
            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
        },
        "stopReason": stop_reason, "timestamp": 2
    })
}

fn tool_result(id: &str, text: &str) -> Value {
    json!({
        "role": "toolResult", "toolCallId": id, "toolName": "read",
        "content": [{"type": "text", "text": text}], "isError": false, "timestamp": 3
    })
}

/// The whole body for one user turn: `marker` on the system block, the
/// last tool definition and the user text (a string user turn becomes one
/// marked text block); no marker leaves the user turn a string.
fn one_turn_body(marker: Option<&Value>) -> Value {
    let with_marker = |mut block: Value| {
        if let Some(marker) = marker {
            block["cache_control"] = marker.clone();
        }
        block
    };
    let schema = json!({
        "type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]
    });
    json!({
        "model": "claude-test",
        "messages": [{
            "role": "user",
            "content": if marker.is_some() {
                json!([with_marker(json!({"type": "text", "text": "Say hello."}))])
            } else {
                json!("Say hello.")
            }
        }],
        "max_tokens": 10_666,
        "stream": true,
        "system": [with_marker(json!({"type": "text", "text": "You are terse."}))],
        "tools": [
            {"name": "read", "description": "Read a file", "eager_input_streaming": true,
             "input_schema": schema},
            with_marker(json!({"name": "write", "description": "Write a file",
                          "eager_input_streaming": true, "input_schema": schema}))
        ]
    })
}

/// `short` marks without a TTL, `long` adds `1h` only where the model
/// supports it (a shared-key-only compat object counts), `none` marks
/// nothing.
#[test]
fn retention_picks_the_marker_and_its_ttl() {
    let turn = json!([{"role": "user", "content": "Say hello.", "timestamp": 1}]);
    let short = json!({"type": "ephemeral"});
    let long = json!({"type": "ephemeral", "ttl": "1h"});
    let unsupported = model(Some(json!({
        "sendSessionAffinityHeaders": true,
        "supportsLongCacheRetention": false
    })));
    assert_eq!(
        [
            params(&model(None), &turn, CacheRetention::Short, "test-key"),
            params(&model(None), &turn, CacheRetention::Long, "test-key"),
            params(&unsupported, &turn, CacheRetention::Long, "test-key"),
            params(&model(None), &turn, CacheRetention::None, "test-key"),
        ],
        [
            one_turn_body(Some(&short)),
            one_turn_body(Some(&long)),
            one_turn_body(Some(&short)),
            one_turn_body(None),
        ]
    );
}

/// OAuth requests lead with the Claude Code identity block; both system
/// blocks carry the marker.
#[test]
fn oauth_marks_both_system_blocks() {
    let turn = json!([{"role": "user", "content": "Say hello.", "timestamp": 1}]);
    let body = params(
        &model(None),
        &turn,
        CacheRetention::Short,
        "sk-ant-oat-dummy",
    );
    let marker = json!({"type": "ephemeral"});
    assert_eq!(
        body["system"],
        json!([
            {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.",
             "cache_control": marker},
            {"type": "text", "text": "You are terse.", "cache_control": marker}
        ])
    );
}

/// The conversation marker lands on the final user turn's last block when
/// it is text, an image, or a tool result; consecutive tool results group
/// into one user turn marked on its last result; a final assistant turn
/// takes no conversation marker (no backwards search). The expected
/// arrays are the TS fork's (bf4d2c6ca) converted messages for the same
/// inputs.
#[test]
fn conversation_marker_lands_on_the_final_user_block() {
    let marker = json!({"type": "ephemeral"});
    let calls = assistant(
        &json!([
            {"type": "toolCall", "id": "call_1", "name": "read", "arguments": {"path": "a"}},
            {"type": "toolCall", "id": "call_2", "name": "read", "arguments": {"path": "b"}}
        ]),
        "toolUse",
    );
    let cases = [
        (
            json!([{"role": "user", "timestamp": 1, "content": [
                {"type": "text", "text": "Look."},
                {"type": "image", "data": "QQ==", "mimeType": "image/png"}
            ]}]),
            json!([{"role": "user", "content": [
                {"type": "text", "text": "Look."},
                {"type": "image", "cache_control": marker,
                 "source": {"type": "base64", "media_type": "image/png", "data": "QQ=="}}
            ]}]),
        ),
        (
            json!([{"role": "user", "timestamp": 1, "content": [
                {"type": "text", "text": "First."},
                {"type": "text", "text": "Second."}
            ]}]),
            json!([{"role": "user", "content": [
                {"type": "text", "text": "First."},
                {"type": "text", "text": "Second.", "cache_control": marker}
            ]}]),
        ),
        (
            json!([
                {"role": "user", "content": "Read a and b.", "timestamp": 1},
                calls,
                tool_result("call_1", "A"),
                tool_result("call_2", "B")
            ]),
            json!([
                {"role": "user", "content": "Read a and b."},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call_1", "name": "read", "input": {"path": "a"}},
                    {"type": "tool_use", "id": "call_2", "name": "read", "input": {"path": "b"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call_1", "content": "A", "is_error": false},
                    {"type": "tool_result", "tool_use_id": "call_2", "content": "B", "is_error": false,
                     "cache_control": marker}
                ]}
            ]),
        ),
        (
            json!([
                {"role": "user", "content": "Hi.", "timestamp": 1},
                assistant(&json!([{"type": "text", "text": "Hello."}]), "stop")
            ]),
            json!([
                {"role": "user", "content": "Hi."},
                {"role": "assistant", "content": [{"type": "text", "text": "Hello."}]}
            ]),
        ),
    ];
    for (messages, expected) in cases {
        let body = params(&model(None), &messages, CacheRetention::Short, "test-key");
        assert_eq!(body["messages"], expected);
    }
}
