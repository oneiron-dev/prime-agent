//! Responses API WebSocket transport for the generic `openai-responses`
//! provider (port of `packages/ai/src/providers/openai-responses-websocket.ts`
//! from the Oneiron TS fork), plus the socket mechanics and delta
//! continuation the Codex transport shares.
//!
//! One `response.create` frame carries the same Responses body the SSE path
//! posts; the event stream feeds the shared Responses processor, so text,
//! thinking, tools, usage, response id, and stop reasons agree across
//! transports. A session reuses one connection (see [`session`]), and the
//! `auto`/`websocket-cached` transports continue the previous successful
//! response with only the new input items. A dropped response is never a
//! continuation anchor: any failure clears it, so the session retry
//! reconnects and resends the full request.

pub(crate) mod connection;
pub(crate) mod continuation;
mod session;

#[cfg(any(test, feature = "test-support"))]
pub(crate) mod mock_server;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod wire_tests;

use serde_json::{Map, Value};
use tokio_tungstenite::tungstenite::error::ProtocolError;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_util::sync::CancellationToken;

use crate::event_stream::{AssistantMessageEvent, AssistantMessageEventWriter};
use crate::providers::openai_responses_shared::{
    convert_responses_messages, ConvertResponsesMessagesOptions, ResponsesStreamHooks,
    ResponsesStreamProcessor, OPENAI_TOOL_CALL_PROVIDERS,
};
use crate::types::{AssistantMessage, Context, Message, Model};
use crate::utils_inner::diagnostics::DiagnosticErrorInfo;
use crate::utils_inner::stream_failure::{
    diagnostic_error_info, ProviderError, ProviderHttpError, ProviderWsTransportError,
    StreamTransportFailureCause, StreamTransportFailureDetail,
};

use connection::{ConnectFailure, SocketEnd, WorkerEvent};
use continuation::{delta_request_body, ContinuationAnchor};
use session::{Cancellation, OwnedRequest, ReleaseDisposition};

pub(crate) use session::close_sessions;

/// Abnormal closure: the code a socket death without a close frame
/// reports (WHATWG `CloseEvent` 1006).
const CLOSE_CODE_ABNORMAL: u16 = 1006;
/// The code a close frame without a status reports (WHATWG 1005).
const CLOSE_CODE_NO_STATUS: u16 = 1005;
/// Normal closure: the code this side's own close sends.
const CLOSE_CODE_NORMAL: u16 = 1000;
/// The runtime's connect-failure text (undici's handshake failure reason,
/// which the TS collector adopts as the error event's message).
const CONNECT_FAILURE_MESSAGE: &str = "Received network error or non-101 status code.";
/// The disposal cancellation's message (TS `createSessionDisposedError`).
pub(crate) const SESSION_DISPOSED_MESSAGE: &str = "OpenAI Responses WebSocket session was disposed";

/// Port of `resolveOpenAIResponsesWebSocketUrl`: trim (empty means the
/// `OpenAI` default), drop trailing slashes, append `/responses` unless the
/// path already ends there, and switch `http:` to `ws:` (anything else to
/// `wss:`), keeping the query.
///
/// # Errors
///
/// Returns the URL parser's message when the base URL is not a URL.
pub(crate) fn resolve_responses_websocket_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim();
    let base = if trimmed.is_empty() {
        "https://api.openai.com/v1"
    } else {
        trimmed
    };
    let mut url = url::Url::parse(base.trim_end_matches('/')).map_err(|error| error.to_string())?;
    if !url.path().ends_with("/responses") {
        let path = format!("{}/responses", url.path().trim_end_matches('/'));
        url.set_path(&path);
    }
    let scheme = if url.scheme() == "http" { "ws" } else { "wss" };
    // `set_scheme` refuses special-to-special moves only when the result
    // would be invalid; ws/wss are special schemes like http/https.
    url.set_scheme(scheme)
        .map_err(|()| format!("Cannot use {scheme} for {base}"))?;
    Ok(url.to_string())
}

/// Whether a request may continue the connection's previous response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContinuationMode {
    /// Always send the full request (`websocket`).
    Full,
    /// Send only the new input after a successful response (`auto`,
    /// `websocket-cached`).
    Cached,
}

