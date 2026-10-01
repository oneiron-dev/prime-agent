//! Scripted socket failures and their structured transport surface (TS
//! `transportErrorFromEvent`): close frames, FIN, protocol violations, and
//! the event stream ending without a terminal event, each with its cause,
//! close code, reason, and cleanliness.

use serde_json::{json, Map, Value};
use tokio_tungstenite::tungstenite::error::ProtocolError;
use tokio_tungstenite::tungstenite::Error as WsError;

use super::connection::SocketEnd;
use super::mock_server::{self, Record, SseReply, Turn, Upgrade};
use super::session::OwnedRequest;
use super::{socket_end_error, ResponsesWsError};
use crate::providers::openai_responses::{stream_openai_responses, OpenAIResponsesOptions};
use crate::types::{
    Context, Message, Model, StopReason, StreamOptions, UserMessage, UserMessageContent,
};
use crate::utils_inner::stream_failure::{
    ProviderWsTransportError, StreamTransportFailureCause, StreamTransportFailureDetail,
};

fn ws_model(base_url: &str) -> Model {
    serde_json::from_value(json!({
        "id": "gpt-ws", "name": "gpt-ws", "api": "openai-responses", "provider": "cpa-r",
        "baseUrl": base_url, "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 100_000, "maxTokens": 1000,
        "compat": { "supportsWebSocket": true },
    }))
    .expect("test model")
}

fn hello() -> Context {
    Context {
        system_prompt: None,
        messages: vec![Message::User(UserMessage {
            content: UserMessageContent::Text("hello".to_string()),
            timestamp: 1,
            rest: Map::default(),
        })],
        tools: None,
    }
}

fn created() -> Value {
    json!({ "type": "response.created", "response": { "id": "resp_1" } })
}

fn sse_answer() -> Vec<Value> {
    vec![
        created(),
        json!({ "type": "response.completed", "response": { "id": "resp_1", "status": "completed" } }),
    ]
}

/// One request over a socket that fails the way `turn` scripts; returns
/// the failure's `provider_stream_failure` details (or the
/// `provider_transport_failure` error when the request fell back).
async fn failure_details(turn: Turn) -> (StopReason, Option<String>, Value) {
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![turn])],
        vec![SseReply::Events(sse_answer())],
    )
    .await;
    let options = OpenAIResponsesOptions::from_base(StreamOptions {
        api_key: Some("test-key".to_string()),
        ..StreamOptions::default()
    });
    let message = stream_openai_responses(&ws_model(&server.base_url), &hello(), Some(&options))
        .result()
        .await;
    let fell_back = server
        .drain()
        .iter()
        .any(|record| matches!(record, Record::SseRequest { .. }));
    let kind = if fell_back {
        "provider_transport_failure"
    } else {
        "provider_stream_failure"
    };
    let diagnostic = message
        .diagnostics
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|diagnostic| diagnostic.type_ == kind)
        .map_or(Value::Null, |diagnostic| {
            let value = serde_json::to_value(diagnostic).expect("diagnostic json");
            if fell_back {
                value["error"].clone()
            } else {
                value["details"].clone()
            }
        });
    (message.stop_reason, message.error_message, diagnostic)
}

/// A close frame with a reason after the first event: the composed close
/// text and the full structured detail (clean close).
#[tokio::test]
async fn a_close_frame_with_reason_mid_stream_is_a_clean_closed_failure() {
    let (stop, message, details) = failure_details(Turn::EventsThenClose(
        vec![created()],
        1011,
        "mock server reason",
    ))
    .await;
    assert_eq!(stop, StopReason::Error);
    assert_eq!(
        message.as_deref(),
        Some("WebSocket closed before response.completed 1011 mock server reason")
    );
    assert_eq!(
        details,
        json!({
            "kind": "transport",
            "providerErrorType": "websocket_closed",
            "transport": {
                "protocol": "websocket", "cause": "closed", "closeCode": 1011,
                "closeReason": "mock server reason", "wasClean": true,
            },
        })
    );
}

/// A reasonless close keeps the plain text; the code still rides the
/// detail.
#[tokio::test]
async fn a_reasonless_close_keeps_the_plain_text() {
    let (_, message, details) =
        failure_details(Turn::EventsThenClose(vec![created()], 1001, "")).await;
    assert_eq!(
        message.as_deref(),
        Some("WebSocket closed before response.completed")
    );
    assert_eq!(
        details["transport"],
        json!({ "protocol": "websocket", "cause": "closed", "closeCode": 1001, "wasClean": true })
    );
}

/// A close before any event never surfaces: the request falls back to
/// SSE, and the transport diagnostic records the structured error.
#[tokio::test]
async fn a_close_before_the_first_event_falls_back() {
    let (stop, message, error) =
        failure_details(Turn::EventsThenClose(Vec::new(), 1013, "try again later")).await;
    assert_eq!((stop, message), (StopReason::Stop, None));
    assert_eq!(
        error,
        json!({
            "name": "WebSocketTransportError",
            "message": "WebSocket closed before response.completed 1013 try again later",
        })
    );
}

/// The non-close socket ends map to their causes: protocol violations are
/// the socket's error event, a dead socket is the unclean 1006 close, a
/// frame without JSON is a parse failure (not transport), and a channel
/// that ends without any end marker is `eof`.
#[test]
fn socket_ends_map_to_structured_causes() {
    let owner = OwnedRequest::begin(None, None);
    let transport = |error: ResponsesWsError| match error {
        ResponsesWsError::Transport(transport) => transport,
        other => panic!("expected a transport failure, got {other:?}"),
    };
    let protocol = transport(socket_end_error(
        SocketEnd::Read(WsError::Protocol(ProtocolError::NonZeroReservedBits)),
        &owner,
    ));
    assert_eq!(
        protocol.transport,
        Some(StreamTransportFailureDetail::websocket(
            StreamTransportFailureCause::Error
        ))
    );
    assert_eq!(
        transport(socket_end_error(SocketEnd::SendFailed, &owner)),
        ProviderWsTransportError {
            message: "WebSocket closed before response.completed".to_string(),
            close_code: Some(1006),
            transport: Some(StreamTransportFailureDetail {
                close_code: Some(1006),
                was_clean: Some(false),
                ..StreamTransportFailureDetail::websocket(StreamTransportFailureCause::Closed)
            }),
        }
    );
    assert_eq!(
        transport(socket_end_error(
            SocketEnd::CloseFrame {
                code: None,
                reason: String::new()
            },
            &owner
        ))
        .transport
        .and_then(|detail| detail.close_code),
        Some(1005)
    );
    assert_eq!(
        transport(super::eof_error()),
        ProviderWsTransportError {
            message: "WebSocket stream closed before response.completed".to_string(),
            close_code: None,
            transport: Some(StreamTransportFailureDetail::websocket(
                StreamTransportFailureCause::Eof
            )),
        }
    );
    let ResponsesWsError::Provider(parse) = socket_end_error(
        SocketEnd::InvalidJson {
            error: "expected value at line 1 column 1".to_string(),
            text: "nope".to_string(),
        },
        &owner,
    ) else {
        panic!("a parse failure is not a transport failure");
    };
    assert_eq!(
        parse.to_string(),
        "JSON Parse error: expected value at line 1 column 1"
    );
    assert_eq!(
        socket_end_error(SocketEnd::Cancelled, &owner),
        ResponsesWsError::Aborted
    );
}
