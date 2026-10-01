//! `provider session affinity configured`: the adoption seam for the
//! Anthropic Messages session-affinity opt-in (`sendSessionAffinityHeaders`,
//! the `cpa-a` proxy's sticky routing). A depth-0 session reports every
//! Anthropic Messages model it installs, so adoption reads as the enabled
//! share: the assembly-time model, every recorded model switch
//! (`AgentSession::set_model` / `set_model_and_thinking_level`: the daemon
//! worker's and ACP's switches) and the RPC mode's switch
//! (`SessionEngine::update_model_facts`). A provider failover or an
//! image-model route moves the agent for one turn and restores it, so it is
//! not a configuration change and does not report. Configuration only: no
//! session id, digest, header, address, or model name rides it.

use serde_json::Value;

use super::SessionTelemetry;

impl SessionTelemetry {
    /// Report whether `model`, now this session's model, opts into the
    /// session-affinity pair. Models of other APIs report nothing.
    pub(crate) fn note_provider_affinity(&self, model: &pa_types::ai::Model) {
        if model.api != "anthropic-messages" {
            return;
        }
        // The provider's own reading of the compat object (the Anthropic
        // view, default off), never the key sniff.
        let enabled = model
            .compat
            .as_ref()
            .and_then(|compat| compat.anthropic_messages().ok())
            .and_then(|compat| compat.send_session_affinity_headers)
            .unwrap_or(false);
        let mut properties = pa_telemetry::base_properties(&self.execution_mode);
        properties.set("api", Value::from("anthropic-messages"));
        properties.set("key_format", Value::from("sha256-base64url"));
        properties.set("enabled", Value::from(enabled));
        self.client
            .track("provider session affinity configured", properties);
    }
}
