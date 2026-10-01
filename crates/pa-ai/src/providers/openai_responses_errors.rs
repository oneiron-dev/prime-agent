//! Responses `error` event parsing shared by the SSE and WebSocket paths
//! (port of `parseResponsesErrorFrame` / `redactErrorText` in
//! `packages/ai/src/providers/openai-responses-shared.ts`).
//!
//! `OpenAI` sends a flat frame (`{"type":"error","code","message"}`); the CPA
//! gateway nests its verdict (`{"type":"error","status":503,"error":{"type",
//! "code","message"}}`). Both classify through the shared stream-failure
//! vocabulary, keeping the provider type, the separate provider code, and
//! the HTTP status. Credentials are redacted before the message is shown
//! or the bounded `raw` diagnostic is stored.

use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::utils_inner::stream_failure::{
    classify_stream_failure, stream_failure_message, StreamFailureError, StreamFailureInfo,
};

/// Bound on the user-facing message (TS `redactErrorText` default).
const MESSAGE_MAX_CHARS: usize = 500;
/// Bound on the message kept inside the `raw` diagnostic.
const RAW_MESSAGE_MAX_CHARS: usize = 1000;

/// One parsed Responses error frame (TS `ResponsesErrorFrame`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResponsesErrorFrame {
    status: Option<u16>,
    provider_error_type: Option<String>,
    provider_error_code: Option<String>,
    message: Option<String>,
    raw: String,
}

/// A non-empty string field (TS `getString`).
fn non_empty_str<'a>(object: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    object?
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// Port of `redactErrorText`: bearer tokens and credential-shaped
/// assignments are replaced before the text is bounded to `max_chars`
/// characters (an ellipsis marks the cut).
fn redact_error_text(value: &str, max_chars: usize) -> String {
    static BEARER: OnceLock<regex::Regex> = OnceLock::new();
    static ASSIGNMENT: OnceLock<regex::Regex> = OnceLock::new();
    let bearer = BEARER
        .get_or_init(|| regex::Regex::new(r"(?i)\bBearer\s+[^\s,;)}\]]+").expect("static regex"));
    let assignment = ASSIGNMENT.get_or_init(|| {
        regex::Regex::new(
            r"(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*([:=])\s*[^\s,;)}\]]+",
        )
        .expect("static regex")
    });
    let redacted = bearer.replace_all(value, "Bearer [REDACTED]");
    let redacted = assignment.replace_all(&redacted, "$1$2[REDACTED]");
    if redacted.chars().count() > max_chars {
        let mut bounded: String = redacted.chars().take(max_chars).collect();
        bounded.push_str("...");
        bounded
    } else {
        redacted.into_owned()
    }
}

/// Port of `parseResponsesErrorFrame`: accepts both the flat `OpenAI` frame
/// and the CPA nested envelope.
fn parse_responses_error_frame(event: &Value) -> ResponsesErrorFrame {
    let frame = event.as_object();
    let nested = frame
        .and_then(|frame| frame.get("error"))
        .and_then(Value::as_object);
    let provider_error_type = non_empty_str(nested, "type").map(str::to_string);
    let provider_error_code = non_empty_str(nested, "code")
        .or_else(|| non_empty_str(frame, "code"))
        .map(str::to_string);
    let message = non_empty_str(nested, "message").or_else(|| non_empty_str(frame, "message"));
    let status = frame
        .and_then(|frame| frame.get("status"))
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok());
    // The bounded diagnostic keeps only the classified fields, in the TS
    // key order (`JSON.stringify` of the safe object).
    let mut safe_raw = Map::new();
    safe_raw.insert("type".into(), Value::String("error".into()));
    if let Some(status) = status {
        safe_raw.insert("status".into(), Value::from(status));
    }
    if let Some(provider_error_type) = &provider_error_type {
        safe_raw.insert(
            "providerErrorType".into(),
            Value::String(provider_error_type.clone()),
        );
    }
    if let Some(provider_error_code) = &provider_error_code {
        safe_raw.insert(
            "providerErrorCode".into(),
            Value::String(provider_error_code.clone()),
        );
    }
    if let Some(message) = message {
        safe_raw.insert(
            "message".into(),
            Value::String(redact_error_text(message, RAW_MESSAGE_MAX_CHARS)),
        );
    }
    ResponsesErrorFrame {
        status,
        provider_error_type: provider_error_type.or_else(|| provider_error_code.clone()),
        provider_error_code,
        message: message.map(|message| redact_error_text(message, MESSAGE_MAX_CHARS)),
        raw: Value::Object(safe_raw).to_string(),
    }
}

