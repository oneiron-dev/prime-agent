//! Anthropic Messages request headers: the SDK client modes (OAuth/Claude
//! Code, cloudflare gateway, github-copilot, plain API key), the beta
//! flags, and the opt-in session-affinity pair. Section of the port of
//! `packages/ai/src/providers/anthropic.ts` (`createClient`,
//! `getSessionAffinityHeaders`, `mergeHeaders`).
//!
//! Every Rust Anthropic request builds its headers here (there is no
//! supplied-client mode), so one layering covers every request: the SDK's
//! version and auth < client defaults < model headers < generated affinity
//! < explicit options, each later layer replacing an earlier header
//! case-insensitively.

use std::collections::HashMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::providers::anthropic::{get_anthropic_compat, supports_adaptive_thinking};
use crate::types::{CacheRetention, Model};

/// Claude Code version mimicked in OAuth mode. The API gates newer models
/// on the claimed client version (e.g. claude-opus-5.5 requires >= 2.280),
/// so keep this at or above the latest released Claude Code.
const CLAUDE_CODE_VERSION: &str = "2.1.281";
const FINE_GRAINED_TOOL_STREAMING_BETA: &str = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA: &str = "interleaved-thinking-2025-05-14";

pub(super) fn is_oauth_token(api_key: &str) -> bool {
    api_key.contains("sk-ant-oat")
}

/// Build the request headers for the messages endpoint, mirroring the SDK
/// client configurations (OAuth/Claude Code mode, cloudflare gateway,
/// github-copilot, plain API key). `cache_retention` is the resolved
/// retention: `none` suppresses the generated affinity pair, never an
/// explicit header.
// Long by design: a 1:1 port of the TS `createClient` client modes plus
// `getSessionAffinityHeaders`, so the layering order reads top to bottom.
#[allow(clippy::too_many_lines)]
pub(crate) fn build_request_headers(
    model: &Model,
    api_key: &str,
    interleaved_thinking: bool,
    use_fine_grained_tool_streaming_beta: bool,
    options_headers: Option<&HashMap<String, String>>,
    session_id: Option<&str>,
    cache_retention: CacheRetention,
) -> (Vec<(String, String)>, bool) {
    let is_oauth = is_oauth_token(api_key);
    let needs_interleaved_beta = interleaved_thinking && !supports_adaptive_thinking(&model.id);
    let mut beta_features: Vec<&str> = Vec::new();
    if use_fine_grained_tool_streaming_beta {
        beta_features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
    }
    if needs_interleaved_beta {
        beta_features.push(INTERLEAVED_THINKING_BETA);
    }
    let beta_header = if beta_features.is_empty() {
        None
    } else {
        Some(beta_features.join(","))
    };

    let model_headers: Option<Map<String, Value>> = model.headers.as_ref().map(|headers| {
        headers
            .iter()
            .map(|(key, value)| (key.clone(), json!(value)))
            .collect()
    });
    // TS `getSessionAffinityHeaders`: an opted-in model with a non-empty
    // session id and caching on routes sticky by the id's SHA-256 digest
    // (base64url, unpadded). The digest keeps the session sticky without
    // putting the raw id on the wire; the id is hashed as given, never
    // trimmed.
    let affinity_headers: Option<Map<String, Value>> = session_id
        .filter(|session_id| {
            !session_id.is_empty()
                && cache_retention != CacheRetention::None
                && get_anthropic_compat(model).send_session_affinity_headers
        })
        .map(|session_id| {
            let affinity_key = URL_SAFE_NO_PAD.encode(Sha256::digest(session_id.as_bytes()));
            let mut headers = Map::new();
            headers.insert("x-client-request-id".into(), json!(affinity_key));
            headers.insert("x-session-affinity".into(), json!(affinity_key));
            headers
        });
    let options_headers_json: Option<Map<String, Value>> = options_headers.map(|headers| {
        headers
            .iter()
            .map(|(key, value)| (key.clone(), json!(value)))
            .collect()
    });

    // The SDK client's own headers, beneath its `defaultHeaders`: the API
    // version and `authHeaders()` (a client `apiKey` sends `x-api-key`, an
    // `authToken` a bearer `authorization`). The cloudflare gateway client
    // sets neither; its key rides `cf-aig-authorization`.
    let mut sdk_headers = Map::new();
    sdk_headers.insert("anthropic-version".into(), json!("2023-06-01"));
    let bearer = json!(format!("Bearer {api_key}"));
    let mut client_defaults = Map::new();
    client_defaults.insert("accept".into(), json!("application/json"));
    client_defaults.insert(
        "anthropic-dangerous-direct-browser-access".into(),
        json!("true"),
    );
    match model.provider.as_str() {
        "cloudflare-ai-gateway" => {
            client_defaults.insert("cf-aig-authorization".into(), bearer);
            client_defaults.insert("x-api-key".into(), Value::Null);
            client_defaults.insert("Authorization".into(), Value::Null);
            if let Some(beta) = &beta_header {
                client_defaults.insert("anthropic-beta".into(), json!(beta));
            }
        }
        "github-copilot" => {
            sdk_headers.insert("authorization".into(), bearer);
            if let Some(beta) = &beta_header {
                client_defaults.insert("anthropic-beta".into(), json!(beta));
            }
        }
        _ => {
            if is_oauth {
                sdk_headers.insert("authorization".into(), bearer);
                client_defaults.insert(
                    "anthropic-beta".into(),
                    json!(["claude-code-20250219", "oauth-2025-04-20"]
                        .iter()
                        .chain(beta_features.iter())
                        .copied()
                        .collect::<Vec<_>>()
                        .join(",")),
                );
                client_defaults.insert(
                    "user-agent".into(),
                    json!(format!("claude-cli/{CLAUDE_CODE_VERSION}")),
                );
                client_defaults.insert("x-app".into(), json!("cli"));
            } else {
                sdk_headers.insert("x-api-key".into(), json!(api_key));
                if let Some(beta) = &beta_header {
                    client_defaults.insert("anthropic-beta".into(), json!(beta));
                }
            }
        }
    }
    // TS `mergeHeaders`, as the SDK applies it: layers in order, names
    // lowercased so a later layer replaces an earlier header whatever its
    // casing (a mixed-case explicit `X-Session-Affinity` never rides beside
    // the generated one, an explicit `X-Api-Key` replaces the client's).
    // A `null` drops the name from the layered map.
    let mut headers = Map::new();
    for layer in [
        Some(sdk_headers),
        Some(client_defaults),
        model_headers,
        affinity_headers,
        options_headers_json,
    ]
    .into_iter()
    .flatten()
    {
        for (key, value) in layer {
            headers.insert(key.to_ascii_lowercase(), value);
        }
    }

    // withOpenCodeHeaders: session header for opencode providers.
    if model.provider == "opencode" || model.provider == "opencode-go" {
        if let Some(session_id) = session_id {
            headers.insert("session_id".into(), json!(session_id));
        }
    }

    let pairs: Vec<(String, String)> = headers
        .into_iter()
        .filter_map(|(key, value)| match value {
            Value::String(text) => Some((key, text)),
            _ => None,
        })
        .collect();
    (pairs, is_oauth)
}

