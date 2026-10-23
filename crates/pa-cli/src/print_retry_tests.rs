//! Direct print retries use the real provider and the same SSE drop detector
//! as daemon sessions, and print selection never concatenates a failed partial.
use super::*;
use pa_core::session_engine::provider_adapter::json_round_trip;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn print_retries_a_real_dropped_stream_and_keeps_only_committed_context() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    let server = tokio::spawn(async move {
        let dropped = "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"failed partial\"},\"finish_reason\":null}]}\n\n";
        let healthy = "data: {\"id\":\"c2\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"recovered answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        for body in [dropped, healthy, healthy] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let (head_end, length) = loop {
                let mut chunk = [0u8; 4096];
                let size = socket.read(&mut chunk).await.unwrap();
                assert!(size > 0);
                request.extend_from_slice(&chunk[..size]);
                if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..end]);
                    let length = head
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .unwrap()
                        .1
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        break (end + 4, length);
                    }
                }
            };
            recorded.lock().unwrap().push(
                serde_json::from_slice::<serde_json::Value>(&request[head_end..head_end + length])
                    .unwrap(),
            );
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            socket.write_all(reply.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    let dir = tempfile::TempDir::new().unwrap();
    let model: Model = serde_json::from_value(serde_json::json!({
        "id": "gpt-print", "name": "GPT print", "api": "openai-completions",
        "provider": "print-test", "baseUrl": format!("http://{address}/v1"),
        "reasoning": false, "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128_000, "maxTokens": 4096,
    }))
    .unwrap();
    let manager = pa_core::session::manager::SessionManager::persisted(
        dir.path(),
        &dir.path().join("sessions"),
    );
    let session_path = manager.get_session_file().unwrap().to_path_buf();
    let engine = Arc::new(
        pa_core::session_engine::engine::create_session(
            pa_core::session_engine::engine::SessionEngineConfig {
                cwd: dir.path().to_path_buf(),
                agent_dir: dir.path().join("agent"),
                model: json_round_trip(&model),
                model_info: Some(model.clone()),
                stream_fn: Some(pa_core::session_engine::provider_adapter::real_stream_fn(
                    Some("fixture".to_string()),
                    model.clone(),
                )),
                tool_selection: pa_core::session_engine::tool_selection::ToolSelection::NoTools,
                session_manager: Some(manager),
                custom_system_prompt: Some("test".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap(),
    );
    let policy = ProviderRetryPolicy {
        base_delay_ms: 1,
        ..pa_core::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY
    };
    run_prompt(
        &engine,
        &model,
        "hello",
        &[],
        &policy,
        /*json_mode*/ false,
    )
    .await
    .unwrap();
    let persistence = engine.session.shared_persistence();
    let entries = persistence.lock().await.get_entries();
    let terminal = pa_core::session_engine::headless::select_from_entries(&entries);
    assert_eq!(
        terminal.primary.unwrap().stdout_text().as_deref(),
        Some("recovered answer")
    );
    // Exercise persisted reload, not only the live cleanup.
    let reopened = pa_core::session::manager::SessionManager::open(
        dir.path(),
        &dir.path().join("sessions"),
        &session_path,
    );
    let reloaded = reopened.get_entries();
    engine
        .session
        .rebuild_branch_context(reloaded)
        .await
        .unwrap();
    run_prompt(
        &engine,
        &model,
        "next",
        &[],
        &policy,
        /*json_mode*/ false,
    )
    .await
    .unwrap();
    server.await.unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(!requests[1].to_string().contains("failed partial"));
    assert!(!requests[2].to_string().contains("failed partial"));
    assert!(requests[2].to_string().contains("recovered answer"));
    engine.abandon_kernel();
}

#[tokio::test]
async fn print_cancellation_interrupts_the_observed_retry_wait_without_a_second_request() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        loop {
            let mut socket = tokio::select! {
                result = listener.accept() => result.unwrap().0,
                _ = &mut stop_rx => break,
            };
            let mut request = Vec::new();
            loop {
                let mut chunk = [0u8; 4096];
                let size = socket.read(&mut chunk).await.unwrap();
                assert!(size > 0);
                request.extend_from_slice(&chunk[..size]);
                if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..end]);
                    let length = head
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .unwrap()
                        .1
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        recorded.lock().unwrap().push(
                            serde_json::from_slice::<serde_json::Value>(
                                &request[end + 4..end + 4 + length],
                            )
                            .unwrap(),
                        );
                        break;
                    }
                }
            }
            let body = "data: {\"id\":\"cut\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"failed partial\"},\"finish_reason\":null}]}\n\n";
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            socket.write_all(reply.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let model: Model = serde_json::from_value(serde_json::json!({
        "id": "gpt-print", "name": "GPT print", "api": "openai-completions", "provider": "print-test",
        "baseUrl": format!("http://{address}/v1"), "reasoning": false, "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128_000, "maxTokens": 4096,
    })).unwrap();
    let engine = Arc::new(
        pa_core::session_engine::engine::create_session(
            pa_core::session_engine::engine::SessionEngineConfig {
                cwd: dir.path().to_path_buf(),
                agent_dir: dir.path().join("agent"),
                model: json_round_trip(&model),
                model_info: Some(model.clone()),
                stream_fn: Some(pa_core::session_engine::provider_adapter::real_stream_fn(
                    Some("fixture".to_string()),
                    model.clone(),
                )),
                tool_selection: pa_core::session_engine::tool_selection::ToolSelection::NoTools,
                custom_system_prompt: Some("test".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap(),
    );
    let controller = AbortController::new();
    let signal = controller.signal();
    let events = Arc::new(Mutex::new(Vec::new()));
    let emitted = Arc::clone(&events);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let started_tx = Mutex::new(Some(started_tx));
    let policy = ProviderRetryPolicy {
        base_delay_ms: 60_000,
        ..pa_core::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY
    };
    let run = run_prompt_with_signal(
        &engine,
        &model,
        "hello",
        &[],
        &policy,
        &signal,
        move |update| {
            if matches!(update.event, AutoRetryEvent::Start { .. }) {
                started_tx.lock().unwrap().take().unwrap().send(()).unwrap();
            }
            emitted.lock().unwrap().push(update.event);
            std::future::ready(Ok(()))
        },
    );
    tokio::pin!(run);
    tokio::select! {
        result = &mut run => panic!("settled before observed retry: {result:?}"),
        result = started_rx => result.unwrap(),
    }
    // The run has yielded in its idle wait, not in a live agent run.
    controller.abort();
    let message = tokio::time::timeout(std::time::Duration::from_secs(1), &mut run)
        .await
        .expect("cancellation must interrupt the long wait")
        .unwrap();
    assert_eq!(message.stop_reason, pa_agent::types::StopReason::Aborted);
    assert_eq!(
        events.lock().unwrap().last(),
        Some(&AutoRetryEvent::End {
            success: false,
            attempt: 1,
            final_error: Some("Retry cancelled".to_string()),
            restored_model: None,
        })
    );
    stop_tx.send(()).unwrap();
    server.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);
    let entries = engine.session.entries().await;
    let outcomes = entries.iter().filter(|entry| matches!(entry,
        pa_types::session::FileEntry::CustomMessage { payload, .. } if payload.custom_type == "provider_retry_outcome"
    )).count();
    assert_eq!(outcomes, 1);
    engine.abandon_kernel();
}

#[test]
fn a_zero_budget_connection_reset_outcome_supersedes_failed_partial_tool_cards() {
    use pa_tui::chat::{ChatEntry, MessageBlock};
    use pa_tui::snapshot::{event_to_update, transcript_to_entries, TurnUpdate};
    let committed = serde_json::json!({"role": "assistant", "stopReason": "toolUse", "content": [
        {"type": "toolCall", "id": "call_once", "name": "probe", "arguments": {}}
    ]});
    let result = serde_json::json!({"role": "toolResult", "toolCallId": "call_once", "toolName": "probe",
        "content": [{"type": "text", "text": "ran once"}], "isError": false});
    let failed = serde_json::json!({"role": "assistant", "stopReason": "error", "errorMessage": "aged connection",
        "content": [{"type": "text", "text": "failed partial"},
            {"type": "toolCall", "id": "call_cut", "name": "probe", "arguments": {}}]});
    let answer = serde_json::json!({"role": "assistant", "stopReason": "stop",
        "content": [{"type": "text", "text": "recovered answer"}]});
    let outcome = pa_core::session_engine::messages::create_provider_retry_outcome_message(
        /*success*/ true,
        0,
        "aged connection",
    );
    let outcome = serde_json::to_value(pa_types::session::AgentMessage::Custom(outcome)).unwrap();
    assert!(matches!(
        event_to_update(&serde_json::json!({
            "type": "auto_retry_start", "attempt": 1, "maxAttempts": 1, "delayMs": 0,
            "errorMessage": "aged connection", "reason": "connection_reset",
        })),
        Some(TurnUpdate::AutoRetryStart {
            attempt: 1,
            max_attempts: 1,
            delay_ms: 0,
            ..
        })
    ));
    assert_eq!(
        event_to_update(&serde_json::json!({
            "type": "auto_retry_end", "success": true, "attempt": 0,
        })),
        Some(TurnUpdate::AutoRetryEnd {
            success: true,
            attempt: 0,
            final_error: None,
            restored_model: None,
        })
    );
    let displayed = transcript_to_entries(&[committed, result, failed, answer, outcome]);
    assert_eq!(displayed.len(), 3);
    assert!(
        matches!(&displayed[0], ChatEntry::Tool(card) if card.id == "call_once"
        && card.started && card.result.as_ref().is_some_and(|result|
            result.content == vec![serde_json::json!({"type": "text", "text": "ran once"})]))
    );
    assert!(matches!(&displayed[1], ChatEntry::Assistant(message)
        if matches!(message.blocks.as_slice(), [MessageBlock::Text(text)] if text == "recovered answer")));
    assert!(matches!(&displayed[2], ChatEntry::Status { .. }));
}
