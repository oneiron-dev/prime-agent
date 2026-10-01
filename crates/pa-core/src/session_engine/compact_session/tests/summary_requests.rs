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
