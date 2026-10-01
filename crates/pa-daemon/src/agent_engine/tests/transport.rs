//! The session transport preference across the engine's provider targets.
use super::*;

/// A target on the `sse` transport for `model_id`.
fn sse_target(model_id: &str) -> ProviderTarget {
    ProviderTarget {
        api_key: None,
        model: serde_json::from_value(json!({
            "id": model_id, "name": model_id, "api": "openai-responses", "provider": "cpa-r",
            "baseUrl": "http://127.0.0.1:9/v1", "reasoning": false, "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 100_000, "maxTokens": 1000,
        }))
        .expect("test model"),
        service_tier: None,
        headers: None,
        transport: Some(pa_types::ai::Transport::Sse),
    }
}

/// The live transport switch (`set_transport`) reaches an armed image
/// route's stored targets: a failover switch or the episode-settle restore
/// reinstalls them later in the episode, and they used to keep the
/// transport from before the switch.
#[test]
fn a_transport_switch_reaches_the_armed_image_route() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = bare_engine(dir.path());
    *engine.provider_target.write().unwrap() = Some(sse_target("session-model"));
    *engine.image_route.lock().unwrap() = Some(crate::image_route::ImageRoute {
        target: sse_target("image-model"),
        agent_override: pa_agent::agent::AgentModelOverride {
            model: pa_agent::types::Model::unknown(),
            thinking_level: pa_agent::types::ThinkingLevel::Off,
        },
        session_target: Some(sse_target("session-model")),
    });
    engine.configure_transport(pa_types::ai::Transport::WebsocketCached);
    let cached = Some(pa_types::ai::Transport::WebsocketCached);
    let route = engine
        .image_route
        .lock()
        .unwrap()
        .clone()
        .expect("the route stays armed");
    assert_eq!(
        (
            route.target.transport,
            route.session_target.and_then(|target| target.transport),
            engine
                .provider_target
                .read()
                .unwrap()
                .as_ref()
                .and_then(|target| target.transport),
            *engine.transport.read().unwrap(),
        ),
        (cached, cached, cached, cached)
    );
}

/// A route snapshot taken before a transport switch installs on the
/// session's current transport: the install reads the transport under the
/// provider slot's lock instead of trusting the clone it carried (a switch
/// that landed between the clone and the install used to be undone).
#[test]
fn a_stale_route_snapshot_installs_on_the_current_transport() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = bare_engine(dir.path());
    *engine.provider_target.write().unwrap() = Some(sse_target("session-model"));
    *engine.image_route.lock().unwrap() = Some(crate::image_route::ImageRoute {
        target: sse_target("image-model"),
        agent_override: pa_agent::agent::AgentModelOverride {
            model: pa_agent::types::Model::unknown(),
            thinking_level: pa_agent::types::ThinkingLevel::Off,
        },
        session_target: None,
    });
    // The switch's state, as it stands after it landed past the snapshot.
    *engine.transport.write().unwrap() = Some(pa_types::ai::Transport::Websocket);
    let agent = std::sync::Arc::new(pa_agent::agent::Agent::new(
        pa_agent::agent::AgentOptions::default(),
    ));
    engine.apply_armed_image_route(&agent);
    let installed = engine
        .provider_target
        .read()
        .unwrap()
        .clone()
        .expect("the routed target serves");
    assert_eq!(
        (installed.model.id.as_str(), installed.transport),
        ("image-model", Some(pa_types::ai::Transport::Websocket))
    );
}
