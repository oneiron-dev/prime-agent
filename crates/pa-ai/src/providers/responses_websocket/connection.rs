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
//! connection (callers see it through [`WorkerHandle::is_open`]).

use std::sync::atomic::{AtomicU64, Ordering};

use futures::stream::SplitStream;
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

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

enum WorkerCommand {
    Send {
        body: String,
        events: mpsc::Sender<WorkerEvent>,
        cancel: Option<CancellationToken>,
    },
    Close,
}

/// Command handle to one connection's worker task.
#[derive(Clone)]
pub(crate) struct WorkerHandle {
    commands: mpsc::Sender<WorkerCommand>,
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
        !self.commands.is_closed()
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
            .send(WorkerCommand::Send {
                body,
                events,
                cancel,
            })
            .await
            .ok()?;
        Some(receiver)
    }

    /// Ask the worker to close its socket (TS `closeWebSocketSilently`).
    /// Never blocks: a busy worker closes the socket when its request
    /// ends, an exited worker needs nothing.
    pub(crate) fn close(&self) {
        let _ = self.commands.try_send(WorkerCommand::Close);
    }
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
    let (commands, receiver) = mpsc::channel::<WorkerCommand>(4);
    tokio::spawn(connection_worker(stream, receiver, dialect));
    Ok(WorkerHandle {
        commands,
        connection_id: next_connection_id(),
    })
}

/// The connection's worker: serves one request at a time and parks between
/// requests, watching the idle socket so a peer close retires it.
async fn connection_worker(
    stream: WsStream,
    mut commands: mpsc::Receiver<WorkerCommand>,
    dialect: EventDialect,
) {
    let (mut sink, mut stream) = stream.split();
    loop {
        let command = tokio::select! {
            command = commands.recv() => command,
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
                    let _ = sink.close().await;
                    return;
                }
            },
        };
        let Some(command) = command else {
            return;
        };
        match command {
            WorkerCommand::Close => {
                let _ = sink.close().await;
                return;
            }
            WorkerCommand::Send {
                body,
                events,
                cancel,
            } => {
                if sink.send(Message::Text(body.into())).await.is_err() {
                    let _ = events.send(WorkerEvent::End(SocketEnd::SendFailed)).await;
                    let _ = sink.close().await;
                    return;
                }
                let end = read_request_events(&mut stream, &events, cancel.as_ref(), dialect).await;
                let completed = matches!(end, SocketEnd::Completed);
                let _ = events.send(WorkerEvent::End(end)).await;
                if !completed {
                    let _ = sink.close().await;
                    return;
                }
            }
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
    dialect: EventDialect,
) -> SocketEnd {
    loop {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return SocketEnd::Cancelled;
        }
        let next = stream.next();
        let message = match cancel {
            Some(cancel) => {
                tokio::select! {
                    () = cancel.cancelled() => return SocketEnd::Cancelled,
                    message = next => message,
                }
            }
            None => next.await,
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
