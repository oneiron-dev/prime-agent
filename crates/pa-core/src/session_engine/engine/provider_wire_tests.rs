//! A normal engine-built session on the real Anthropic provider, captured
//! off a loopback socket: the session-affinity pair a `cpa-a` session
//! sends is keyed by the session's durable id (TS `sdk.ts` passes
//! `sessionManager.getSessionId()` into the Agent; the fork's anthropic
//! provider hashes it).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::tests::echo_definition;
use super::*;
use crate::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
use crate::session_engine::tool_bridge::bridge_tool;

const TOOL_USE_SSE: &str = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"echo\",\"input\":{}}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"text\\\":\\\"hi\\\"}\"}}\n\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":1}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";

const END_TURN_SSE: &str = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_2\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}\n\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";

/// Read one whole request's header lines (names lowercased) and drain its
/// declared body.
async fn read_request_headers(socket: &mut tokio::net::TcpStream) -> Vec<(String, String)> {
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
    let headers: Vec<(String, String)> = String::from_utf8(buffer[..head_end].to_vec())
        .unwrap()
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
    let mut body_read = buffer.len() - (head_end + 4);
    while body_read < length {
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0, "the client closed before the declared body ended");
        body_read += read;
    }
    headers
}

/// A loopback Anthropic endpoint answering one connection per reply, in
/// order; the returned task yields every request's header lines.
async fn serve(
    replies: Vec<&'static str>,
) -> (String, tokio::task::JoinHandle<Vec<Vec<(String, String)>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for reply in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_request_headers(&mut socket).await);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        requests
    });
    (base_url, server)
}

/// Run one prompt on an engine-built `cpa-a` session against `replies`;
/// returns the session's durable id, its session file, and the
/// `(x-client-request-id, x-session-affinity)` values of every request.
async fn run_cpa_session(
    cwd: &std::path::Path,
    agent_dir: &std::path::Path,
    session_manager: SessionManager,
    replies: Vec<&'static str>,
) -> (String, std::path::PathBuf, Vec<(Vec<String>, Vec<String>)>) {
    let request_count = replies.len();
    let (base_url, server) = serve(replies).await;
    let model: pa_types::ai::Model = serde_json::from_value(serde_json::json!({
        "id": "claude-test", "name": "Claude Test", "api": "anthropic-messages",
        "provider": "cpa-a", "baseUrl": base_url, "reasoning": false, "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 200_000, "maxTokens": 32_000,
        "compat": {"sendSessionAffinityHeaders": true}
    }))
    .unwrap();
    let engine = create_session(SessionEngineConfig {
        cwd: cwd.to_path_buf(),
        agent_dir: agent_dir.to_path_buf(),
        model: Some(json_round_trip(&model).unwrap()),
        model_info: Some(model.clone()),
        stream_fn: Some(real_stream_fn(Some("dummy-key".into()), model)),
        tools: vec![bridge_tool(echo_definition())],
        session_manager: Some(session_manager),
        ..Default::default()
    })
    .await
    .unwrap();
    engine
        .prompt("run the echo tool", PromptOptions::default())
        .await
        .unwrap();
    engine.session.agent().wait_for_idle().await;
    let session_id = engine.session.session_id().await;
    let session_file = engine
        .session
        .shared_persistence()
        .lock()
        .await
        .get_session_file()
        .expect("a persisted session has a file")
        .to_path_buf();
    let requests = tokio::time::timeout(std::time::Duration::from_secs(10), server)
        .await
        .expect("the endpoint served every reply")
        .unwrap();
    assert_eq!(requests.len(), request_count);
    for headers in &requests {
        assert!(
            headers
                .iter()
                .all(|(_, value)| !value.contains(&session_id)),
            "the raw session id rides no header: {headers:?}"
        );
    }
    let affinity = requests
        .iter()
        .map(|headers| {
            let values = |name: &str| {
                headers
                    .iter()
                    .filter(|(key, _)| key == name)
                    .map(|(_, value)| value.clone())
                    .collect::<Vec<_>>()
            };
            (values("x-client-request-id"), values("x-session-affinity"))
        })
        .collect();
    (session_id, session_file, affinity)
}

/// Both requests of a normal session's tool loop carry the digest of the
/// session manager's durable id; reopening the session file keeps it, and
/// a separate session sends its own.
#[tokio::test]
async fn cpa_session_requests_carry_the_durable_session_digest() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    let agent_dir = tmp.path().join("agent");
    let session_dir = tmp.path().join("sessions");
    std::fs::create_dir_all(&cwd).unwrap();
    let digest_pair = |session_id: &str| {
        let key = URL_SAFE_NO_PAD.encode(Sha256::digest(session_id.as_bytes()));
        (vec![key.clone()], vec![key])
    };

    let (first_id, first_file, first) = run_cpa_session(
        &cwd,
        &agent_dir,
        SessionManager::persisted(&cwd, &session_dir),
        vec![TOOL_USE_SSE, END_TURN_SSE],
    )
    .await;
    assert_eq!(first, vec![digest_pair(&first_id), digest_pair(&first_id)]);

    let (reopened_id, _, reopened) = run_cpa_session(
        &cwd,
        &agent_dir,
        SessionManager::open(&cwd, &session_dir, &first_file),
        vec![END_TURN_SSE],
    )
    .await;
    assert_eq!(
        (reopened_id.as_str(), reopened),
        (first_id.as_str(), vec![digest_pair(&first_id)])
    );

    let (other_id, _, other) = run_cpa_session(
        &cwd,
        &agent_dir,
        SessionManager::persisted(&cwd, &session_dir),
        vec![END_TURN_SSE],
    )
    .await;
    assert_ne!(other_id, first_id);
    assert_eq!(other, vec![digest_pair(&other_id)]);
}