/// One generation request over the WebSocket transport.
pub(crate) struct GenerationRequest<'a> {
    pub(crate) model: &'a Model,
    pub(crate) url: &'a str,
    pub(crate) headers: &'a [(String, String)],
    /// The full Responses body (after the payload hook).
    pub(crate) body: &'a Value,
    pub(crate) session_id: Option<&'a str>,
    pub(crate) continuation: ContinuationMode,
    pub(crate) signal: Option<&'a CancellationToken>,
    pub(crate) hooks: ResponsesStreamHooks,
    /// Fired once the socket is ready for this request (TS `onOpen`: the
    /// synthetic 101 response hook).
    pub(crate) on_open: &'a (dyn Fn() + Send + Sync),
}

/// How a WebSocket generation failed.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ResponsesWsError {
    /// The socket failed before a provider verdict (structured transport
    /// failure).
    Transport(ProviderWsTransportError),
    /// A provider verdict or stream-processing failure.
    Provider(ProviderError),
    /// The caller aborted.
    Aborted,
    /// The owning session was disposed.
    SessionDisposed,
}

impl ResponsesWsError {
    fn from_cancellation(cancellation: Cancellation) -> Self {
        match cancellation {
            Cancellation::Aborted => Self::Aborted,
            Cancellation::SessionDisposed => Self::SessionDisposed,
        }
    }

    /// The `provider_transport_failure` diagnostic's error (TS
    /// `extractDiagnosticError` of the thrown value).
    pub(crate) fn diagnostic_error(&self) -> DiagnosticErrorInfo {
        match self {
            Self::Transport(transport) => {
                diagnostic_error_info(&ProviderError::Transport(transport.clone()))
            }
            Self::Provider(error) => diagnostic_error_info(error),
            Self::Aborted => diagnostic_error_info(&ProviderError::Aborted),
            Self::SessionDisposed => DiagnosticErrorInfo {
                name: Some("AbortError".to_string()),
                message: SESSION_DISPOSED_MESSAGE.to_string(),
                stack: None,
                code: Some(crate::types::DiagnosticCode::Str(
                    "session_disposed".to_string(),
                )),
                rest: Map::default(),
            },
        }
    }
}

fn transport_error(
    message: impl Into<String>,
    detail: StreamTransportFailureDetail,
) -> ResponsesWsError {
    ResponsesWsError::Transport(ProviderWsTransportError {
        message: message.into(),
        close_code: detail.close_code,
        transport: Some(detail),
    })
}

/// A failure before the socket opened (TS `connect`'s error/close events
/// with cause `connect`). A request already cancelled (its session
/// disposed, or the caller aborted) reports the cancellation: a disposed
/// session's request must never read as a transport failure the caller
/// replays over SSE.
fn connect_error(failure: ConnectFailure, owner: &OwnedRequest) -> ResponsesWsError {
    if let Some(cancellation) = owner.cancellation() {
        return ResponsesWsError::from_cancellation(cancellation);
    }
    let message = match failure {
        ConnectFailure::Cancelled => {
            return ResponsesWsError::from_cancellation(
                owner.cancellation().unwrap_or(Cancellation::Aborted),
            )
        }
        ConnectFailure::Request(message) => message,
        ConnectFailure::Handshake(WsError::Protocol(
            ProtocolError::SecWebSocketAcceptKeyMismatch,
        )) => "Incorrect hash received in Sec-WebSocket-Accept header.".to_string(),
        ConnectFailure::Handshake(_) => CONNECT_FAILURE_MESSAGE.to_string(),
    };
    transport_error(
        message,
        StreamTransportFailureDetail::websocket(StreamTransportFailureCause::Connect),
    )
}

/// The close-event failure before the terminal event (TS `onClose` in the
/// collector): the fallback text, extended with the close code and reason
/// when the peer gave a reason.
fn closed_error(code: u16, reason: &str, was_clean: bool) -> ResponsesWsError {
    const FALLBACK: &str = "WebSocket closed before response.completed";
    let message = if reason.is_empty() {
        FALLBACK.to_string()
    } else {
        format!("{FALLBACK} {code} {reason}")
    };
    transport_error(
        message,
        StreamTransportFailureDetail {
            close_code: Some(code),
            close_reason: (!reason.is_empty()).then(|| reason.to_string()),
            was_clean: Some(was_clean),
            ..StreamTransportFailureDetail::websocket(StreamTransportFailureCause::Closed)
        },
    )
}

