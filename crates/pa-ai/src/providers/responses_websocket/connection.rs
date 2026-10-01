//! Shared Responses WebSocket socket mechanics: the authenticated HTTP
//! upgrade with caller-supplied headers, one worker task per connection,
//! per-request event channels, text/binary frame decoding, and the
//! terminal-event dialect. Both the generic `openai-responses` transport
//! and the Codex transport run their sockets through this module; request
//! construction, session policy, and the user-facing error surface stay
//! with each provider (they map [`SocketEnd`] / [`ConnectFailure`]).
//!
//! The worker owns the socket for the connection's whole life. Each
//! request carries its own cancellation token, so a reusable connection is
//! never bound to the first request's token; between requests the worker
//! keeps watching the socket, so a peer close while idle retires the
//! connection (callers see it through [`WorkerHandle::is_open`]). Every
//! socket wait — the request write included, which a peer that stops
//! reading can block — races the request's token and the connection's
//! close signal, so neither a disposal nor a local close waits on the peer.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::stream::SplitStream;
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How long a polite close (the close frame) may wait on the peer before
/// the socket is simply dropped.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// Why this side closed a connection (TS `close(socket, reason)`): the
/// close frame's reason, and the text a request it interrupts reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloseReason {
    /// The request finished with the connection (an ephemeral socket, a
    /// failed or discarded request).
    Done,
    /// The owning session was disposed.
    SessionCleanup,
    /// The idle connection expired.
    IdleTimeout,
    /// A route, credential, or handshake-header change replaced it.
    IdentityChanged,
    /// A newer same-identity connection took the session's slot.
    Replaced,
}

impl CloseReason {
    /// The close frame's reason text (the TS wire reasons).
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            CloseReason::Done => "done",
            CloseReason::SessionCleanup => "session_cleanup",
            CloseReason::IdleTimeout => "idle_timeout",
            CloseReason::IdentityChanged => "connection_identity_changed",
            CloseReason::Replaced => "connection_replaced",
        }
    }
}

/// Which event family ends one request on the socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EventDialect {
    /// Generic Responses (TS `openai-responses-websocket.ts`): completed,
    /// failed, incomplete, and the `error` frame are terminal.
    Responses,
    /// Codex (TS `parseWebSocket`): completed, done, and incomplete are
    /// terminal; error frames are mapped (and end the request) by the
    /// Codex event consumer.
    Codex,
}

impl EventDialect {
    fn is_terminal(self, event: &Value) -> bool {
        let event_type = event.get("type").and_then(Value::as_str);
        match self {
            EventDialect::Responses => matches!(
                event_type,
                Some("response.completed" | "response.failed" | "response.incomplete" | "error")
            ),
            EventDialect::Codex => matches!(
                event_type,
                Some("response.completed" | "response.done" | "response.incomplete")
            ),
        }
    }
}

/// How one request's read loop ended, before any provider maps it to its
/// own error surface.
#[derive(Debug)]
pub(crate) enum SocketEnd {
    /// The dialect's terminal event arrived (it was forwarded first).
    Completed,
    /// The request's cancellation token fired.
    Cancelled,
    /// The peer sent a close frame; `code` is absent when the frame
    /// carried no status.
    CloseFrame { code: Option<u16>, reason: String },
    /// The connection ended without a close frame.
    Eof,
    /// A socket or frame-protocol failure while reading.
    Read(WsError),
    /// A data frame that did not parse as JSON.
    InvalidJson { error: String, text: String },
    /// The request's event consumer went away mid-request.
    ConsumerGone,
    /// The request frame could not be written (the socket is dead).
    SendFailed,
    /// This side closed the connection while the request was in flight.
    LocalClose(CloseReason),
}

/// A failure before the socket opened.
#[derive(Debug)]
pub(crate) enum ConnectFailure {
    /// The cancellation token fired before or during the handshake.
    Cancelled,
    /// The URL or a handshake header could not form a request; the text is
    /// the runtime-style tail (`Invalid WebSocket header <name>`, ...).
    Request(String),
    /// The handshake itself failed (refused, TLS, non-101, bad accept).
    Handshake(WsError),
}

/// One message a worker delivers to the request it is serving.
#[derive(Debug)]
pub(crate) enum WorkerEvent {
    /// A parsed stream event.
    Event(Value),
    /// The request ended; nothing follows on this channel.
    End(SocketEnd),
}

struct SendRequest {
    body: String,
    events: mpsc::Sender<WorkerEvent>,
    cancel: Option<CancellationToken>,
}