#[cfg(test)]
mod tests {
    use super::build_request_headers;
    use crate::types::{zero_model_cost, CacheRetention, Model, ModelInput};

    // TS #2645's wire-contract assertions (anthropic-thinking-disable.test.ts):
    // subscription requests claim the Claude Code client identity, and the
    // claimed version must stay at or above what the API's model gates require
    // (the opus-5.5 family rejects anything below 2.280).
    fn test_model() -> Model {
        Model {
            id: "claude-opus-5-5".into(),
            name: "Claude Opus 5.5".into(),
            api: "anthropic-messages".into(),
            provider: "anthropic".into(),
            base_url: "https://api.anthropic.com".into(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: zero_model_cost(),
            context_window: 200_000,
            max_tokens: 32_000,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn oauth_requests_claim_the_claude_code_identity() {
        let (headers, is_oauth) = build_request_headers(
            &test_model(),
            "sk-ant-oat-test",
            /*interleaved_thinking*/ false,
            /*use_fine_grained_tool_streaming_beta*/ false,
            None,
            None,
            CacheRetention::Short,
        );
        assert!(is_oauth);
        let header = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        };
        let user_agent = header("user-agent").expect("the OAuth request sends a user-agent");
        assert!(user_agent.starts_with("claude-cli/"), "got {user_agent}");
        assert_eq!(header("x-app"), Some("cli"));
        let beta = header("anthropic-beta").expect("the OAuth request sends the claude-code beta");
        assert!(beta.contains("claude-code-20250219"));
    }
}
