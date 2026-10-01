//! The Oneiron fleet's `models.json` loads unchanged through the registry
//! path the CLI and daemon use (`ModelRegistry::create` over
//! `<agent_dir>/models.json`). The fixture is the production file with its
//! API keys and proxy host replaced; everything else (the three CPA
//! providers, provider- and model-level compat including the fork-only
//! transport keys, thinking-level maps, pricing, windows) is verbatim.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use pa_core::auth::{AuthStorage, AuthStorageData, NoOAuth};
use pa_core::models::{ModelRegistry, ResolvedRequestAuth};
use pa_types::ai::Model;
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("fixtures/oneiron-models.json");
const FIXTURE_PROVIDERS: [&str; 3] = ["cpa", "cpa-a", "cpa-r"];

/// The registry over a sandbox agent dir holding the fixture, with no
/// stored or ambient credentials (the fixture's `apiKey` is the only
/// auth source).
fn fixture_registry(agent_dir: &Path) -> ModelRegistry {
    std::fs::write(agent_dir.join("models.json"), FIXTURE).expect("write models.json");
    let auth = AuthStorage::in_memory_without_env(&AuthStorageData::default(), Arc::new(NoOAuth));
    ModelRegistry::create(auth, agent_dir.join("models.json"))
}

#[test]
fn the_fleet_models_json_loads_every_provider_and_model_unchanged() {
    let agent_dir = tempfile::tempdir().expect("agent dir");
    let registry = fixture_registry(agent_dir.path());
    assert_eq!(
        registry.get_error(),
        None,
        "models.json loads without error"
    );

    // The models the fixture declares, per provider in file order, derived
    // from the document itself: each definition plus its provider's `api`
    // and `baseUrl`, and the provider compat with the model's own compat
    // keys layered over it.
    let document: Value = serde_json::from_str(FIXTURE).expect("fixture is JSON");
    let declared: BTreeMap<String, Vec<Model>> = document["providers"]
        .as_object()
        .expect("providers")
        .iter()
        .map(|(provider, config)| {
            let models = config["models"]
                .as_array()
                .expect("models")
                .iter()
                .map(|definition| {
                    let mut model = definition.as_object().expect("model object").clone();
                    model.insert("provider".to_string(), json!(provider));
                    model.insert("api".to_string(), config["api"].clone());
                    model.insert("baseUrl".to_string(), config["baseUrl"].clone());
                    let mut compat = config
                        .get("compat")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(own) = definition.get("compat").and_then(Value::as_object) {
                        compat.extend(own.clone());
                    }
                    if !compat.is_empty() {
                        model.insert("compat".to_string(), Value::Object(compat));
                    }
                    serde_json::from_value(Value::Object(model)).expect("declared model")
                })
                .collect();
            (provider.clone(), models)
        })
        .collect();
    let counts: BTreeMap<&str, usize> = declared
        .iter()
        .map(|(provider, models)| (provider.as_str(), models.len()))
        .collect();
    assert_eq!(
        counts,
        BTreeMap::from([("cpa", 18), ("cpa-a", 4), ("cpa-r", 22)]),
        "the fixture carries the fleet's full provider/model set"
    );

    // The loaded fixture models, per provider in load order.
    let mut loaded: BTreeMap<String, Vec<Model>> = BTreeMap::new();
    for model in registry.get_all() {
        if FIXTURE_PROVIDERS.contains(&model.provider.as_str()) {
            loaded
                .entry(model.provider.clone())
                .or_default()
                .push(model.clone());
        }
    }
    assert_eq!(loaded, declared);
}

/// #3201: a custom model's own compat keys win over its provider's, and a
/// model without its own compat inherits the provider block whole; the
/// fork-only transport keys ride through untouched.
#[test]
fn model_level_compat_overrides_provider_compat() {
    let agent_dir = tempfile::tempdir().expect("agent dir");
    let registry = fixture_registry(agent_dir.path());
    let compat_of = |provider: &str, id: &str| {
        registry
            .get_all()
            .iter()
            .find(|model| model.provider == provider && model.id == id)
            .and_then(|model| model.compat.clone())
            .map(|compat| Value::Object(compat.raw))
    };
    let observed = [
        compat_of("cpa-r", "deepseek-v4-pro"),
        compat_of("cpa-r", "gpt-5.6-terra"),
        compat_of("cpa-r", "gpt-6.1-sol"),
        compat_of("cpa", "gpt-6.1-sol"),
        compat_of("cpa-a", "claude-opus-5"),
    ];
    assert_eq!(
        observed,
        [
            Some(json!({
                "supportsDeveloperRole": false,
                "supportsReasoningEffort": true,
                "supportsWebSocket": false,
                "supportsResponsesCompact": false,
                "supportsResponsesRemoteCompactionV2": false
            })),
            Some(json!({
                "supportsDeveloperRole": false,
                "supportsReasoningEffort": true,
                "supportsWebSocket": true
            })),
            Some(json!({
                "supportsDeveloperRole": false,
                "supportsReasoningEffort": true,
                "supportsWebSocket": true,
                "supportsResponsesRemoteCompactionV2": true
            })),
            Some(json!({
                "supportsDeveloperRole": false,
                "supportsReasoningEffort": true
            })),
            Some(json!({ "sendSessionAffinityHeaders": true })),
        ]
    );
}

/// Every fixture model is available on the provider's `apiKey` alone, and
/// request auth resolves that key with no extra headers.
#[test]
fn the_provider_api_key_authorizes_every_fixture_model() {
    let agent_dir = tempfile::tempdir().expect("agent dir");
    let mut registry = fixture_registry(agent_dir.path());
    let fixture_ids = |models: Vec<&Model>| {
        models
            .into_iter()
            .filter(|model| FIXTURE_PROVIDERS.contains(&model.provider.as_str()))
            .map(|model| format!("{}/{}", model.provider, model.id))
            .collect::<Vec<_>>()
    };
    let all = fixture_ids(registry.get_all().iter().collect());
    assert_eq!(all.len(), 44);
    assert_eq!(fixture_ids(registry.get_available()), all);

    let firsts: Vec<Model> = FIXTURE_PROVIDERS
        .iter()
        .map(|provider| {
            registry
                .get_all()
                .iter()
                .find(|model| model.provider == *provider)
                .cloned()
                .expect("provider model")
        })
        .collect();
    let resolved: Vec<ResolvedRequestAuth> = firsts
        .iter()
        .map(|model| registry.get_api_key_and_headers(model, None))
        .collect();
    let expected = ResolvedRequestAuth {
        ok: true,
        api_key: Some("test-key".to_string()),
        headers: None,
        error: None,
    };
    assert_eq!(resolved, vec![expected.clone(), expected.clone(), expected]);
}