/// The connection's close signal: the first close wins its reason.
#[derive(Default)]
struct Closing {
    token: CancellationToken,
    reason: OnceLock<CloseReason>,
}

impl Closing {
    fn reason(&self) -> CloseReason {
        self.reason.get().copied().unwrap_or(CloseReason::Done)
    }
}

/// Command handle to one connection's worker task.
#[derive(Clone)]
pub(crate) struct WorkerHandle {
    commands: mpsc::Sender<SendRequest>,
    closing: Arc<Closing>,
    connection_id: u64,
}

impl std::fmt::Debug for WorkerHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerHandle")
            .field("connection_id", &self.connection_id)
            .finish_non_exhaustive()
    }
}

impl WorkerHandle {
    /// Unique id of this connection (monotonic, process-wide).
    pub(crate) fn connection_id(&self) -> u64 {
        self.connection_id
    }

    /// Whether the worker still holds an open socket (TS `readyState ===
    /// 1`): a worker exits once its socket closes or fails.
    pub(crate) fn is_open(&self) -> bool {
        !self.commands.is_closed() && !self.closing.token.is_cancelled()
    }

    /// Send one request frame; the worker answers on the returned channel
    /// with the request's events and exactly one [`WorkerEvent::End`]
    /// (`None` when the worker was already gone: the socket is dead).
    pub(crate) async fn send(
        &self,
        body: String,
        cancel: Option<CancellationToken>,
    ) -> Option<mpsc::Receiver<WorkerEvent>> {
        let (events, receiver) = mpsc::channel(64);
        self.commands
            .send(SendRequest {
                body,
                events,
                cancel,
            })
            .await
            .ok()?;
        Some(receiver)
    }

    /// Close the connection now (TS `close(socket, reason)`): an idle
    /// worker sends the close frame and exits; a busy one interrupts its
    /// request, which ends with [`SocketEnd::LocalClose`]. Never blocks.
    pub(crate) fn close(&self, reason: CloseReason) {
        let _ = self.closing.reason.set(reason);
        self.closing.token.cancel();
    }
}

/// Resolves when `cancel` fires; never without one.
async fn cancelled(cancel: Option<&CancellationToken>) {
    match cancel {
        Some(cancel) => cancel.cancelled().await,
        None => std::future::pending().await,
    }
}

/// Send the close frame (TS `socket.close(1000, reason)`: normal closure
/// with the reason on the wire), giving a peer that stopped reading a
/// bounded grace before the socket is dropped.
async fn close_politely(
    sink: &mut futures::stream::SplitSink<WsStream, Message>,
    reason: CloseReason,
) {
    let frame = CloseFrame {
        code: CloseCode::Normal,
        reason: reason.as_str().into(),
    };
    let _ = tokio::time::timeout(CLOSE_GRACE, async {
        let _ = sink.send(Message::Close(Some(frame))).await;
        let _ = sink.close().await;
    })
    .await;
}

fn next_connection_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::SeqCst)
}

/// Open one connection: the HTTP upgrade with `headers` (later duplicates
/// replace earlier ones, like a `Headers.set`), raced against `cancel`,
/// then the worker task that owns the socket.
pub(crate) async fn connect(
    url: &str,
    headers: &[(String, String)],
    cancel: Option<&CancellationToken>,
    dialect: EventDialect,
) -> Result<WorkerHandle, ConnectFailure> {
    let mut request = url
        .into_client_request()
        .map_err(|error| ConnectFailure::Request(error.to_string()))?;
    for (name, value) in headers {
        let name = http::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| ConnectFailure::Request(format!("Invalid WebSocket header {name}")))?;
        let value = http::HeaderValue::from_str(value)
            .map_err(|_| ConnectFailure::Request("Invalid WebSocket header value".to_string()))?;
        request.headers_mut().insert(name, value);
    }
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return Err(ConnectFailure::Cancelled);
    }
    let handshake = tokio_tungstenite::connect_async(request);
    let (stream, _response) = match cancel {
        Some(cancel) => {
            tokio::select! {
                () = cancel.cancelled() => return Err(ConnectFailure::Cancelled),
                result = handshake => result,
            }
        }
        None => handshake.await,
    }
    .map_err(ConnectFailure::Handshake)?;
    let (commands, receiver) = mpsc::channel::<SendRequest>(4);
    let closing = Arc::new(Closing::default());
    tokio::spawn(connection_worker(
        stream,
        receiver,
        Arc::clone(&closing),
        dialect,
    ));
    Ok(WorkerHandle {
        commands,
        closing,
        connection_id: next_connection_id(),
    })
}

