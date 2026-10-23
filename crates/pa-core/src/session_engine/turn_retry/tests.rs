use super::super::provider_failover::{
    run_turn_with_provider_failover, DEFAULT_PROVIDER_FAILOVER_POLICY,
};
use super::super::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY;
use super::super::semantic_edges::SemanticEdgeIdentity;
use super::*;
use crate::session::manager::SessionManager;
use pa_agent::agent::{Agent, AgentOptions};
use pa_agent::scripted::ScriptedProvider;
use pa_agent::types::Model;

fn provider_model() -> pa_types::ai::Model {
    serde_json::from_value(serde_json::json!({
        "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
        "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 1000, "maxTokens": 100,
    }))
    .unwrap()
}

fn model() -> Model {
    json_round_trip(&provider_model()).expect("the loop model accepts the provider model")
}

fn recorder() -> Arc<SemanticEdgeRecorder> {
    Arc::new(SemanticEdgeRecorder::open(SemanticEdgeIdentity {
        session_id: "retry-test".to_string(),
        ledger_path: None,
        parent_session_id: None,
        spawned_by_request_id: None,
    }))
}

#[tokio::test]
async fn exceptional_retry_settlement_clears_parked_ids_in_both_drivers() {
    for failover in [false, true] {
        for emit_fails in [false, true] {
            let session = AgentSession::new(
                Arc::new(Agent::new(AgentOptions::default())),
                SessionManager::in_memory(&std::env::temp_dir()),
                vec![],
            )
            .await
            .unwrap();
            let recorder = recorder();
            session.set_semantic_edges(Some(Arc::clone(&recorder)));
            let original = recorder.start_turn_request([7; 32]).unwrap();
            let mut attempts = 0;
            let mut observed = Vec::new();
            let mut steps =
                pa_agent::scripted::stream_failure_steps(&model(), "partial", "provider down");
            let failure = match steps.pop().unwrap() {
                pa_agent::scripted::ScriptStep::Event(event) => {
                    event.terminal_message().unwrap().clone()
                }
                pa_agent::scripted::ScriptStep::SleepMs(_) => unreachable!(),
            };
            let episode = RetryEpisode::default();
            let result = {
                let scope = session.retry_scope();
                let attempt = || {
                    attempts += 1;
                    std::future::ready(if attempts == 1 {
                        Ok(failure.clone())
                    } else {
                        Err(anyhow::anyhow!("attempt failed"))
                    })
                };
                let emit = |event: AutoRetryEvent| {
                    scope.observe(&event);
                    observed.push(event);
                    std::future::ready(if emit_fails {
                        Err(anyhow::anyhow!("emit failed"))
                    } else {
                        Ok(())
                    })
                };
                if failover {
                    let candidate = provider_model();
                    run_turn_with_provider_failover(
                        &DEFAULT_PROVIDER_RETRY_POLICY,
                        &DEFAULT_PROVIDER_FAILOVER_POLICY,
                        &[candidate],
                        1000,
                        None,
                        &episode,
                        attempt,
                        emit,
                        |_| async { true },
                        |_| async { Ok(()) },
                        || async { Ok(None) },
                        None,
                    )
                    .await
                } else {
                    run_turn_with_auto_retry(
                        &DEFAULT_PROVIDER_RETRY_POLICY,
                        1000,
                        None,
                        &episode,
                        attempt,
                        emit,
                        |_| async { true },
                        None,
                    )
                    .await
                }
            };
            assert_eq!(
                result.unwrap_err().to_string(),
                if emit_fails {
                    "emit failed"
                } else {
                    "attempt failed"
                }
            );
            assert_eq!(observed.len(), 1);
            assert!(matches!(observed[0], AutoRetryEvent::Start { .. }));
            assert_ne!(recorder.start_turn_request([7; 32]).unwrap(), original);
        }
    }
}

#[tokio::test]
async fn direct_prompt_emit_failure_finalizes_semantic_parking() {
    let dir = tempfile::tempdir().unwrap();
    let provider = Arc::new(ScriptedProvider::new(model()));
    provider.push_stream_failure_turn("partial", "provider down");
    let engine = Arc::new(
        super::super::engine::create_session(super::super::engine::SessionEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            model: Some(model()),
            stream_fn: Some(provider.stream_fn()),
            tool_selection: super::super::tool_selection::ToolSelection::NoTools,
            custom_system_prompt: Some("test".to_string()),
            ..Default::default()
        })
        .await
        .unwrap(),
    );
    let recorder = recorder();
    engine
        .session
        .set_semantic_edges(Some(Arc::clone(&recorder)));
    let original = recorder.start_turn_request([9; 32]).unwrap();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let events = Arc::clone(&observed);
    let result = engine
        .run_prompt_with_retry(
            1000,
            "hello",
            &[],
            &DEFAULT_PROVIDER_RETRY_POLICY,
            &AbortSignal::never(),
            move |update| {
                events.lock().unwrap().push(update.event);
                std::future::ready(Err(anyhow::anyhow!("output failed")))
            },
        )
        .await;
    assert_eq!(result.unwrap_err().to_string(), "output failed");
    assert_eq!(provider.calls().len(), 1);
    assert_eq!(observed.lock().unwrap().len(), 1);
    assert_ne!(recorder.start_turn_request([9; 32]).unwrap(), original);
    engine.abandon_kernel();
}
