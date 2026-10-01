//! Scripted loopback Responses server for the WebSocket transport tests:
//! one listener answers both WebSocket upgrades and SSE POSTs, and records
//! every upgrade (with its handshake headers) and every request body in
//! arrival order. Each record is written before the server answers, so a
//! test that has seen the client's result reads complete records without
//! waiting on anything else.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// What the server does with one WebSocket upgrade.
pub(crate) enum Upgrade {
    /// Complete the 101 handshake and answer the socket's requests with
    /// these turns, in order (requests beyond them stall).
    Accept(Vec<Turn>),
    /// Refuse the upgrade with this HTTP status.
    Reject(u16),
    /// Read the upgrade request and never answer it.
    Hang,
    /// Hold the 101 answer until the gate fires, then accept.
    AcceptWhen(tokio::sync::oneshot::Receiver<()>, Vec<Turn>),
}

/// The answer to one `response.create` frame on an accepted socket.
pub(crate) enum Turn {
    /// Text frames, then wait for the next request.
    Events(Vec<Value>),
    /// The same events as binary frames.
    BinaryEvents(Vec<Value>),
    /// Events, then end the TCP connection without a close frame.
    EventsThenFin(Vec<Value>),
    /// Events, then a close frame with this code and reason.
    EventsThenClose(Vec<Value>, u16, &'static str),
    /// Raw text frames (not necessarily JSON).
    RawText(Vec<&'static str>),
    /// Never answer: the request stalls until the client goes away.
    Stall,
}

/// The answer to one SSE POST.
pub(crate) enum SseReply {
    /// `200 text/event-stream` with one `data:` record per event.
    Events(Vec<Value>),
}

/// One observed request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Record {
    /// A WebSocket upgrade (1-based connection number) with its headers,
    /// names lowercased, in arrival order.
    Upgrade {
        connection: usize,
        headers: Vec<(String, String)>,
    },
    /// A `response.create` frame on a connection.
    WsRequest { connection: usize, body: Value },
    /// An SSE POST with its headers and body.
    SseRequest {
        headers: Vec<(String, String)>,
        body: Value,
    },
}

pub(crate) struct MockServer {
    /// `http://127.0.0.1:<port>/v1`.
    pub(crate) base_url: String,
    records: mpsc::UnboundedReceiver<Record>,
}

impl MockServer {
    /// Every record observed since the last drain.
    pub(crate) fn drain(&mut self) -> Vec<Record> {
        let mut records = Vec::new();
        while let Ok(record) = self.records.try_recv() {
            records.push(record);
        }
        records
    }

    /// Wait for the next record (for requests the client has not finished,
    /// e.g. a stalled one).
    pub(crate) async fn next_record(&mut self) -> Record {
        self.records.recv().await.expect("mock server alive")
    }
}

struct Scripts {
    upgrades: Mutex<VecDeque<Upgrade>>,
    sse: Mutex<VecDeque<SseReply>>,
    connections: AtomicUsize,
    records: mpsc::UnboundedSender<Record>,
}

pub(crate) async fn spawn(upgrades: Vec<Upgrade>, sse: Vec<SseReply>) -> MockServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("mock bind");
    let port = listener.local_addr().expect("mock addr").port();
    let (records, receiver) = mpsc::unbounded_channel();
    let scripts = Arc::new(Scripts {
        upgrades: Mutex::new(upgrades.into()),
        sse: Mutex::new(sse.into()),
        connections: AtomicUsize::new(0),
        records,
    });
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(serve(socket, Arc::clone(&scripts)));
        }
    });
    MockServer {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        records: receiver,
    }
}