/// The connection's worker: serves one request at a time and parks between
/// requests, watching the idle socket so a peer close retires it.
async fn connection_worker(
    stream: WsStream,
    mut commands: mpsc::Receiver<SendRequest>,
    closing: Arc<Closing>,
    dialect: EventDialect,
) {
    let (mut sink, mut stream) = stream.split();
    loop {
        let request = tokio::select! {
            request = commands.recv() => request,
            () = closing.token.cancelled() => {
                close_politely(&mut sink, closing.reason()).await;
                return;
            }
            idle = stream.next() => match idle {
                // Control frames and stray data between requests carry
                // nothing a request is waiting for.
                Some(Ok(
                    Message::Ping(_)
                    | Message::Pong(_)
                    | Message::Frame(_)
                    | Message::Text(_)
                    | Message::Binary(_),
                )) => continue,
                // A close, EOF, or socket error while idle: the connection
                // is gone, so the worker exits and the handle reads closed.
                Some(Ok(Message::Close(_)) | Err(_)) | None => {
                    close_politely(&mut sink, CloseReason::Done).await;
                    return;
                }
            },
        };
        let Some(SendRequest {
            body,
            events,
            cancel,
        }) = request
        else {
            // Every handle is gone (an ephemeral connection released and
            // dropped right after its close): the socket still closes with
            // the close frame, never a bare drop.
            close_politely(&mut sink, closing.reason()).await;
            return;
        };
        // A request whose token fired while it queued never reaches the
        // wire (TS checks the signal before `send`).
        let sent = if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
            Err(SocketEnd::Cancelled)
        } else {
            tokio::select! {
                sent = sink.send(Message::Text(body.into())) => {
                    sent.map_err(|_| SocketEnd::SendFailed)
                }
                () = cancelled(cancel.as_ref()) => Err(SocketEnd::Cancelled),
                () = closing.token.cancelled() => Err(SocketEnd::LocalClose(closing.reason())),
            }
        };
        let end = match sent {
            Ok(()) => {
                read_request_events(&mut stream, &events, cancel.as_ref(), &closing, dialect).await
            }
            Err(end) => end,
        };
        let completed = matches!(end, SocketEnd::Completed);
        // A request that did not complete retires the connection (TS
        // `release(false)` closes with `done`); a local close keeps its
        // own reason, and so does a cancellation that came with one (a
        // disposal closes the socket before it fires the token).
        let close_reason = match &end {
            SocketEnd::LocalClose(reason) => *reason,
            SocketEnd::Cancelled => closing.reason(),
            _ => CloseReason::Done,
        };
        let _ = events.send(WorkerEvent::End(end)).await;
        if !completed {
            close_politely(&mut sink, close_reason).await;
            return;
        }
    }
}

/// Read one request's events until its terminal event, a close, a
/// failure, or cancellation. Text and binary frames decode alike (the
/// terminal check covers both); empty frames carry nothing (TS
/// `if (!text) return`).
async fn read_request_events(
    stream: &mut SplitStream<WsStream>,
    events: &mpsc::Sender<WorkerEvent>,
    cancel: Option<&CancellationToken>,
    closing: &Closing,
    dialect: EventDialect,
) -> SocketEnd {
    loop {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return SocketEnd::Cancelled;
        }
        let message = tokio::select! {
            () = cancelled(cancel) => return SocketEnd::Cancelled,
            () = closing.token.cancelled() => return SocketEnd::LocalClose(closing.reason()),
            message = stream.next() => message,
        };
        let text = match message {
            None => return SocketEnd::Eof,
            Some(Ok(Message::Text(text))) => text.as_str().to_string(),
            Some(Ok(Message::Binary(bytes))) => String::from_utf8_lossy(&bytes).into_owned(),
            Some(Ok(Message::Close(frame))) => {
                return match frame {
                    Some(frame) => SocketEnd::CloseFrame {
                        code: Some(u16::from(frame.code)),
                        reason: frame.reason.as_str().to_string(),
                    },
                    None => SocketEnd::CloseFrame {
                        code: None,
                        reason: String::new(),
                    },
                };
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
            Some(Err(error)) => return SocketEnd::Read(error),
        };
        if text.is_empty() {
            continue;
        }
        let event = match serde_json::from_str::<Value>(&text) {
            Ok(event) => event,
            Err(error) => {
                return SocketEnd::InvalidJson {
                    error: error.to_string(),
                    text,
                }
            }
        };
        let terminal = dialect.is_terminal(&event);
        if events.send(WorkerEvent::Event(event)).await.is_err() {
            return SocketEnd::ConsumerGone;
        }
        if terminal {
            return SocketEnd::Completed;
        }
    }
}