/// The event stream ended without a terminal event or a close (TS
/// `cause: "eof"`).
fn eof_error() -> ResponsesWsError {
    transport_error(
        "WebSocket stream closed before response.completed",
        StreamTransportFailureDetail::websocket(StreamTransportFailureCause::Eof),
    )
}

/// Map how the socket ended one request (anything but completion). A
/// cancellation that landed before the request mapped its end wins over the
/// end (TS `onAbort` replaces a failure the collector has not thrown yet):
/// a remote close the worker queued just before a disposal still reads as
/// the disposal, never as a transport failure to replay.
fn socket_end_error(end: SocketEnd, owner: &OwnedRequest) -> ResponsesWsError {
    if let Some(cancellation) = owner.cancellation() {
        return ResponsesWsError::from_cancellation(cancellation);
    }
    match end {
        SocketEnd::Completed => eof_error(),
        SocketEnd::Cancelled | SocketEnd::ConsumerGone => ResponsesWsError::from_cancellation(
            owner.cancellation().unwrap_or(Cancellation::Aborted),
        ),
        SocketEnd::CloseFrame { code, reason } => {
            closed_error(code.unwrap_or(CLOSE_CODE_NO_STATUS), &reason, true)
        }
        // This side closed the socket under the request (TS `close(socket,
        // reason)` reaches the collector as a clean 1000 close): a
        // disposal or abort stays a cancellation, a replacement is the
        // close.
        SocketEnd::LocalClose(reason) => match owner.cancellation() {
            Some(cancellation) => ResponsesWsError::from_cancellation(cancellation),
            None => closed_error(CLOSE_CODE_NORMAL, reason.as_str(), true),
        },
        // A socket death without a close frame is the runtime's 1006 close
        // event (not clean); a dead socket swallows the request frame the
        // same way.
        SocketEnd::Eof
        | SocketEnd::SendFailed
        | SocketEnd::Read(
            WsError::Io(_)
            | WsError::ConnectionClosed
            | WsError::AlreadyClosed
            | WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake),
        ) => closed_error(CLOSE_CODE_ABNORMAL, "", false),
        // Frame-protocol violations surface as the socket's error event.
        SocketEnd::Read(error) => transport_error(
            error.to_string(),
            StreamTransportFailureDetail::websocket(StreamTransportFailureCause::Error),
        ),
        // A frame that is not JSON is a parse failure, not a transport
        // failure (TS `JSON.parse` throws a `SyntaxError`).
        SocketEnd::InvalidJson { error, .. } => {
            ResponsesWsError::Provider(ProviderError::Http(ProviderHttpError {
                message: format!("JSON Parse error: {error}"),
                status: None,
                body: None,
                headers: std::collections::HashMap::new(),
                request_id: None,
                sdk_name: Some("SyntaxError".to_string()),
                retry_after_ms: None,
                provider_error_type: None,
            }))
        }
    }
}

