//! `provider session affinity configured`: adoption of the opt-in provider
//! session-affinity routing (the Anthropic Messages
//! `sendSessionAffinityHeaders` compat flag a sticky-routing proxy such as
//! `cpa-a` sets). It measures configuration only - not whether headers were
//! sent or a cache hit - and carries no session id, digest, header, address,
//! or model name. Additive to schema version 2.

use super::{boolean, enum_rule, required, EventRule};

/// The provider APIs whose affinity opt-in reports here.
const AFFINITY_APIS: &[&str] = &["anthropic-messages", "unknown"];

/// How the affinity key derives from the session id.
const AFFINITY_KEY_FORMATS: &[&str] = &["sha256-base64url", "unknown"];

pub(super) const PROVIDER_SESSION_AFFINITY_CONFIGURED: EventRule = EventRule {
    name: "provider session affinity configured",
    since: 2,
    properties: &[
        ("api", required(enum_rule(AFFINITY_APIS, "unknown"))),
        (
            "key_format",
            required(enum_rule(AFFINITY_KEY_FORMATS, "unknown")),
        ),
        ("enabled", required(boolean())),
    ],
};

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::catalog::sanitize;
    use crate::properties::Properties;

    /// The rule keeps the three configuration primitives, falls back an
    /// out-of-vocabulary API, and drops anything identifying: a session id
    /// or affinity key can never ride the event.
    #[test]
    fn sanitize_keeps_configuration_and_drops_identifiers() {
        let event = |api: &str, extra: &[(&str, &str)]| {
            let mut properties = Properties::new();
            properties.set("api", json!(api));
            properties.set("key_format", json!("sha256-base64url"));
            properties.set("enabled", json!(true));
            for (key, value) in extra {
                properties.set(key, json!(value));
            }
            let adjusted = sanitize("provider session affinity configured", &mut properties);
            (adjusted, serde_json::to_value(&properties).unwrap())
        };
        let kept =
            |api: &str| json!({"api": api, "key_format": "sha256-base64url", "enabled": true});
        assert_eq!(
            [
                event("anthropic-messages", &[]),
                event(
                    "anthropic-messages",
                    &[
                        ("session_id", "0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"),
                        (
                            "affinity_key",
                            "uchDIvgkNMtG4jnSDa8fNxTutQd_h_sPDNS9M2vAG1Q"
                        ),
                    ]
                ),
                event("openai-completions", &[]),
            ],
            [
                (0, kept("anthropic-messages")),
                (2, kept("anthropic-messages")),
                (1, kept("unknown")),
            ]
        );
    }
}
