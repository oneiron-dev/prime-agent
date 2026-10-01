//! Session-affinity tests: the TS fork's `anthropic-session-affinity.test.ts`
//! (3b0e324bf, hashed in 832395413) on the real wire, the compat resolution
//! behind the opt-in, and a replay of the TS fork's own capture of the same
//! inputs (`tests/testdata/anthropic_session_affinity_ts.json`, written by
//! `tests/differential/anthropic_affinity_ts_driver.ts`).

use std::collections::HashMap;

use serde_json::{json, Value};

use super::headers::build_request_headers;
use super::request_capture::{capture_request, CapturedRequest};
use super::{get_anthropic_compat, AnthropicOptions, ResolvedAnthropicCompat};
use crate::types::{CacheRetention, Context, Model, StreamOptions};

const TS_CAPTURE: &str = include_str!("../../../tests/testdata/anthropic_session_affinity_ts.json");

/// TS-produced digests (`base64url(SHA-256(id))`, unpadded) from the
/// fixture capture.
const SESSION_123_KEY: &str = "uchDIvgkNMtG4jnSDa8fNxTutQd_h_sPDNS9M2vAG1Q";
const SESSION_456_KEY: &str = "2o54Ex16mSQDnHTDmgHgoWsaCTqk1A9EHZ4KrlMYcnU";

/// One parity case's inputs (the TS driver's `CaseInput`).
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseInput {
    provider: Option<String>,
    api_key: Option<String>,
    compat: Option<Value>,
    model_headers: Option<HashMap<String, String>>,
    session_id: Option<String>,
    cache_retention: Option<CacheRetention>,
    headers: Option<HashMap<String, String>>,
}

#[derive(serde::Deserialize)]
struct TsRequest {
    headers: Vec<(String, String)>,
    body: Value,
}

#[derive(serde::Deserialize)]
struct ParityCase {
    name: String,
    input: CaseInput,
    ts: TsRequest,
}

fn model(input: &CaseInput) -> Model {
    let mut model = json!({
        "id": "claude-test", "name": "Claude Test", "api": "anthropic-messages",
        "provider": input.provider.as_deref().unwrap_or("cpa-a"),
        "baseUrl": "https://api.anthropic.com", "reasoning": false, "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 200_000, "maxTokens": 32_000
    });
    if let Some(compat) = &input.compat {
        model["compat"] = compat.clone();
    }
    if let Some(headers) = &input.model_headers {
        model["headers"] = json!(headers);
    }
    serde_json::from_value(model).unwrap()
}

/// The TS driver's request: a system prompt, one user turn, one tool.
fn context() -> Context {
    serde_json::from_value(json!({
        "systemPrompt": "You are terse.",
        "messages": [{"role": "user", "content": "Say hello.", "timestamp": 1}],
        "tools": [{
            "name": "read", "description": "Read a file",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"]
            }
        }]
    }))
    .unwrap()
}

async fn capture(input: &CaseInput) -> CapturedRequest {
    let options = AnthropicOptions::from_base(StreamOptions {
        api_key: Some(input.api_key.clone().unwrap_or_else(|| "test-key".into())),
        session_id: input.session_id.clone(),
        cache_retention: input.cache_retention,
        headers: input.headers.clone(),
        ..Default::default()
    });
    capture_request(model(input), &context(), &options).await
}

fn opted_in(session_id: &str) -> CaseInput {
    CaseInput {
        compat: Some(json!({"sendSessionAffinityHeaders": true})),
        session_id: Some(session_id.into()),
        ..Default::default()
    }
}

/// `(x-client-request-id, x-session-affinity)` values as sent.
fn affinity(request: &CapturedRequest) -> (Vec<&str>, Vec<&str>) {
    (
        request.values("x-client-request-id"),
        request.values("x-session-affinity"),
    )
}

