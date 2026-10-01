//! Provider response-model provenance for the shared Responses processor:
//! only the terminal response identity counts, never `response.created`.

use serde_json::{json, Map, Value};

use super::{ResponsesStreamHooks, ResponsesStreamProcessor};
use crate::event_stream::AssistantMessageEventStream;
use crate::types::{AssistantMessage, Model, ResponseModelSource, StopReason, Usage};

const REQUESTED_MODEL: &str = "gpt-6-astra";

fn requested_model() -> Model {
    serde_json::from_value(json!({
        "id": REQUESTED_MODEL, "name": "Fixture", "api": "openai-responses",
        "provider": "cpa-r", "baseUrl": "https://fixture.invalid", "reasoning": true,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 1000, "maxTokens": 1000
    }))
    .unwrap()
}

/// The message a turn without any recorded provider fields starts from.
fn reply() -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: "openai-responses".into(),
        provider: "cpa-r".into(),
        model: REQUESTED_MODEL.into(),
        response_model: None,
        response_model_source: None,
        response_id: None,
        diagnostics: None,
        usage: Usage::default(),
        stop_reason: StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
        rest: Map::default(),
    }
}

fn replay(events: &[Value]) -> AssistantMessage {
    let model = requested_model();
    let mut output = reply();
    let (writer, _stream) = AssistantMessageEventStream::new();
    let mut processor = ResponsesStreamProcessor::new(
        &model,
        &mut output,
        &writer,
        ResponsesStreamHooks::default(),
    );
    for event in events {
        processor.handle_event(event).expect("stream event");
    }
    processor.finish().expect("stream finish");
    output
}

/// TS `provider-response-model.test.ts`: the terminal model is recorded
/// beside the untouched requested selector; the alias a gateway synthesized
/// in `response.created` is not evidence.
#[test]
fn terminal_model_is_recorded_and_the_created_alias_is_ignored() {
    let output = replay(&[
        json!({"type": "response.created", "response": {"id": "resp_wire", "model": "requested-alias"}}),
        json!({
            "type": "response.completed",
            "response": {"id": "resp_wire", "model": "gpt-6-astra-2026-09", "status": "completed"},
        }),
    ]);
    assert_eq!(
        output,
        AssistantMessage {
            response_model: Some("gpt-6-astra-2026-09".into()),
            response_model_source: Some(ResponseModelSource::ProviderResponse),
            response_id: Some("resp_wire".into()),
            ..reply()
        }
    );
}

/// A terminal event without a model leaves the identity unknown even when
/// `response.created` named one.
#[test]
fn created_only_model_stays_unknown() {
    let output = replay(&[
        json!({"type": "response.created", "response": {"id": "resp_wire", "model": REQUESTED_MODEL}}),
        json!({"type": "response.completed", "response": {"id": "resp_wire", "status": "completed"}}),
    ]);
    assert_eq!(
        output,
        AssistantMessage {
            response_id: Some("resp_wire".into()),
            ..reply()
        }
    );
}

/// Blank or non-string terminal models are not recorded.
#[test]
fn blank_terminal_model_is_ignored() {
    for model in [json!(""), json!("   "), json!(null), json!(42)] {
        let output = replay(&[json!({
            "type": "response.completed",
            "response": {"id": "resp_wire", "model": model, "status": "completed"},
        })]);
        assert_eq!(
            output,
            AssistantMessage {
                response_id: Some("resp_wire".into()),
                ..reply()
            },
            "terminal model {model}"
        );
    }
}

/// `response.incomplete` records the observed identity but always ends for
/// length (TS maps the event type, not the status, so an incomplete event
/// without a status is still unsuccessful output).
#[test]
fn incomplete_terminal_records_model_and_stops_for_length() {
    for status in [json!("incomplete"), Value::Null] {
        let mut response = json!({"id": "resp_wire", "model": "gpt-6-astra-2026-09"});
        if !status.is_null() {
            response["status"] = status.clone();
        }
        let output = replay(&[json!({"type": "response.incomplete", "response": response})]);
        assert_eq!(
            output,
            AssistantMessage {
                response_model: Some("gpt-6-astra-2026-09".into()),
                response_model_source: Some(ResponseModelSource::ProviderResponse),
                response_id: Some("resp_wire".into()),
                stop_reason: StopReason::Length,
                ..reply()
            },
            "incomplete status {status}"
        );
    }
}

/// Finished items arrive with their `output_index` (as OpenAI sends every
/// item event): the reasoning item, the text signature, and the finished
/// tool call land on the message. The slot used to be dropped before its
/// lookup, so all three were lost (the next request replayed `msg_N` ids,
/// no reasoning, and the Responses WebSocket delta never matched).
#[test]
fn finished_items_with_an_output_index_land_on_the_message() {
    let reasoning = json!({
        "type": "reasoning", "id": "rs_1", "summary": [{ "type": "summary_text", "text": "think" }],
        "encrypted_content": "opaque",
    });
    let arguments = json!({ "code": "1 + 1" }).to_string();
    let output = replay(&[
        json!({"type": "response.created", "response": {"id": "resp_wire"}}),
        json!({"type": "response.output_item.added", "output_index": 0,
               "item": {"type": "reasoning", "id": "rs_1", "summary": []}}),
        json!({"type": "response.output_item.done", "output_index": 0, "item": reasoning}),
        json!({"type": "response.output_item.added", "output_index": 1,
               "item": {"type": "message", "id": "msg_wire", "role": "assistant", "content": []}}),
        json!({"type": "response.content_part.added", "output_index": 1, "content_index": 0,
               "part": {"type": "output_text", "text": ""}}),
        json!({"type": "response.output_text.delta", "output_index": 1, "content_index": 0,
               "delta": "hi"}),
        json!({"type": "response.output_item.done", "output_index": 1,
               "item": {"type": "message", "id": "msg_wire", "role": "assistant",
                        "content": [{"type": "output_text", "text": "hi"}]}}),
        json!({"type": "response.output_item.added", "output_index": 2,
               "item": {"type": "function_call", "id": "fc_wire", "call_id": "call_1",
                        "name": "ipython", "arguments": ""}}),
        json!({"type": "response.function_call_arguments.delta", "output_index": 2,
               "delta": arguments}),
        json!({"type": "response.output_item.done", "output_index": 2,
               "item": {"type": "function_call", "id": "fc_wire", "call_id": "call_1",
                        "name": "ipython", "arguments": arguments}}),
        json!({"type": "response.completed", "response": {"id": "resp_wire", "status": "completed"}}),
    ]);
    assert_eq!(
        serde_json::to_value(&output.content).unwrap(),
        json!([
            {"type": "thinking", "thinking": "think", "thinkingSignature": reasoning.to_string()},
            {"type": "text", "text": "hi", "textSignature": r#"{"v":1,"id":"msg_wire"}"#},
            {"type": "toolCall", "id": "call_1|fc_wire", "name": "ipython", "arguments": {"code": "1 + 1"}},
        ])
    );
}