/// The `response.create` frame: the request fields after the event type.
fn response_create_frame(body: &Value) -> String {
    let mut frame = Map::new();
    frame.insert("type".into(), Value::String("response.create".into()));
    if let Some(fields) = body.as_object() {
        for (key, value) in fields {
            if key != "type" {
                frame.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(frame).to_string()
}

/// The response's own items as the next request replays them (TS
/// `convertResponsesMessages` of the output, `function_call_output`
/// excluded).
fn response_items(model: &Model, output: &AssistantMessage) -> Vec<Value> {
    convert_responses_messages(
        model,
        &Context {
            messages: vec![Message::Assistant(output.clone())],
            tools: None,
            system_prompt: None,
        },
        &OPENAI_TOOL_CALL_PROVIDERS,
        ConvertResponsesMessagesOptions {
            include_system_prompt: false,
        },
    )
    .into_iter()
    .filter(|item| item.get("type").and_then(Value::as_str) != Some("function_call_output"))
    .collect()
}

/// Port of `processOpenAIResponsesWebSocket`: acquire the session's
/// connection, send the (possibly delta) request, and feed its events
/// through the shared Responses processor. `started` turns true at the
/// first event of any kind (`response.created` included), when the
/// `start` event is pushed; the caller's SSE fallback is allowed only
/// before that.
///
/// # Errors
///
/// Returns the transport failure, the provider verdict, or the
/// cancellation that ended the request.
pub(crate) async fn process_generation(
    request: GenerationRequest<'_>,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
    started: &mut bool,
) -> Result<(), ResponsesWsError> {
    let GenerationRequest {
        model,
        url,
        headers,
        body,
        session_id,
        continuation,
        signal,
        hooks,
        on_open,
    } = request;
    let owner = OwnedRequest::begin(session_id, signal);
    let acquired = session::acquire(url, headers, session_id, owner.token())
        .await
        .map_err(|failure| connect_error(failure, &owner))?;
    // Disposal can now reach this socket even when it never entered the
    // session cache.
    owner.attach(&acquired.worker);
    let delta = match (continuation, &acquired.continuation) {
        (ContinuationMode::Cached, Some(anchor)) => {
            let delta = delta_request_body(body, anchor);
            if delta.is_none() {
                // The request no longer continues the anchor (model,
                // body, or history change): it is gone for good.
                session::set_continuation(&acquired, None);
            }
            delta
        }
        (ContinuationMode::Cached | ContinuationMode::Full, _) => None,
    };
    on_open();
    let result = if let Some(cancellation) = owner.cancellation() {
        Err(ResponsesWsError::from_cancellation(cancellation))
    } else {
        let frame = response_create_frame(delta.as_ref().unwrap_or(body));
        let target = StreamTarget {
            model,
            hooks,
            output: &mut *output,
            writer,
        };
        stream_events(&acquired, &owner, frame, target, started).await
    };
    match result {
        Ok(()) => {
            if let Some(cancellation) = owner.cancellation() {
                session::set_continuation(&acquired, None);
                session::release(&acquired, ReleaseDisposition::Discard);
                return Err(ResponsesWsError::from_cancellation(cancellation));
            }
            // Only a response with an id anchors the next request; without
            // one the previous anchor stays (TS keeps it too): a later
            // request still starts with that anchor's baseline, so its
            // delta carries this response's items as input.
            if let (ContinuationMode::Cached, true, Some(response_id)) = (
                continuation,
                session::is_cached(&acquired),
                output.response_id.clone(),
            ) {
                session::set_continuation(
                    &acquired,
                    Some(ContinuationAnchor {
                        body: body.clone(),
                        response_id,
                        response_items: response_items(model, output),
                    }),
                );
            }
            session::release(&acquired, ReleaseDisposition::Keep);
            Ok(())
        }
        Err(error) => {
            // A failed response is never an anchor.
            session::set_continuation(&acquired, None);
            session::release(&acquired, ReleaseDisposition::Discard);
            Err(error)
        }
    }
}

/// Where one request's events land: the shared processor's inputs.
struct StreamTarget<'a, 'w> {
    model: &'a Model,
    hooks: ResponsesStreamHooks,
    output: &'w mut AssistantMessage,
    writer: &'w AssistantMessageEventWriter,
}

/// Send the frame and process the request's events until its end.
async fn stream_events(
    acquired: &session::Acquired,
    owner: &OwnedRequest,
    frame: String,
    target: StreamTarget<'_, '_>,
    started: &mut bool,
) -> Result<(), ResponsesWsError> {
    let Some(mut events) = acquired
        .worker
        .send(frame, Some(owner.token().clone()))
        .await
    else {
        return Err(socket_end_error(SocketEnd::SendFailed, owner));
    };
    let StreamTarget {
        model,
        hooks,
        output,
        writer,
    } = target;
    let start_partial = output.clone();
    let mut processor = ResponsesStreamProcessor::new(model, output, writer, hooks);
    let streamed: Result<(), ResponsesWsError> = async {
        loop {
            match events.recv().await {
                Some(WorkerEvent::Event(event)) => {
                    if !*started {
                        *started = true;
                        writer.push(AssistantMessageEvent::Start {
                            partial: start_partial.clone(),
                        });
                    }
                    processor
                        .handle_event(&event)
                        .map_err(ResponsesWsError::Provider)?;
                }
                Some(WorkerEvent::End(SocketEnd::Completed)) => break,
                Some(WorkerEvent::End(end)) => return Err(socket_end_error(end, owner)),
                None => {
                    return Err(owner
                        .cancellation()
                        .map_or_else(eof_error, ResponsesWsError::from_cancellation))
                }
            }
        }
        processor.finish().map_err(ResponsesWsError::Provider)
    }
    .await;
    if streamed.is_err() {
        processor.settle_partial_tool_calls();
    }
    streamed
}
