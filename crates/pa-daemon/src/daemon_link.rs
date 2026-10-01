//! A client link to the supervisor socket: JSONL command envelopes out,
//! responses matched by id, every other frame handed to the link owner raw.
//! Shared by the daemon-attached ACP transport and the hosted headless
//! client; each owner runs its own frame consumer, which resolves the
//! responses (`DaemonLink::resolve`) so the frames it observed before a
//! response are handled before that response's waiter resumes.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use pa_types::daemon::{
    DaemonCommand, DaemonCommandEnvelope, DaemonCommandFrameType, DaemonProtocolInfo,
    DaemonResponse, DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

/// One inbound supervisor frame, classified by the reader.
pub(crate) enum LinkFrame {
    /// A `session_event` frame.
    Event(Value),
    /// A command response (the consumer hands it to [`DaemonLink::resolve`]).
    Response(DaemonResponse),
    /// Any other frame after the handshake (`session_closed`,
    /// `daemon_closing`, roster pushes, ...).
    Other(Value),
}

/// How long a request waits for its response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResponseWait {
    /// Fail the request when no response arrives within the bound.
    Within(std::time::Duration),
    /// Wait until the daemon answers or the connection closes (turn-long
    /// commands the supervisor bounds itself).
    UntilAnswered,
}

/// A client connection to the supervisor socket.
pub(crate) struct DaemonLink {
    writer: std::sync::Mutex<Option<mpsc::UnboundedSender<String>>>,
    /// The requests waiting for a response; `None` once the connection
    /// ended ([`DaemonLink::fail_pending`]), so a later request fails at
    /// once instead of waiting for an answer that cannot arrive.
    pending: std::sync::Mutex<Option<HashMap<String, oneshot::Sender<DaemonResponse>>>>,
    /// The classified inbound frames; exactly one consumer drains them.
    pub(crate) frames: Mutex<mpsc::UnboundedReceiver<LinkFrame>>,
    protocol_version: u64,
    next_request_id: AtomicU64,
    /// Prefix of request ids and of the envelope client id (`acp`,
    /// `headless`), so the daemon log names the transport.
    label: &'static str,
}

impl DaemonLink {
    /// Connect and complete the `daemon_hello` handshake.
    pub(crate) async fn connect(socket_path: &Path, label: &'static str) -> anyhow::Result<Self> {
        let stream = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            pa_types::platform::transport::connect_transport(socket_path),
        )
        .await
        .map_err(|_| anyhow::anyhow!("timed out connecting to the daemon socket"))??;
        let (reader_half, writer_half) = stream.split();
        let (line_tx, mut line_rx) = mpsc::unbounded_channel::<String>();
        let (frame_tx, frame_rx) = mpsc::unbounded_channel::<LinkFrame>();
        let (hello_tx, hello_rx) = oneshot::channel::<Value>();

