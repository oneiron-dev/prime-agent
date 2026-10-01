//! Compact-session tests, the summary-request family: the summarizer's
//! provider requests carry the session id on the default transport and
//! run under the shared provider retry policy (TS `runRollingSummary`,
//! fork 2a769b1ad).
use super::*;

/// A transient summary failure (the WebSocket dropped before a verdict)
/// is re-issued under the session's retry policy instead of failing the
/// compaction, and every summary request carries the session id with the
/// provider-default transport (never a forced SSE).
#[tokio::test]
async fn summary_requests_carry_the_session_and_retry_transient_failures() {
    let registration = faux_registration();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let factory = {
        let seen = std::sync::Arc::clone(&seen);
        pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(move |_, options, call, _| {
            seen.lock().unwrap().push((
                options.and_then(|options| options.session_id.clone()),
                options.and_then(|options| options.transport),
            ));
            let mut message = pa_ai::faux::faux_assistant_text_message(
                "## Goal\nsummarized goal",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            );
            if call == 1 {
                message.content.clear();
                message.stop_reason = pa_types::ai::StopReason::Error;
                message.error_message =
                    Some("WebSocket closed before response.completed".to_string());
                message.diagnostics = Some(vec![pa_types::ai::AssistantMessageDiagnostic {
                    type_: "provider_stream_failure".to_string(),
                    timestamp: 0,
                    error: None,
                    details: Some(
                        serde_json::json!({
                            "kind": "transport",
                            "providerErrorType": "websocket_closed",
                        })
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                    ),
                }]);
            }
            Ok(message)
        }))
    };
    registration.set_responses(vec![factory.clone(), factory]);
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
            summary_requests: crate::session_engine::compaction_exec::SummaryRequestOptions {
                session_id: Some("compact-session".to_string()),
                retry: Some(crate::session_engine::provider_retry::ProviderRetryPolicy {
                    enabled: true,
                    max_retries: 3,
                    base_delay_ms: 1,
                    max_retry_delay_ms: 50,
                    max_delay_ms: crate::session_engine::provider_retry::UNBOUNDED_BACKOFF_MS,
                }),
            },
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run after the retry");
    };
    assert!(run.result.summary.contains("summarized goal"));
    assert_eq!(
        *seen.lock().unwrap(),
        vec![(Some("compact-session".to_string()), None); 2]
    );
    registration.unregister();
}

/// The compaction options every summary-cancellation test shares: the
/// session id and no retry.
fn cancellation_options(
    model: pa_types::ai::Model,
    abort: Option<&pa_agent::abort::AbortSignal>,
) -> CompactOptions<'_> {
    CompactOptions {
        model,
        api_key: Some("test-key".to_string()),
        custom_instructions: None,
        settings: super::super::compaction::CompactionSettings {
            keep_recent_tokens: 20,
            ..Default::default()
        },
        abort,
        harness_digest: None,
        auxiliary: None,
        summary_delta: None,
        summary_requests: crate::session_engine::compaction_exec::SummaryRequestOptions {
            session_id: Some("compact-cancel".to_string()),
            retry: None,
        },
    }
}

/// A summary the provider settled as aborted (the session that owns the
/// request was disposed, with no abort on the compaction run itself) is
/// never a summary: the compaction fails as cancelled and commits nothing.
/// It used to commit the reply's partial (here empty) text as the summary.
#[tokio::test]
async fn an_aborted_summary_reply_commits_no_compaction() {
    let registration = faux_registration();
    let mut aborted = pa_ai::faux::faux_assistant_text_message(
        "",
        pa_ai::faux::FauxAssistantMessageOptions::default(),
    );
    aborted.stop_reason = pa_types::ai::StopReason::Aborted;
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(aborted)]);
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let outcome = execute_compaction(
        &mut session,
        cancellation_options(registration.get_model(), None),
    )
    .await;
    assert!(
        outcome.as_ref().is_err_and(pa_agent::abort::is_abort_error),
        "{:?}",
        outcome.map(|_| ())
    );
    assert!(!session
        .get_entries()
        .iter()
        .any(|entry| matches!(entry, FileEntry::Compaction { .. })));
    registration.unregister();
}

/// The run's abort reaches the summary's provider request (TS passes the
/// signal to `completeSimple`): a summary held on the session's Responses
/// WebSocket ends at the abort and its socket closes, instead of the
/// request running on after the compaction gave up (only the retry waits
/// used to see the abort).
#[tokio::test]
async fn an_abort_cancels_the_held_summary_request() {
    use pa_ai::test_support::{spawn, Record, Turn, Upgrade};
    let mut server = spawn(vec![Upgrade::Accept(vec![Turn::Stall])], Vec::new()).await;
    let model: pa_types::ai::Model = serde_json::from_value(serde_json::json!({
        "id": "gpt-ws", "name": "gpt-ws", "api": "openai-responses", "provider": "cpa-r",
        "baseUrl": server.base_url, "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 100_000, "maxTokens": 1000,
        "compat": { "supportsWebSocket": true },
    }))
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let controller = pa_agent::abort::AbortController::new();
    let signal = controller.signal();
    let compaction = execute_compaction(&mut session, cancellation_options(model, Some(&signal)));
    let abort_once_held = async {
        assert!(matches!(
            server.next_request().await,
            Record::Upgrade { connection: 1, .. }
        ));
        assert!(matches!(
            server.next_request().await,
            Record::WsRequest { connection: 1, .. }
        ));
        controller.abort();
    };
    let (outcome, ()) = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        tokio::join!(compaction, abort_once_held)
    })
    .await
    .expect("the aborted compaction settles");
    assert!(
        outcome.as_ref().is_err_and(pa_agent::abort::is_abort_error),
        "{:?}",
        outcome.map(|_| ())
    );
    assert_eq!(server.closed(1).await.as_deref(), Some("done"));
}