/// TS: an opted-in cached session sends one stable opaque key under both
/// names; the raw id rides no header and no request metadata appears.
#[tokio::test]
async fn opted_in_cached_sessions_send_one_stable_opaque_key() {
    let first = capture(&opted_in("session-123")).await;
    let again = capture(&opted_in("session-123")).await;
    let other = capture(&opted_in("session-456")).await;
    assert_eq!(
        [affinity(&first), affinity(&again), affinity(&other)],
        [
            (vec![SESSION_123_KEY], vec![SESSION_123_KEY]),
            (vec![SESSION_123_KEY], vec![SESSION_123_KEY]),
            (vec![SESSION_456_KEY], vec![SESSION_456_KEY]),
        ]
    );
    assert!(
        SESSION_123_KEY.len() == 43
            && SESSION_123_KEY
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    );
    assert!(
        first
            .headers
            .iter()
            .all(|(name, value)| name != "session_id" && !value.contains("session-123")),
        "{:?}",
        first.headers
    );
    assert_eq!(first.body.get("metadata"), None);
}

/// TS: no opt-in, an opt-out, a missing or empty session id, or caching
/// turned off each omit the generated pair.
#[tokio::test]
async fn affinity_needs_the_opt_in_a_session_id_and_caching() {
    let cases = [
        CaseInput {
            compat: None,
            ..opted_in("session-123")
        },
        CaseInput {
            compat: Some(json!({"sendSessionAffinityHeaders": false})),
            ..opted_in("session-123")
        },
        CaseInput {
            session_id: None,
            ..opted_in("session-123")
        },
        opted_in(""),
        CaseInput {
            cache_retention: Some(CacheRetention::None),
            ..opted_in("session-123")
        },
    ];
    for input in &cases {
        let request = capture(input).await;
        assert_eq!(affinity(&request), (vec![], vec![]), "{:?}", input.compat);
    }
}

/// TS: mixed-case explicit request headers replace the generated pair (one
/// value per name on the wire) and still ride when generation is off.
#[tokio::test]
async fn explicit_headers_win_case_insensitively_and_survive_generation_off() {
    let explicit = HashMap::from([
        (
            "X-Client-Request-Id".to_string(),
            "explicit-request".to_string(),
        ),
        (
            "X-Session-Affinity".to_string(),
            "explicit-affinity".to_string(),
        ),
    ]);
    for input in [
        opted_in("session-123"),
        CaseInput {
            compat: None,
            ..opted_in("session-123")
        },
        CaseInput {
            cache_retention: Some(CacheRetention::None),
            ..opted_in("session-123")
        },
    ] {
        let request = capture(&CaseInput {
            headers: Some(explicit.clone()),
            ..input
        })
        .await;
        assert_eq!(
            affinity(&request),
            (vec!["explicit-request"], vec!["explicit-affinity"])
        );
    }
}

/// TS layering: the generated pair replaces a model-level default of the
/// same name, whatever its casing; other model headers stay.
#[tokio::test]
async fn generated_affinity_overrides_model_header_defaults() {
    let request = capture(&CaseInput {
        model_headers: Some(HashMap::from([
            (
                "X-Session-Affinity".to_string(),
                "model-default".to_string(),
            ),
            ("x-team".to_string(), "t1".to_string()),
        ])),
        ..opted_in("session-123")
    })
    .await;
    assert_eq!(
        (affinity(&request), request.values("x-team")),
        ((vec![SESSION_123_KEY], vec![SESSION_123_KEY]), vec!["t1"])
    );
}

/// Nothing excludes the official host (TS has no host guard; the
/// default-off compat is what keeps built-in requests clean): an opted-in
/// `anthropic` model on `api.anthropic.com` builds the pair beside its API
/// key. The client modes (API key, OAuth, cloudflare gateway,
/// github-copilot) are pinned on the wire by `ts_capture_parity`.
#[test]
fn the_official_host_is_not_excluded() {
    let model = model(&CaseInput {
        provider: Some("anthropic".into()),
        ..opted_in("session-123")
    });
    let (mut headers, is_oauth) = build_request_headers(
        &model,
        "test-key",
        /*interleaved_thinking*/ false,
        /*use_fine_grained_tool_streaming_beta*/ false,
        None,
        Some("session-123"),
        CacheRetention::Short,
    );
    headers.sort();
    let expected = [
        ("accept", "application/json"),
        ("anthropic-dangerous-direct-browser-access", "true"),
        ("anthropic-version", "2023-06-01"),
        ("x-api-key", "test-key"),
        ("x-client-request-id", SESSION_123_KEY),
        ("x-session-affinity", SESSION_123_KEY),
    ]
    .map(|(name, value)| (name.to_string(), value.to_string()));
    assert_eq!(
        (model.base_url.as_str(), headers, is_oauth),
        ("https://api.anthropic.com", expected.to_vec(), false)
    );
}

