//! Structured cap verdicts and acquisition-only socket age rotation.
use super::*;
use crate::event_stream::AssistantMessageEvent;

fn cap_400() -> Value {
    json!({
        "type": "error", "status": 400,
        "error": { "type": "invalid_request_error", "code": "websocket_connection_limit_reached",
                   "message": "connection reached its age limit" },
    })
}

fn flat_cap() -> Value {
    json!({
        "type": "error", "code": "websocket_connection_limit_reached",
        "message": "connection reached its age limit",
    })
}

#[tokio::test]
async fn exact_caps_return_a_structured_failure_with_start_and_no_inline_request_or_sse() {
    for (session, rejection, response_id, status) in [
        ("cap-400", vec![cap_400()], None, Some(400)),
        ("cap-flat", vec![flat_cap()], None, None),
        (
            "cap-metadata",
            vec![
                json!({ "type": "response.created", "response": { "id": "resp_rejected" } }),
                flat_cap(),
            ],
            Some("resp_rejected"),
            None,
        ),
    ] {
        let mut server = mock_server::spawn(
            vec![Upgrade::Accept(vec![Turn::Events(rejection)])],
            vec![SseReply::Events(response("resp_sse", "never"))],
        )
        .await;
        let events = stream_openai_responses(
            &ws_model(&server),
            &context(vec![user("one")]),
            Some(&options(Some(session), None)),
        )
        .collect()
        .await;
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, AssistantMessageEvent::Start { .. }))
                .count(),
            1,
        );
        let Some(AssistantMessageEvent::Error { error, .. }) = events.last() else {
            panic!("the session, not the provider, owns cap recovery: {events:?}");
        };
        assert_eq!(
            (
                error.stop_reason,
                error.response_id.as_deref(),
                error.content.len()
            ),
            (StopReason::Error, response_id, 0),
        );
        let details = diagnostic(error, "provider_stream_failure").unwrap()["details"].clone();
        assert_eq!(details["kind"], "connection_limit");
        assert_eq!(
            details["providerErrorCode"],
            "websocket_connection_limit_reached"
        );
        assert_eq!(details.get("status").and_then(Value::as_u64), status);
        assert_eq!(
            seen(server.drain()),
            vec![
                Seen::Upgrade(1),
                Seen::Ws {
                    connection: 1,
                    previous: None,
                    inputs: 1
                }
            ],
        );
        crate::cleanup_session_resources(Some(session));
    }
}

#[tokio::test]
async fn an_unrelated_400_with_cap_text_does_not_reset_the_socket() {
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![Turn::Events(vec![json!({
            "type": "error", "status": 400,
            "error": { "type": "invalid_request_error", "code": "bad_input",
                       "message": "not websocket_connection_limit_reached" },
        })])])],
        vec![SseReply::Events(response("resp_sse", "never"))],
    )
    .await;
    let message = run(
        &ws_model(&server),
        &context(vec![user("one")]),
        &options(Some("cap-unrelated"), None),
    )
    .await;
    assert_eq!(message.stop_reason, StopReason::Error);
    assert_eq!(
        diagnostic(&message, "provider_stream_failure").unwrap()["details"]["kind"],
        "invalid_request"
    );
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
        ]
    );
}

#[tokio::test]
async fn a_cap_preserves_failed_partial_content_for_session_rollback() {
    let mut partial =
        vec![json!({ "type": "response.created", "response": { "id": "resp_partial" } })];
    partial.extend(text_item("resp_partial", "partial").into_iter().take(3));
    partial.push(flat_cap());
    let mut server = mock_server::spawn(
        vec![Upgrade::Accept(vec![Turn::Events(partial)])],
        vec![SseReply::Events(response("resp_sse", "never"))],
    )
    .await;
    let message = run(
        &ws_model(&server),
        &context(vec![user("one")]),
        &options(Some("cap-after-content"), None),
    )
    .await;
    assert_eq!(
        (message.stop_reason, text_of(&message)),
        (StopReason::Error, "partial".to_string())
    );
    assert_eq!(
        diagnostic(&message, "provider_stream_failure").unwrap()["details"]["kind"],
        "connection_limit"
    );
    assert_eq!(
        seen(server.drain()),
        vec![
            Seen::Upgrade(1),
            Seen::Ws {
                connection: 1,
                previous: None,
                inputs: 1
            },
        ]
    );
}

#[tokio::test]
async fn frequently_active_cached_sockets_rotate_at_55_minutes_with_full_history() {
    let mut server = mock_server::spawn(
        vec![
            Upgrade::Accept(
                (0..16)
                    .map(|index| Turn::Events(response(&format!("resp_{index}"), "ok")))
                    .collect(),
            ),
            Upgrade::Accept(vec![Turn::Events(response("resp_fresh", "fresh"))]),
        ],
        Vec::new(),
    )
    .await;
    let ws = ws_model(&server);
    let request = options(Some("max-age-active"), Some(Transport::WebsocketCached));
    let mut messages = vec![user("one")];
    let mut last = run(&ws, &context(messages.clone()), &request).await;
    let connection = super::super::session::cached_connection_id("max-age-active").unwrap();
    for (index, minutes) in [4; 13].into_iter().chain([2, 1]).enumerate() {
        messages.extend([Message::Assistant(last), user("next")]);
        // Advance only between requests; activity stays below the idle TTL.
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_mins(minutes)).await;
        tokio::time::resume();
        last = run(&ws, &context(messages.clone()), &request).await;
        if index < 14 {
            assert_eq!(
                super::super::session::cached_connection_id("max-age-active"),
                Some(connection)
            );
        }
    }
    assert_eq!(text_of(&last), "fresh");
    assert_ne!(
        super::super::session::cached_connection_id("max-age-active"),
        Some(connection)
    );
    let mut expected = vec![
        Seen::Upgrade(1),
        Seen::Ws {
            connection: 1,
            previous: None,
            inputs: 1,
        },
    ];
    expected.extend((1..15).map(|index| Seen::Ws {
        connection: 1,
        previous: Some(format!("resp_{}", index - 1)),
        inputs: 1,
    }));
    expected.extend([
        Seen::Upgrade(2),
        Seen::Ws {
            connection: 2,
            previous: None,
            inputs: 31,
        },
    ]);
    assert_eq!(seen(server.drain()), expected);
    crate::cleanup_session_resources(Some("max-age-active"));
}
