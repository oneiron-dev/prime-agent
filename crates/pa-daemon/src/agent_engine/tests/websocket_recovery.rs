//! Generic cpa-r recovery: ordinary 1012 closes remain session-owned;
//! exact caps refresh once at the session rollback boundary, outside the retry budget.
use super::*;

#[test]
fn service_restart_after_lifecycle_or_partial_text_uses_the_existing_transport_wait() {
    let mut partial = vec![created("resp_cut")];
    partial.extend(text_item("resp_cut", "cut off").into_iter().take(3));
    for interrupted in [vec![created("resp_cut")], partial] {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut server = runtime.block_on(spawn(
            vec![
                Upgrade::Accept(vec![
                    Turn::Events(text_response("resp_anchor", "first")),
                    Turn::EventsThenClose(interrupted, 1012, "service restart"),
                ]),
                Upgrade::Accept(vec![Turn::Events(text_response("resp_done", "done"))]),
            ],
            Vec::new(),
        ));
        let (engine, _dir) = websocket_engine(&server, "openai-responses");
        let mut first = Vec::new();
        admit(&engine, "one".to_string(), &mut first);
        let mut events = Vec::new();
        admit(&engine, "two".to_string(), &mut events);
        assert_eq!(retry_events(&events), vec![(true, 1), (false, 1)]);
        assert!(events.iter().any(|event| matches!(
            event,
            EngineEvent::AutoRetryStart {
                delay_ms: 2000,
                max_attempts: 3,
                ..
            }
        )));
        let failed = events
            .iter()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) if message["stopReason"] == "error" => {
                    Some(message)
                }
                _ => None,
            })
            .expect("1012 remains a transport failure");
        assert!(failed["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| {
                diagnostic["type"] == "provider_stream_failure"
                    && diagnostic["details"]["kind"] == "transport"
                    && diagnostic["details"]["transport"]["closeCode"] == 1012
            }));
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("done")
        );
        let (observed, bodies) = seen(server.drain());
        let inputs = bodies[0]["input"].as_array().unwrap().len();
        assert_eq!(
            observed,
            vec![
                Seen::Upgrade(1),
                Seen::Ws {
                    connection: 1,
                    previous: None,
                    inputs
                },
                Seen::Ws {
                    connection: 1,
                    previous: Some("resp_anchor".to_string()),
                    inputs: 1
                },
                Seen::Upgrade(2),
                Seen::Ws {
                    connection: 2,
                    previous: None,
                    inputs: inputs + 2
                },
            ]
        );
        let replay = bodies[2].to_string();
        assert!(!replay.contains("resp_cut"), "{replay}");
        assert!(!replay.contains("cut off"), "{replay}");
    }
}

#[test]
fn service_restart_does_not_repeat_a_committed_tool_or_execute_a_cut_call() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut cut = tool_call("resp_cut", "call_cut", "cut");
    cut.pop();
    let mut server = runtime.block_on(spawn(
        vec![
            Upgrade::Accept(vec![
                Turn::Events(tool_call("resp_tool", "call_once", "once")),
                Turn::EventsThenClose(cut, 1012, "service restart"),
            ]),
            Upgrade::Accept(vec![Turn::Events(text_response("resp_done", "done"))]),
        ],
        Vec::new(),
    ));
    let (engine, _dir) = websocket_engine(&server, "openai-responses");
    let runs = install_probe(&engine);
    let mut events = Vec::new();
    admit(&engine, "run the tool".to_string(), &mut events);
    assert_eq!(*runs.lock().unwrap(), vec!["once".to_string()]);
    let dispatched: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::ToolExecutionStart { tool_call_id, .. } => Some(tool_call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(dispatched, vec!["call_once|fc_resp_tool"]);
    assert_eq!(retry_events(&events), vec![(true, 1), (false, 1)]);
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::AutoRetryStart {
            delay_ms: 2000,
            max_attempts: 3,
            ..
        }
    )));
    let (observed, bodies) = seen(server.drain());
    let inputs = bodies[0]["input"].as_array().unwrap().len();
    assert_eq!(
        observed,
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs
            },
            Seen::Ws {
                connection: 1,
                previous: Some("resp_tool".to_string()),
                inputs: 1
            },
            Seen::Upgrade(2),
            Seen::Ws {
                connection: 2,
                previous: None,
                inputs: inputs + 2
            },
        ]
    );
    let replay = bodies[2]["input"].as_array().unwrap();
    assert_eq!(
        replay
            .iter()
            .filter(|item| item["type"] == "function_call")
            .count(),
        1
    );
    assert_eq!(
        replay
            .iter()
            .filter(|item| item["type"] == "function_call_output")
            .count(),
        1
    );
    let replay = bodies[2].to_string();
    assert!(replay.contains("call_once"), "{replay}");
    assert!(replay.contains("probe ran once"), "{replay}");
    assert!(!replay.contains("call_cut"), "{replay}");
    assert_eq!(
        assistant_texts(&events).last().map(String::as_str),
        Some("done")
    );
}