/// The provider reads its own view of the raw compat: a shared-key-only
/// object (the `cpa-a` opt-in, or `supportsLongCacheRetention: false`)
/// counts even though the key sniff files it under the completions shape.
#[test]
fn compat_resolution_reads_the_anthropic_view_of_any_object() {
    let resolved = |compat: Option<Value>| {
        get_anthropic_compat(&model(&CaseInput {
            compat,
            ..Default::default()
        }))
    };
    let defaults = ResolvedAnthropicCompat {
        supports_eager_tool_input_streaming: true,
        supports_long_cache_retention: true,
        send_session_affinity_headers: false,
    };
    assert_eq!(
        [
            resolved(None),
            resolved(Some(json!({"sendSessionAffinityHeaders": true}))),
            resolved(Some(json!({"supportsLongCacheRetention": false}))),
            resolved(Some(json!({
                "supportsEagerToolInputStreaming": false,
                "sendSessionAffinityHeaders": true
            }))),
            resolved(Some(json!({"sendSessionAffinityHeaders": "yes"}))),
        ],
        [
            ResolvedAnthropicCompat { ..defaults },
            ResolvedAnthropicCompat {
                send_session_affinity_headers: true,
                ..defaults
            },
            ResolvedAnthropicCompat {
                supports_long_cache_retention: false,
                ..defaults
            },
            ResolvedAnthropicCompat {
                supports_eager_tool_input_streaming: false,
                send_session_affinity_headers: true,
                ..defaults
            },
            ResolvedAnthropicCompat { ..defaults },
        ]
    );
}

/// Headers the TS fork's github-copilot client adds per request
/// (`buildCopilotDynamicHeaders`: the initiator and intent on every turn,
/// the vision flag on image turns). The Rust port sends them on no provider
/// yet: a known gap outside session affinity, left out of the replay rather
/// than pinned as absent.
const TS_ONLY_COPILOT_HEADERS: [&str; 3] =
    ["x-initiator", "openai-intent", "copilot-vision-request"];

/// Every fixture input crosses the wire exactly as the TS fork sent it:
/// the provider's own headers (compared as multisets, so a duplicate shows)
/// and the whole JSON body, cache markers included, in every client mode
/// (API key, OAuth, cloudflare gateway, github-copilot) and under explicit
/// overrides of the client's own version and auth headers. The transport's
/// own framing (`host`, `content-length`, `accept-encoding`) is not
/// compared.
#[tokio::test]
async fn ts_capture_parity() {
    let cases: Vec<ParityCase> = serde_json::from_str(TS_CAPTURE).unwrap();
    assert_eq!(cases.len(), 25, "the fixture carries every case");
    for mut case in cases {
        if case.input.provider.as_deref() == Some("github-copilot") {
            case.ts
                .headers
                .retain(|(name, _)| !TS_ONLY_COPILOT_HEADERS.contains(&name.as_str()));
        }
        let request = capture(&case.input).await;
        let mut rust_headers: Vec<(String, String)> = request
            .headers
            .into_iter()
            .filter(|(name, _)| {
                !matches!(name.as_str(), "host" | "content-length" | "accept-encoding")
            })
            .collect();
        rust_headers.sort();
        let mut ts_headers = case.ts.headers;
        ts_headers.sort();
        assert_eq!(
            (rust_headers, request.body),
            (ts_headers, case.ts.body),
            "case {}",
            case.name
        );
    }
}