/// One complete Responses text reply as wire events.
fn ws_text_response(id: &str, text: &str) -> Vec<serde_json::Value> {
    let item_id = format!("msg_{id}");
    vec![
        serde_json::json!({ "type": "response.created", "response": { "id": id } }),
        serde_json::json!({
            "type": "response.output_item.added", "output_index": 0,
            "item": { "type": "message", "id": item_id, "role": "assistant",
                      "status": "in_progress", "content": [] },
        }),
        serde_json::json!({
            "type": "response.content_part.added", "output_index": 0, "content_index": 0,
            "part": { "type": "output_text", "text": "" },
        }),
        serde_json::json!({
            "type": "response.output_text.delta", "output_index": 0, "content_index": 0,
            "delta": text,
        }),
        serde_json::json!({
            "type": "response.output_item.done",
            "item": { "type": "message", "id": item_id, "role": "assistant", "status": "completed",
                      "content": [{ "type": "output_text", "text": text }] },
        }),
        serde_json::json!({
            "type": "response.completed",
            "response": { "id": id, "status": "completed",
                          "usage": { "input_tokens": 5, "output_tokens": 3, "total_tokens": 8 } },
        }),
    ]
}

/// Generation, then a real compaction summary, then a generation on one
/// session's Responses WebSocket: the summary does not continue the
/// generation's anchor (its body differs) and replaces it, so the next
/// generation, whose input would have continued the first one, goes out
/// in full on the same socket (TS `cachedBody` invalidation).
#[tokio::test]
async fn a_summary_between_generations_invalidates_the_continuation() {
    use pa_ai::test_support::{spawn, Record, Turn, Upgrade};
    let mut server = spawn(
        vec![Upgrade::Accept(vec![
            Turn::Events(ws_text_response("resp_gen_1", "first answer")),
            Turn::Events(ws_text_response("resp_summary", "## Goal\nsummarized goal")),
            Turn::Events(ws_text_response("resp_gen_2", "second answer")),
        ])],
        Vec::new(),
    )
    .await;
    let model: pa_types::ai::Model = serde_json::from_value(serde_json::json!({
        "id": "gpt-ws", "name": "gpt-ws", "api": "openai-responses", "provider": "cpa-r",
        "baseUrl": server.base_url, "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 100_000, "maxTokens": 1000,
        "compat": { "supportsWebSocket": true },
    }))
    .unwrap();
    let generation_options = || {
        pa_ai::types::SimpleStreamOptions::from_base(pa_ai::types::StreamOptions {
            api_key: Some("test-key".to_string()),
            session_id: Some("compact-chain".to_string()),
            ..pa_ai::types::StreamOptions::default()
        })
    };
    let user = |text: &str| {
        pa_types::ai::Message::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 1,
            rest: serde_json::Map::default(),
        })
    };
    let first_context = pa_types::ai::Context {
        system_prompt: None,
        messages: vec![user("one")],
        tools: None,
    };
    let first = pa_ai::complete_simple(&model, &first_context, Some(generation_options()))
        .await
        .unwrap();
    assert_eq!(first.stop_reason, pa_types::ai::StopReason::Stop);

    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let mut options = cancellation_options(model.clone(), None);
    options.summary_requests.session_id = Some("compact-chain".to_string());
    let outcome = execute_compaction(&mut session, options).await.unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run");
    };
    assert!(run.result.summary.contains("summarized goal"));

    let second_context = pa_types::ai::Context {
        system_prompt: None,
        messages: vec![
            user("one"),
            pa_types::ai::Message::Assistant(first),
            user("two"),
        ],
        tools: None,
    };
    let second = pa_ai::complete_simple(&model, &second_context, Some(generation_options()))
        .await
        .unwrap();
    assert_eq!(second.stop_reason, pa_types::ai::StopReason::Stop);

    let requests: Vec<(usize, Option<String>, usize)> = server
        .drain()
        .into_iter()
        .filter_map(|record| match record {
            Record::WsRequest { connection, body } => Some((
                connection,
                body.get("previous_response_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                body.get("input")
                    .and_then(serde_json::Value::as_array)
                    .map_or(0, Vec::len),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(requests.len(), 3, "{requests:?}");
    // Generation, summary, generation: one socket, never a delta, and the
    // last generation carries its whole conversation.
    assert!(
        requests
            .iter()
            .all(|(connection, previous, _)| *connection == 1 && previous.is_none()),
        "{requests:?}"
    );
    assert_eq!(requests[0].2, 1);
    assert_eq!(requests[2].2, 3);
    pa_ai::cleanup_session_resources(Some("compact-chain"));
}
