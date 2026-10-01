//! Loopback request capture for the Anthropic wire tests: a listener that
//! reads one whole request (the head through the blank line, then the
//! declared body) and answers a finite `end_turn` SSE reply, so a test
//! asserts what actually crossed the socket rather than a pre-send map.

use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::providers::anthropic::{stream_anthropic, AnthropicOptions};
use crate::types::{Context, Model, StopReason};

const END_TURN_SSE: &str = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-test\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";

/// One request as the loopback server read it off the socket.
#[derive(Debug)]
pub(super) struct CapturedRequest {
    /// Header lines in wire order, names lowercased (HTTP names are
    /// case-insensitive); a header sent twice stays two entries.
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Value,
}

impl CapturedRequest {
    /// Every value sent under the lowercase `name`, in wire order.
    pub(super) fn values(&self, name: &str) -> Vec<&str> {
        self.headers
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
            .collect()
    }
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> CapturedRequest {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0, "the client closed before the request head ended");
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8(buffer[..head_end].to_vec()).unwrap();
    let headers: Vec<(String, String)> = head
        .split("\r\n")
        .skip(1)
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_ascii_lowercase(), value.trim().to_string())
        })
        .collect();
    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map_or(0, |(_, value)| value.parse().unwrap());
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0, "the client closed before the declared body ended");
        body.extend_from_slice(&chunk[..read]);
    }
    CapturedRequest {
        headers,
        body: serde_json::from_slice(&body).unwrap(),
    }
}

/// Stream one request for `model`, its base URL pointed at a fresh
/// loopback listener, and return the request the listener read. One
/// bound covers the whole exchange (request, reply, stream settle).
pub(super) async fn capture_request(
    mut model: Model,
    context: &Context,
    options: &AnthropicOptions,
) -> CapturedRequest {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    model.base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{END_TURN_SSE}",
            END_TURN_SSE.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        request
    });
    let server_abort = server.abort_handle();
    let exchange = async {
        let reply = stream_anthropic(&model, context, Some(options))
            .result()
            .await;
        assert_eq!(
            reply.stop_reason,
            StopReason::Stop,
            "the loopback reply settles: {:?}",
            reply.error_message
        );
        server.await.unwrap()
    };
    let request = tokio::time::timeout(Duration::from_secs(10), exchange).await;
    server_abort.abort();
    request.expect("the loopback exchange settles")
}