/// The classified failure a Responses `error` event raises (the TS
/// `processResponsesStream` error arm): provider type, separate code, and
/// status classify the kind; the redacted message is the detail.
pub(crate) fn responses_error_event_failure(event: &Value) -> StreamFailureError {
    let frame = parse_responses_error_frame(event);
    let info = StreamFailureInfo {
        kind: classify_stream_failure(frame.provider_error_type.as_deref(), frame.status),
        provider_error_type: frame.provider_error_type,
        provider_error_code: frame.provider_error_code,
        status: frame.status,
        raw: Some(frame.raw),
        ..StreamFailureInfo::unknown()
    };
    let message = stream_failure_message(
        &info,
        Some(
            frame
                .message
                .as_deref()
                .unwrap_or("provider sent an error event without a message"),
        ),
    );
    StreamFailureError { message, info }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils_inner::stream_failure::StreamFailureKind;
    use serde_json::json;

    /// The flat `OpenAI` frame: the code is both the provider type and code.
    /// The bounded `raw` keeps only what the frame itself nested (TS
    /// `safeRaw` takes the nested type before the code fallback), so a
    /// flat frame's `raw` carries the code alone.
    #[test]
    fn flat_frames_classify_by_their_code() {
        let failure = responses_error_event_failure(&json!({
            "type": "error",
            "code": "rate_limit_exceeded",
            "message": "Slow down"
        }));
        assert_eq!(
            failure,
            StreamFailureError {
                message: "Provider rate limit exceeded (rate_limit_exceeded): Slow down"
                    .to_string(),
                info: StreamFailureInfo {
                    kind: StreamFailureKind::RateLimit,
                    provider_error_type: Some("rate_limit_exceeded".to_string()),
                    provider_error_code: Some("rate_limit_exceeded".to_string()),
                    raw: Some(
                        r#"{"type":"error","providerErrorCode":"rate_limit_exceeded","message":"Slow down"}"#
                            .to_string()
                    ),
                    ..StreamFailureInfo::unknown()
                },
            }
        );
    }

    /// CPA's nested envelope keeps the provider type, the separate code,
    /// and the status, and the 503 verdict classifies as a server error
    /// (transient), never as a socket failure.
    #[test]
    fn nested_cpa_envelopes_keep_type_code_and_status() {
        let failure = responses_error_event_failure(&json!({
            "type": "error",
            "status": 503,
            "error": {
                "type": "server_error",
                "code": "upstream_unavailable",
                "message": "auth_unavailable: no healthy credential"
            }
        }));
        assert_eq!(
            failure,
            StreamFailureError {
                message: "Provider server error (server_error, upstream_unavailable, 503): auth_unavailable: no healthy credential".to_string(),
                info: StreamFailureInfo {
                    kind: StreamFailureKind::ServerError,
                    provider_error_type: Some("server_error".to_string()),
                    provider_error_code: Some("upstream_unavailable".to_string()),
                    status: Some(503),
                    raw: Some(
                        r#"{"type":"error","status":503,"providerErrorType":"server_error","providerErrorCode":"upstream_unavailable","message":"auth_unavailable: no healthy credential"}"#
                            .to_string()
                    ),
                    ..StreamFailureInfo::unknown()
                },
            }
        );
    }

    /// Bearer tokens and credential assignments never reach the message or
    /// the stored diagnostic.
    #[test]
    fn credentials_are_redacted_from_message_and_raw() {
        let failure = responses_error_event_failure(&json!({
            "type": "error",
            "status": 401,
            "error": {
                "type": "authentication_error",
                "message": "bad header Authorization: Bearer sk-live-123 (api_key=sk-abc; password: hunter2)"
            }
        }));
        let expected_detail =
            "bad header Authorization: Bearer [REDACTED] (api_key=[REDACTED]; password:[REDACTED])";
        assert_eq!(
            failure.message,
            format!(
                "Provider authentication failed (authentication_error, 401): {expected_detail}"
            )
        );
        let raw = failure.info.raw.unwrap();
        assert!(!raw.contains("sk-live-123"), "{raw}");
        assert!(!raw.contains("sk-abc"), "{raw}");
        assert!(!raw.contains("hunter2"), "{raw}");
        assert!(raw.contains(expected_detail), "{raw}");
    }

    /// An error frame without a message still classifies with the fixed
    /// detail, and long messages are bounded.
    #[test]
    fn missing_and_long_messages_are_bounded() {
        let empty = responses_error_event_failure(&json!({ "type": "error" }));
        assert_eq!(
            empty.message,
            "Provider stream failed: provider sent an error event without a message"
        );
        assert_eq!(empty.info.raw.as_deref(), Some(r#"{"type":"error"}"#));
        let long = "x".repeat(600);
        let bounded = redact_error_text(&long, MESSAGE_MAX_CHARS);
        assert_eq!(bounded, format!("{}...", "x".repeat(500)));
    }
}