        tokio::spawn(async move {
            let mut writer = writer_half;
            while let Some(line) = line_rx.recv().await {
                let mut payload = line.into_bytes();
                payload.push(b'\n');
                if writer.write_all(&payload).await.is_err() {
                    break;
                }
            }
            let _ = writer.shutdown().await;
        });
        // The reader only classifies frames; the owner's consumer loop owns
        // the ordering (frames observed before a response are handled
        // before that response resolves its caller).
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader_half);
            let mut line = String::new();
            let mut hello_tx = Some(hello_tx);
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                let frame = match value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "daemon_hello" => {
                        if let Some(tx) = hello_tx.take() {
                            let _ = tx.send(value);
                        }
                        continue;
                    }
                    "response" => {
                        let Ok(response) = serde_json::from_value::<DaemonResponse>(value) else {
                            continue;
                        };
                        LinkFrame::Response(response)
                    }
                    "session_event" => LinkFrame::Event(value),
                    _ => LinkFrame::Other(value),
                };
                let _ = frame_tx.send(frame);
            }
        });

        let hello = tokio::time::timeout(std::time::Duration::from_secs(3), hello_rx)
            .await
            .map_err(|_| anyhow::anyhow!("the daemon did not send its handshake"))?
            .map_err(|_| anyhow::anyhow!("the daemon connection closed before the handshake"))?;
        let protocol = hello
            .get("protocol")
            .cloned()
            .and_then(|p| serde_json::from_value::<DaemonProtocolInfo>(p).ok())
            .unwrap_or(DaemonProtocolInfo {
                name: DAEMON_PROTOCOL_NAME.to_string(),
                version: DAEMON_PROTOCOL_VERSION,
            });
        let version = protocol.version.min(DAEMON_PROTOCOL_VERSION);
        Ok(DaemonLink {
            writer: std::sync::Mutex::new(Some(line_tx)),
            pending: std::sync::Mutex::new(Some(HashMap::new())),
            frames: Mutex::new(frame_rx),
            protocol_version: version,
            next_request_id: AtomicU64::new(0),
            label,
        })
    }

    /// Send one command envelope and wait for the matching response.
    pub(crate) async fn request(
        &self,
        command: DaemonCommand,
        wait: ResponseWait,
    ) -> anyhow::Result<DaemonResponse> {
        let id = format!(
            "{}-{}",
            self.label,
            self.next_request_id.fetch_add(1, Ordering::SeqCst) + 1
        );
        let envelope = DaemonCommandEnvelope {
            frame_type: DaemonCommandFrameType::Command,
            id: id.clone(),
            protocol: DaemonProtocolInfo {
                name: DAEMON_PROTOCOL_NAME.to_string(),
                version: self.protocol_version,
            },
            client_id: Some(format!("{}:{}", self.label, std::process::id())),
            command,
        };
        let line = serde_json::to_string(&envelope)?;
        let (tx, rx) = oneshot::channel::<DaemonResponse>();
        match self.pending.lock().unwrap().as_mut() {
            Some(pending) => {
                pending.insert(id.clone(), tx);
            }
            None => anyhow::bail!("the daemon connection is closed"),
        }
        let sent = self
            .writer
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|writer| writer.send(line).is_ok());
        if !sent {
            // A closed writer leaves the pending slot behind otherwise; a
            // link that never answers again would grow one entry per
            // request.
            self.forget(&id);
            anyhow::bail!("the daemon connection is closed");
        }
        let response = match wait {
            ResponseWait::Within(bound) => tokio::time::timeout(bound, rx).await.map_err(|_| {
                self.forget(&id);
                anyhow::anyhow!("timed out waiting for the daemon response")
            })?,
            ResponseWait::UntilAnswered => rx.await,
        };
        response.map_err(|_| anyhow::anyhow!("the daemon connection closed mid-request"))
    }

    /// Hand a response to the request waiting for it (the consumer loop
    /// calls this once it has handled every frame that preceded it).
    pub(crate) fn resolve(&self, response: DaemonResponse) {
        let id = response.id.clone().unwrap_or_default();
        if let Some(tx) = self.forget(&id) {
            let _ = tx.send(response);
        }
    }

    /// Drop one request's waiter slot (answered, timed out, or never sent).
    fn forget(&self, id: &str) -> Option<oneshot::Sender<DaemonResponse>> {
        self.pending
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|pending| pending.remove(id))
    }

    /// The connection ended (the consumer drained every frame): every
    /// waiting request fails instead of waiting out its bound (or forever,
    /// for an unbounded wait), and so does every later request.
    pub(crate) fn fail_pending(&self) {
        self.pending.lock().unwrap().take();
    }

    /// Close the write half: the supervisor sees the client leave (its
    /// disconnect cleanup detaches whatever this link still had
    /// attached). Later requests fail fast.
    pub(crate) fn close(&self) {
        self.writer.lock().unwrap().take();
    }
}