fn flat_cap() -> Value {
    json!({ "type": "error", "code": "websocket_connection_limit_reached", "message": "aged connection" })
}

fn assert_connection_reset(events: &[EngineEvent]) {
    use pa_core::session_engine::auto_retry::RetryStartReason;
    let starts: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::AutoRetryStart {
                attempt,
                max_attempts,
                delay_ms,
                reason,
                ..
            } => Some((*attempt, *max_attempts, *delay_ms, reason.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(starts, vec![(1, 1, 0, RetryStartReason::ConnectionReset)]);
    assert_eq!(retry_events(events), vec![(true, 1), (false, 0)]);
}

#[test]
fn a_pre_content_cap_with_or_without_metadata_refreshes_the_full_request() {
    for rejection in [vec![flat_cap()], vec![created("resp_rejected"), flat_cap()]] {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut server = runtime.block_on(spawn(
            vec![
                Upgrade::Accept(vec![Turn::Events(rejection)]),
                Upgrade::Accept(vec![Turn::Events(text_response("resp_done", "done"))]),
            ],
            vec![SseReply::Events(text_response("resp_sse", "never"))],
        ));
        let (engine, _dir) = websocket_engine(&server, "openai-responses");
        let mut events = Vec::new();
        admit(&engine, "hello".to_string(), &mut events);
        assert_connection_reset(&events);
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("done")
        );
        let (observed, bodies) = seen(server.drain());
        let inputs = bodies[0]["input"].as_array().unwrap().len();
        assert_eq!(
            observed,
            vec![
                Seen::Upgrade(1),
                Seen::Ws {
                    connection: 1,
                    previous: None,
                    inputs
                },
                Seen::Upgrade(2),
                Seen::Ws {
                    connection: 2,
                    previous: None,
                    inputs
                },
            ]
        );
        assert_eq!(bodies[0], bodies[1]);
        assert!(!bodies[1].to_string().contains("resp_rejected"));
    }
}

#[test]
fn a_cap_after_a_committed_tool_refreshes_without_another_side_effect() {
    for cap in [
        json!({ "type": "error", "status": 400,
                "error": { "type": "invalid_request_error", "code": "websocket_connection_limit_reached", "message": "aged connection" } }),
        flat_cap(),
    ] {
        assert_tool_cap_recovery(vec![created("resp_rejected"), cap]);
    }
}

#[test]
fn a_post_content_cap_rolls_back_partial_text_and_fully_streamed_cut_calls() {
    let mut partial = vec![created("resp_rejected")];
    partial.extend(
        text_item("resp_rejected", "failed partial")
            .into_iter()
            .take(3),
    );
    partial.push(flat_cap());
    let mut cut_call = tool_call("resp_rejected", "call_cut", "cut");
    cut_call.pop(); // Fully streamed, but no terminal response: never committed.
    cut_call.push(flat_cap());
    for rejected in [partial, cut_call] {
        assert_tool_cap_recovery(rejected);
    }
}

// The same real session seam owns lifecycle-only and post-content cap rollback.
#[allow(clippy::too_many_lines)]
fn assert_tool_cap_recovery(rejected: Vec<Value>) {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut server = runtime.block_on(spawn(
        vec![
            Upgrade::Accept(vec![
                Turn::Events(tool_call("resp_tool", "call_once", "once")),
                Turn::Events(rejected),
            ]),
            Upgrade::Accept(vec![
                Turn::Events(text_response("resp_done", "done")),
                Turn::Events(text_response("resp_after", "after")),
            ]),
        ],
        vec![SseReply::Events(text_response("resp_sse", "never"))],
    ));
    let (engine, _dir) = websocket_engine(&server, "openai-responses");
    let runs = install_probe(&engine);
    let mut events = Vec::new();
    admit(&engine, "run the tool".to_string(), &mut events);
    assert_eq!(*runs.lock().unwrap(), vec!["once".to_string()]);
    let dispatched: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::ToolExecutionStart { tool_call_id, .. } => Some(tool_call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(dispatched, vec!["call_once|fc_resp_tool"]);
    assert_connection_reset(&events);
    let successful_texts: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::AssistantMessage(message)
                if message["stopReason"] != "error" && message["stopReason"] != "aborted" =>
            {
                Some(message["content"][0]["text"].as_str().unwrap_or_default())
            }
            _ => None,
        })
        .collect();
    assert_eq!(successful_texts, vec!["", "done"]);
    let (observed, bodies) = seen(server.drain());
    let inputs = bodies[0]["input"].as_array().unwrap().len();
    assert_eq!(
        observed,
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs
            },
            Seen::Ws {
                connection: 1,
                previous: Some("resp_tool".to_string()),
                inputs: 1
            },
            Seen::Upgrade(2),
            Seen::Ws {
                connection: 2,
                previous: None,
                inputs: inputs + 2
            },
        ]
    );
    let replay = bodies[2]["input"].as_array().unwrap();
    assert_eq!(
        replay
            .iter()
            .filter(|item| item["type"] == "function_call")
            .count(),
        1
    );
    assert_eq!(
        replay
            .iter()
            .filter(|item| item["type"] == "function_call_output")
            .count(),
        1
    );
    let replay = bodies[2].to_string();
    assert!(replay.contains("call_once"), "{replay}");
    assert!(replay.contains("probe ran once"), "{replay}");
    for excluded in ["resp_rejected", "failed partial", "call_cut"] {
        assert!(!replay.contains(excluded), "{replay}");
    }
    // The live retry drops the failed generation. Rebuild retains audit rows,
    // but the provider's effective history must still continue the good anchor.
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().unwrap();
        engine.runtime.block_on(async {
            let state = core.session.agent().state().await;
            let live = serde_json::to_string(&state.messages).unwrap();
            for excluded in ["resp_rejected", "failed partial", "call_cut"] {
                assert!(!live.contains(excluded), "{live}");
            }
            assert!(live.contains("probe ran once"), "{live}");
            assert!(live.contains("done"), "{live}");
            let persistence = core.session.shared_persistence();
            let entries = persistence.lock().await.get_entries();
            let terminal = pa_core::session_engine::headless::select_from_entries(&entries);
            assert_eq!(
                terminal.primary.unwrap().stdout_text().as_deref(),
                Some("done")
            );
            core.session.rebuild_branch_context(entries).await.unwrap();
        });
    }
    let mut continued = Vec::new();
    admit(&engine, "next".to_string(), &mut continued);
    assert_eq!(assistant_texts(&continued), vec!["after".to_string()]);
    assert!(retry_events(&continued).is_empty());
    assert_eq!(*runs.lock().unwrap(), vec!["once".to_string()]);
    let (observed, bodies) = seen(server.drain());
    assert_eq!(
        observed,
        vec![Seen::Ws {
            connection: 2,
            previous: Some("resp_done".to_string()),
            inputs: 1,
        }]
    );
    for excluded in ["resp_rejected", "failed partial", "call_cut"] {
        assert!(!bodies[0].to_string().contains(excluded));
    }
}

