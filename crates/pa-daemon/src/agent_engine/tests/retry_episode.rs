//! The retry-episode tests: the host side of the per-message retry reset
//! (TS `_retryAttempt` resets at every successful assistant message) and
//! the retried request's context hygiene.
use super::*;

/// One faux-driven engine whose quick retries wait 1ms and allow a single
/// retry per episode.
fn single_retry_engine(script: &serde_json::Value) -> (AgentSessionEngine, tempfile::TempDir) {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::create_dir_all(dir.path().join("agent")).unwrap();
    std::fs::write(
        dir.path().join("agent").join("settings.json"),
        json!({ "retry": { "enabled": true, "maxRetries": 1, "baseDelayMs": 1 } }).to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(script.to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    (engine, dir)
}

/// The compact shape of the turn: each settled assistant message's stop
/// reason and the retry events, in emit order.
#[derive(Debug, PartialEq)]
enum Seen {
    Assistant(String),
    RetryStart(u32),
    RetryEnd { success: bool, attempt: u32 },
}

/// A retried turn that completes a tool call and then fails again starts
/// a fresh retry episode: the host closes the first episode right after
/// the successful tool-call message, so the second failure is again the
/// first retry. Before the reset, the second failure counted as the
/// second retry of one episode and exhausted the single-retry budget —
/// the turn died instead of finishing.
#[test]
fn a_successful_tool_call_inside_a_retried_turn_closes_the_episode() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dropped = "WebSocket closed before response.completed";
    let script = json!({
        "engine": "faux",
        "responses": [
            { "stopReason": "error", "errorMessage": dropped,
              "content": [{ "type": "text", "text": "partial reply that was cut off" }] },
            { "content": [{ "type": "toolCall", "name": "no_such_tool", "arguments": {} }] },
            { "stopReason": "error", "errorMessage": dropped },
            { "content": [{ "type": "text", "text": "done" }] },
        ],
    });
    let (engine, _dir) = single_retry_engine(&script);
    let mut seen = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "go".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            match &event {
                EngineEvent::AssistantMessage(message) => seen.push(Seen::Assistant(
                    message["stopReason"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                )),
                EngineEvent::AutoRetryStart { attempt, .. } => {
                    seen.push(Seen::RetryStart(*attempt));
                }
                EngineEvent::AutoRetryEnd {
                    success, attempt, ..
                } => seen.push(Seen::RetryEnd {
                    success: *success,
                    attempt: *attempt,
                }),
                _ => {}
            }
            true
        },
    );
    assert_eq!(
        seen,
        vec![
            Seen::Assistant("error".to_string()),
            Seen::RetryStart(1),
            Seen::Assistant("toolUse".to_string()),
            Seen::RetryEnd {
                success: true,
                attempt: 1
            },
            Seen::Assistant("error".to_string()),
            Seen::RetryStart(1),
            Seen::Assistant("stop".to_string()),
            Seen::RetryEnd {
                success: true,
                attempt: 1
            },
        ]
    );
    // Neither failed reply (the cut-off partial included) stayed in the
    // loop context the retried requests were built from.
    let session = engine.session.blocking_lock();
    let built = session.as_deref().expect("built session");
    let messages = engine
        .runtime
        .block_on(built.session.agent().state())
        .messages;
    let stop_reasons: Vec<pa_agent::types::StopReason> = messages
        .iter()
        .filter_map(|message| match message {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(
                assistant,
            )) => Some(assistant.stop_reason),
            _ => None,
        })
        .collect();
    assert_eq!(
        stop_reasons,
        vec![
            pa_agent::types::StopReason::ToolUse,
            pa_agent::types::StopReason::Stop
        ]
    );
}