/// Read the request head (and any bytes already past it).
async fn read_head(socket: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buffer = Vec::new();
    loop {
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
            return Some((head, buffer[end + 4..].to_vec()));
        }
        let mut chunk = [0u8; 4096];
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

fn head_headers(head: &str) -> Vec<(String, String)> {
    head.lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect()
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

// One scripted connection end to end (upgrade or POST, then every turn);
// the turn arms read as the script vocabulary, so they stay together.
#[allow(clippy::too_many_lines)]
async fn serve(mut socket: TcpStream, scripts: Arc<Scripts>) {
    let Some((head, rest)) = read_head(&mut socket).await else {
        return;
    };
    let headers = head_headers(&head);
    if head.starts_with("POST ") {
        serve_sse(socket, &scripts, headers, rest).await;
        return;
    }
    let connection = scripts.connections.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = scripts.records.send(Record::Upgrade {
        connection,
        headers: headers.clone(),
    });
    let upgrade = scripts
        .upgrades
        .lock()
        .expect("upgrade scripts")
        .pop_front()
        .unwrap_or(Upgrade::Reject(503));
    let turns = match upgrade {
        Upgrade::Hang => {
            let mut sink = [0u8; 64];
            while matches!(socket.read(&mut sink).await, Ok(read) if read > 0) {}
            return;
        }
        Upgrade::AcceptWhen(gate, turns) => {
            let _ = gate.await;
            turns
        }
        Upgrade::Reject(status) => {
            let reason = http::StatusCode::from_u16(status)
                .ok()
                .and_then(|status| status.canonical_reason())
                .unwrap_or("Error");
            let _ = socket
                .write_all(
                    format!("HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await;
            let _ = socket.shutdown().await;
            return;
        }
        Upgrade::Accept(turns) => turns,
    };
    let key = header(&headers, "sec-websocket-key").expect("upgrade key");
    let accept = {
        use base64::Engine as _;
        use sha1::Digest as _;
        base64::engine::general_purpose::STANDARD.encode(sha1::Sha1::digest(
            format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes(),
        ))
    };
    if socket
        .write_all(
            format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n")
                .as_bytes(),
        )
        .await
        .is_err()
    {
        return;
    }
    let mut ws = WebSocketStream::from_raw_socket(socket, Role::Server, None).await;
    let mut turns = VecDeque::from(turns);
    loop {
        let body = loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    break serde_json::from_str::<Value>(text.as_str()).expect("request json");
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Binary(_) | Message::Close(_)) | Err(_)) | None => return,
            }
        };
        let _ = scripts.records.send(Record::WsRequest { connection, body });
        let Some(turn) = turns.pop_front() else {
            // Unscripted requests stall until the client goes away.
            while let Some(Ok(_)) = ws.next().await {}
            return;
        };
        match turn {
            Turn::Events(events) => {
                for event in events {
                    if ws
                        .send(Message::Text(event.to_string().into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
            Turn::BinaryEvents(events) => {
                for event in events {
                    let bytes = event.to_string().into_bytes();
                    if ws.send(Message::Binary(bytes.into())).await.is_err() {
                        return;
                    }
                }
            }
            Turn::EventsThenFin(events) => {
                for event in events {
                    if ws
                        .send(Message::Text(event.to_string().into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                let _ = ws.get_mut().shutdown().await;
                return;
            }
            Turn::EventsThenClose(events, code, reason) => {
                for event in events {
                    if ws
                        .send(Message::Text(event.to_string().into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                let _ = ws
                    .close(Some(CloseFrame {
                        code: CloseCode::from(code),
                        reason: reason.into(),
                    }))
                    .await;
                while let Some(Ok(_)) = ws.next().await {}
                return;
            }
            Turn::RawText(frames) => {
                for frame in frames {
                    if ws.send(Message::Text(frame.into())).await.is_err() {
                        return;
                    }
                }
            }
            Turn::Stall => {
                while let Some(Ok(_)) = ws.next().await {}
                return;
            }
        }
    }
}

async fn serve_sse(
    mut socket: TcpStream,
    scripts: &Scripts,
    headers: Vec<(String, String)>,
    mut body: Vec<u8>,
) {
    let length = header(&headers, "content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    while body.len() < length {
        let mut chunk = [0u8; 4096];
        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => body.extend_from_slice(&chunk[..read]),
        }
    }
    let body = serde_json::from_slice::<Value>(&body).expect("sse request json");
    let _ = scripts.records.send(Record::SseRequest { headers, body });
    let reply = scripts.sse.lock().expect("sse scripts").pop_front();
    let response = match reply {
        Some(SseReply::Events(events)) => {
            let mut payload = String::from(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
            );
            for event in events {
                let _ = write!(payload, "data: {event}\n\n");
            }
            payload
        }
        None => {
            "HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                .to_string()
        }
    };
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}