#[test]
fn repeated_flat_caps_stop_after_one_refresh_without_walking_a_configured_backup() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut server = runtime.block_on(spawn(
        vec![
            Upgrade::Accept(vec![Turn::Events(vec![flat_cap()])]),
            Upgrade::Accept(vec![Turn::Events(vec![flat_cap()])]),
        ],
        vec![SseReply::Events(text_response("resp_sse", "never"))],
    ));
    let mut backup = runtime.block_on(spawn(
        vec![Upgrade::Accept(vec![Turn::Events(text_response(
            "resp_backup",
            "never",
        ))])],
        Vec::new(),
    ));
    let (engine, dir) = websocket_engine_with_backup(&server, "openai-responses", Some(&backup));
    let agent_dir = dir.path().join("agent");
    let registry = pa_core::models::ModelRegistry::create(
        pa_core::auth::AuthStorage::create(&agent_dir),
        agent_dir.join("models.json"),
    );
    let available: Vec<_> = registry.get_available().into_iter().cloned().collect();
    let candidates =
        pa_core::models::failover_candidates(&engine.resolve_model().unwrap(), &available);
    assert_eq!(
        candidates
            .iter()
            .map(|model| model.provider.as_str())
            .collect::<Vec<_>>(),
        vec!["backup"]
    );
    let mut events = Vec::new();
    admit(&engine, "hello".to_string(), &mut events);
    assert_connection_reset(&events);
    assert!(backup.drain().is_empty(), "a cap never switches providers");
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::AutoRetryEnd {
            success: false,
            attempt: 0,
            final_error: Some(_),
            restored_model: None,
        }
    )));
    let failed: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::AssistantMessage(message) if message["stopReason"] == "error" => {
                Some(message)
            }
            _ => None,
        })
        .collect();
    assert_eq!(failed.len(), 2);
    assert!(failed.iter().all(
        |message| message["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["type"] == "provider_stream_failure"
                && diagnostic["details"]["kind"] == "connection_limit"
                && diagnostic["details"]["providerErrorCode"]
                    == "websocket_connection_limit_reached")
    ));
    let (observed, bodies) = seen(server.drain());
    let inputs = bodies[0]["input"].as_array().unwrap().len();
    assert_eq!(
        observed,
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs
            },
            Seen::Upgrade(2),
            Seen::Ws {
                connection: 2,
                previous: None,
                inputs
            },
        ]
    );
    assert_eq!(bodies[0], bodies[1]);
}

#[test]
fn cancellation_at_connection_reset_prevents_a_second_request() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut server = runtime.block_on(spawn(
        vec![Upgrade::Accept(vec![Turn::Events(vec![flat_cap()])])],
        vec![SseReply::Events(text_response("resp_sse", "never"))],
    ));
    let (engine, _dir) = websocket_engine(&server, "openai-responses");
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let mut events = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "hello".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| cancelled.load(std::sync::atomic::Ordering::SeqCst),
        &mut |event| {
            if matches!(
                &event,
                EngineEvent::AutoRetryStart {
                    reason: pa_core::session_engine::auto_retry::RetryStartReason::ConnectionReset,
                    ..
                }
            ) {
                cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            events.push(event);
            true
        },
    );
    assert_connection_reset(&events);
    assert!(events
        .iter()
        .any(|event| matches!(event, EngineEvent::AutoRetryEnd {
        success: false, attempt: 0, final_error: Some(error), ..
    } if error == "Retry cancelled")));
    let (observed, bodies) = seen(server.drain());
    assert_eq!(
        observed,
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: bodies[0]["input"].as_array().unwrap().len()
            },
        ]
    );
    assert_eq!(bodies.len(), 1);
}

#[test]
fn a_cap_between_transport_failures_preserves_the_two_four_eight_second_ladder() {
    use pa_core::session_engine::auto_retry::RetryStartReason;
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let dropped = || Turn::EventsThenFin(vec![created("resp_cut")]);
    let mut server = runtime.block_on(spawn(
        vec![
            Upgrade::Accept(vec![dropped()]),
            Upgrade::Accept(vec![dropped()]),
            Upgrade::Accept(vec![Turn::Events(vec![flat_cap()])]),
            Upgrade::Accept(vec![dropped()]),
            Upgrade::Accept(vec![Turn::Events(text_response("resp_done", "done"))]),
        ],
        vec![SseReply::Events(text_response("resp_sse", "never"))],
    ));
    let (engine, _dir) = websocket_engine(&server, "openai-responses");
    let mut events = Vec::new();
    admit(&engine, "hello".to_string(), &mut events);
    let starts: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::AutoRetryStart {
                attempt,
                max_attempts,
                delay_ms,
                reason,
                ..
            } => Some((*attempt, *max_attempts, *delay_ms, reason.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        starts,
        vec![
            (1, 3, 2000, RetryStartReason::Quick),
            (2, 3, 4000, RetryStartReason::Quick),
            (1, 1, 0, RetryStartReason::ConnectionReset),
            (3, 3, 8000, RetryStartReason::Quick),
        ]
    );
    assert_eq!(
        retry_events(&events),
        vec![(true, 1), (true, 2), (true, 1), (true, 3), (false, 3)]
    );
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::AutoRetryEnd {
            success: true,
            attempt: 3,
            final_error: None,
            restored_model: None,
        }
    )));
    let (observed, bodies) = seen(server.drain());
    let inputs = bodies[0]["input"].as_array().unwrap().len();
    let expected: Vec<_> = (1..=5)
        .flat_map(|connection| {
            [
                Seen::Upgrade(connection),
                Seen::Ws {
                    connection,
                    previous: None,
                    inputs,
                },
            ]
        })
        .collect();
    assert_eq!(observed, expected);
    assert_eq!(bodies.len(), 5);
    assert!(bodies.iter().all(|body| body == &bodies[0]));
}
