//! RLM child model resolution and roster text helpers: reference resolution against the
//! credential-backed catalog, the spawn-time thinking-support check, plus the roster text caps.

use std::path::Path;

use anyhow::{anyhow, bail, Result};
use pa_ai::models::{get_supported_thinking_levels, thinking_level_from_str};
use pa_core::kernel::rlm_runtime::{find_rlm_model_matches, RlmModelInfo};
use pa_core::session_engine::helper_model::{
    first_helper_notice, plan_helper, unknown_helper_model_warning, HelperDefaults,
    HelperModelList, HelperSource,
};

/// Close matches listed in model-resolution errors.
const MODEL_ERROR_SUGGESTION_LIMIT: usize = 3;
/// Cap on the answer preview handed to the parent model.
pub const ANSWER_PREVIEW_MAX_CHARS: usize = 160;
/// Cap on the one-line task label shown in kernel rosters.
pub const LABEL_MAX_CHARS: usize = 200;
/// Cap on the FULL final-answer text the collect envelope carries (the
/// settle-binding data plane): the roster preview stays
/// [`ANSWER_PREVIEW_MAX_CHARS`], while a consumer that binds outputs from
/// the answer (the factory's output ports) needs the whole fenced JSON,
/// so the lane is bounded instead of unbounded, never ballooning the
/// collect reply for a runaway answer.
pub const ANSWER_TEXT_MAX_CHARS: usize = 65_536;
const ELLIPSIS: &str = "...";

/// The model catalog the RLM surface resolves against: the same
/// credential-backed list `rlm.find_models` searches (entitled `internal/*` models resolve).
#[must_use]
pub fn catalog_models(agent_dir: &Path) -> Vec<RlmModelInfo> {
    let registry = crate::state_getters::worker_model_registry(agent_dir);
    registry
        .get_rlm_searchable_models()
        .into_iter()
        .map(|model| RlmModelInfo {
            provider: model.provider.clone(),
            id: model.id.clone(),
            name: if model.name.is_empty() {
                model.id.clone()
            } else {
                model.name.clone()
            },
        })
        .collect()
}

/// Resolve the child model reference, then enforce the daemon
/// `allowedModels` allowlist on the resolved selector (inherited parent
/// model included): outside the allowlist fails loudly, never a fallback.
///
/// # Errors
/// Returns an error when the reference cannot be resolved or the selector is outside the allowlist.
pub fn resolve_child_model(
    agent_dir: &Path,
    reference: Option<&str>,
    parent_model: Option<&str>,
    target: &str,
    allowlist: &crate::model_allowlist::DaemonAllowlist,
) -> Result<String> {
    let model = resolve_child_model_unchecked(agent_dir, reference, parent_model, target)?;
    crate::model_allowlist::assert_allowed(allowlist, &model)?;
    Ok(model)
}

/// The resolution before the allowlist gate: `None` inherits the parent model; a reference resolves
/// parent equality first, then an exact catalog selector, then a unique short-form match.
/// Public for the daemonless print host: print sessions do not enforce
/// `allowedModels`, so its children do not either.
///
/// # Errors
/// Returns an error when the reference cannot be resolved against the catalog.
pub fn resolve_child_model_unchecked(
    agent_dir: &Path,
    reference: Option<&str>,
    parent_model: Option<&str>,
    target: &str,
) -> Result<String> {
    let Some(reference) = reference else {
        return parent_model
            .map(str::to_string)
            .ok_or_else(|| anyhow!("No model selected. Use /model to pick one."));
    };
    let reference = reference.trim();
    let normalized = reference.to_lowercase();
    if let Some(parent) = parent_model {
        if parent.to_lowercase() == normalized {
            return Ok(parent.to_string());
        }
    }
    let candidates = catalog_models(agent_dir);
    let selector_of = |model: &RlmModelInfo| format!("{}/{}", model.provider, model.id);
    if let Some(exact) = candidates
        .iter()
        .find(|model| selector_of(model).to_lowercase() == normalized)
    {
        return Ok(selector_of(exact));
    }
    // Short form: the full selector ends with "/<reference>".
    let short_matches: Vec<&RlmModelInfo> = candidates
        .iter()
        .filter(|model| {
            selector_of(model)
                .to_lowercase()
                .ends_with(&format!("/{normalized}"))
        })
        .collect();
    match short_matches.len() {
        1 => return Ok(selector_of(short_matches[0])),
        0 => {
            if let Some(parent) = parent_model {
                if parent.to_lowercase().ends_with(&format!("/{normalized}")) {
                    return Ok(parent.to_string());
                }
            }
        }
        _ => {}
    }
    Err(model_unavailable_error(reference, target, &candidates))
}

/// What one spawn resolves its helper model and thinking from: the call's own values, the
/// parent's model, and the two default layers (`pa_core::session_engine::helper_model`).
#[derive(Debug, Clone, Copy)]
pub struct HelperRequest<'a> {
    pub model: Option<&'a str>,
    pub thinking: Option<&'a str>,
    pub parent_model: Option<&'a str>,
    /// The parent's thinking level, when the host knows it.
    pub parent_thinking: Option<&'a str>,
    /// The session override.
    pub session: &'a HelperDefaults,
    /// The settings file (`subagentDefaultModel`/`subagentDefaultThinking`).
    pub settings: &'a HelperDefaults,
}

/// A child's model and thinking after the helper order, with the layer each came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedHelper {
    /// The catalog selector the child runs on.
    pub selector: String,
    pub model_source: HelperSource,
    /// The level the child runs at (clamped to its catalog model); `None` when neither a layer
    /// nor the parent names one (the child's worker picks its default).
    pub thinking: Option<String>,
    pub thinking_source: HelperSource,
}

/// Resolve a child's model and thinking through the helper order (the spawn call, the session
/// override, the settings file, the parent) and the helper model list, then enforce the daemon
/// `allowedModels` allowlist on the selector.
///
/// # Errors
/// Returns an error when the spawn call's own model or thinking level does not resolve or is off
/// the helper model list, when no model resolves at all, or when the selector is outside the
/// allowlist.
pub fn resolve_helper(
    agent_dir: &Path,
    request: HelperRequest<'_>,
    target: &str,
    allowlist: &crate::model_allowlist::DaemonAllowlist,
) -> Result<ResolvedHelper> {
    let resolved = resolve_helper_unchecked(agent_dir, request, target)?;
    crate::model_allowlist::assert_allowed(allowlist, &resolved.selector)?;
    Ok(resolved)
}

/// The helper resolution before the allowlist gate (the daemonless print host's entry). The
/// spawn call's own values keep their strict checks; a default model the catalog does not know
/// warns once on stderr and falls back to the parent's model; a default thinking level, or the
/// parent's, clamps to what the resolved model supports.
///
/// With a helper model list ([`HelperModelList`]) set, a spawn call naming a model off the list
/// is refused, and a settings default or the parent's model off the list falls to the list's
/// first entry with a warning once on stderr. The session override is a person's choice: always
/// allowed.
///
/// # Errors
/// Returns an error when the spawn call's own model or thinking level does not resolve or is off
/// the helper model list, or when no model resolves at all.
pub fn resolve_helper_unchecked(
    agent_dir: &Path,
    request: HelperRequest<'_>,
    target: &str,
) -> Result<ResolvedHelper> {
    let plan = plan_helper(
        request.model,
        request.thinking,
        request.session,
        request.settings,
    );
    let list = HelperModelList::active(request.session, request.settings);
    let parent = || resolve_child_model_unchecked(agent_dir, None, request.parent_model, target);
    let (selector, model_source) = match (plan.model.value.as_deref(), plan.model.source) {
        (Some(reference), HelperSource::Spawn) => {
            let resolved = resolve_child_model_unchecked(
                agent_dir,
                Some(reference),
                request.parent_model,
                target,
            );
            // Off the list, the refusal names the allowed models so the agent retries with one
            // (an unresolved reference too: its close matches would list models off the list).
            if let Some(list) = &list {
                let allowed = match &resolved {
                    Ok(selector) => list.allows(selector),
                    Err(_) => list.allows(reference),
                };
                if !allowed {
                    bail!(list.refusal(reference, target));
                }
            }
            (resolved?, HelperSource::Spawn)
        }
        (Some(reference), source) => {
            if let Ok(selector) = resolve_child_model_unchecked(
                agent_dir,
                Some(reference),
                request.parent_model,
                target,
            ) {
                (selector, source)
            } else {
                let warning = unknown_helper_model_warning(reference, source);
                if first_helper_notice(&warning) {
                    eprintln!("{warning}");
                }
                (parent()?, HelperSource::Parent)
            }
        }
        (None, _) => (parent()?, HelperSource::Parent),
    };
    // The defaults stay on the list too: a settings default or the parent's model off it falls to
    // the list's first entry.
    let (selector, model_source) = match &list {
        Some(list)
            if matches!(model_source, HelperSource::Settings | HelperSource::Parent)
                && !list.allows(&selector) =>
        {
            let origin = if model_source == HelperSource::Settings {
                "subagentDefaultModel"
            } else {
                "The parent's model"
            };
            let warning = format!(
                "Warning: {origin} \"{selector}\" is not on the helper model list (subagentModels); spawned agents use \"{}\"",
                list.first()
            );
            if first_helper_notice(&warning) {
                eprintln!("{warning}");
            }
            (
                resolve_child_model_unchecked(
                    agent_dir,
                    Some(list.first()),
                    request.parent_model,
                    target,
                )?,
                HelperSource::List,
            )
        }
        _ => (selector, model_source),
    };
    let thinking = match (plan.thinking.value, plan.thinking.source) {
        (Some(level), HelperSource::Spawn) => {
            assert_thinking_supported(agent_dir, Some(&level), &selector)?;
            Some(level)
        }
        // A default level, else the parent's own, clamps to what the selector's catalog model
        // supports (the level the child runs at); a model outside the catalog (a scripted
        // verification model) keeps the level as given.
        (level, _) => level
            .or_else(|| request.parent_thinking.map(str::to_string))
            .map(|level| {
                let catalog_model = selector.split_once('/').and_then(|(provider, id)| {
                    crate::state_getters::worker_model_registry(agent_dir)
                        .get_rlm_searchable_models()
                        .into_iter()
                        .find(|model| model.provider == provider && model.id == id)
                        .cloned()
                });
                match (catalog_model, thinking_level_from_str(&level)) {
                    (Some(model), Some(requested)) => {
                        pa_ai::models::clamp_thinking_level(&model, requested)
                            .wire_name()
                            .to_string()
                    }
                    _ => level,
                }
            }),
    };
    Ok(ResolvedHelper {
        selector,
        model_source,
        thinking,
        thinking_source: plan.thinking.source,
    })
}

/// The startup check of the helper model a session's spawns default to (the session override,
/// else the settings file): the warning line when the catalog does not know it, `None` when it
/// does, when none is set, or when this process already warned about it.
#[must_use]
pub fn unknown_helper_model_notice(
    cwd: &Path,
    agent_dir: &Path,
    session: &HelperDefaults,
) -> Option<String> {
    let settings = HelperDefaults::load_settings(cwd, agent_dir);
    let plan = plan_helper(None, None, session, &settings);
    let reference = plan.model.value.as_deref()?;
    if helper_model_known(agent_dir, reference) {
        return None;
    }
    let warning = unknown_helper_model_warning(reference, plan.model.source);
    first_helper_notice(&warning).then_some(warning)
}

/// Whether a default helper model reference resolves against the catalog the spawns use
/// (`parent` always does).
#[must_use]
pub fn helper_model_known(agent_dir: &Path, reference: &str) -> bool {
    reference == pa_core::session_engine::helper_model::INHERIT_PARENT
        || resolve_child_model_unchecked(agent_dir, Some(reference), None, "subagent").is_ok()
}

/// A requested thinking level must be supported by the resolved model;
/// an out-of-catalog model (a scripted verification model) passes unchecked.
///
/// # Errors
/// Returns an error when the supported levels exclude the requested one (the message lists them);
/// the unchecked cases pass.
pub fn assert_thinking_supported(
    agent_dir: &Path,
    level: Option<&str>,
    selector: &str,
) -> Result<()> {
    let Some(level) = level else {
        return Ok(());
    };
    let Some((provider, id)) = selector.split_once('/') else {
        return Ok(());
    };
    let registry = crate::state_getters::worker_model_registry(agent_dir);
    let Some(model) = registry
        .get_rlm_searchable_models()
        .into_iter()
        .find(|model| model.provider == provider && model.id == id)
    else {
        return Ok(());
    };
    let supported = get_supported_thinking_levels(model);
    let Some(requested) = thinking_level_from_str(level) else {
        return Ok(());
    };
    if supported.contains(&requested) {
        return Ok(());
    }
    let levels = supported
        .iter()
        .map(|level| level.wire_name())
        .collect::<Vec<_>>()
        .join(", ");
    bail!(
        "Requested thinking level \"{level}\" is not supported by model \"{selector}\"; supported levels: {levels}"
    );
}

/// Rejection message for an unresolved model reference: the
/// unavailability, the selector form, and close matches for retry.
fn model_unavailable_error(
    reference: &str,
    target: &str,
    candidates: &[RlmModelInfo],
) -> anyhow::Error {
    let base = format!(
        "Requested {target} model \"{reference}\" is unavailable, unauthenticated, or expired"
    );
    let hint =
        "selectors use the form \"provider/model-id\" (e.g. \"prime-inference/z-ai/glm-5.3\")";
    let close_matches = find_rlm_model_matches(reference, candidates, MODEL_ERROR_SUGGESTION_LIMIT);
    if close_matches.is_empty() {
        anyhow!("{base}; {hint}")
    } else {
        let selectors = close_matches
            .iter()
            .map(|match_| format!("\"{}\"", match_.selector))
            .collect::<Vec<_>>()
            .join(", ");
        anyhow!("{base}; {hint}; close matches: {selectors}")
    }
}

/// Collapse whitespace and cap at the roster limit.
#[must_use]
pub fn compact_rlm_text(text: &str) -> String {
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    cap_text(&compact, ANSWER_PREVIEW_MAX_CHARS)
}

/// One-line task label: collapsed prompt, capped for roster rows.
#[must_use]
pub fn rlm_child_label(prompt: &str) -> String {
    let collapsed: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let collapsed = if collapsed.is_empty() {
        "child agent".to_string()
    } else {
        collapsed
    };
    cap_text(&collapsed, LABEL_MAX_CHARS)
}

/// Whitespace-collapsed text capped at `max` chars with an ellipsis.
#[must_use]
pub fn cap_text(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max - ELLIPSIS.len()).collect();
    format!("{}{}", kept.trim_end(), ELLIPSIS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_allowlist::DaemonAllowlist;
    use serde_json::json;

    /// A models.json custom provider, like the pa-core registry tests.
    fn write_catalog(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("models.json"),
            json!({
                "providers": {
                    "test-provider": {
                        "baseUrl": "http://localhost:9",
                        "apiKey": "test-key",
                        "api": "openai-completions",
                        "models": [
                            { "id": "glm-5.3", "name": "GLM 5.3", "contextWindow": 1000, "maxTokens": 100 },
                            { "id": "glm-5.3-turbo", "name": "GLM Turbo", "contextWindow": 1000, "maxTokens": 100 }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn resolves_parent_exact_and_short_form_references() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        let resolved = resolve_child_model(
            dir.path(),
            None,
            Some("test-provider/glm-5.3"),
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap();
        assert_eq!(resolved, "test-provider/glm-5.3");
        // Parent equality short-circuits even a catalog refresh miss.
        let resolved = resolve_child_model(
            dir.path(),
            Some("Test-Provider/GLM-5.3"),
            Some("test-provider/glm-5.3"),
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap();
        assert_eq!(resolved, "test-provider/glm-5.3");
        let resolved = resolve_child_model(
            dir.path(),
            Some("test-provider/glm-5.3-turbo"),
            Some("test-provider/glm-5.3"),
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap();
        assert_eq!(resolved, "test-provider/glm-5.3-turbo");
        let resolved = resolve_child_model(
            dir.path(),
            Some("glm-5.3-turbo"),
            Some("test-provider/glm-5.3"),
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap();
        assert_eq!(resolved, "test-provider/glm-5.3-turbo");
        let error = resolve_child_model(
            dir.path(),
            None,
            None,
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "No model selected. Use /model to pick one."
        );
    }

    #[test]
    fn the_allowlist_refuses_resolved_models_loudly() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        let allow =
            crate::model_allowlist::DaemonAllowlist::Allowed(vec!["prime-inference/*".to_string()]);
        // An explicit reference outside the allowlist fails with the typed refusal.
        let error = resolve_child_model(
            dir.path(),
            Some("test-provider/glm-5.3"),
            None,
            "subagent",
            &allow,
        )
        .unwrap_err();
        let refusal = error
            .downcast_ref::<pa_core::models::ModelAllowlistRefusal>()
            .expect("typed refusal");
        assert_eq!(refusal.selector, "test-provider/glm-5.3");
        assert!(
            error
                .to_string()
                .contains("blocked by the daemon model allowlist"),
            "{error}"
        );
        // An inherited parent model outside the allowlist refuses too:
        // inheritance is a resolution, not an exemption.
        let error = resolve_child_model(
            dir.path(),
            None,
            Some("test-provider/glm-5.3"),
            "subagent",
            &allow,
        )
        .unwrap_err();
        assert!(
            error
                .downcast_ref::<pa_core::models::ModelAllowlistRefusal>()
                .is_some(),
            "{error}"
        );
        let resolved = resolve_child_model(
            dir.path(),
            Some("test-provider/glm-5.3"),
            None,
            "subagent",
            &crate::model_allowlist::DaemonAllowlist::Allowed(vec!["test-provider/*".to_string()]),
        )
        .unwrap();
        assert_eq!(resolved, "test-provider/glm-5.3");
        let resolved = resolve_child_model(
            dir.path(),
            Some("test-provider/glm-5.3"),
            None,
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap();
        assert_eq!(resolved, "test-provider/glm-5.3");
    }

    #[test]
    fn unmatched_references_carry_the_ts_error_with_close_matches() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        // TS parity (4649 regression suite): a prefix reference lists
        // close matches, a matching-nothing reference does not (the
        // reference prefixes the test provider, never real defaults).
        let error = resolve_child_model(
            dir.path(),
            Some("test-provi"),
            Some("test-provider/glm-5.3"),
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(
            message.starts_with(
                "Requested subagent model \"test-provi\" is unavailable, unauthenticated, or expired; selectors use the form \"provider/model-id\""
            ),
            "{message}"
        );
        // Close matches list full selectors, nearest first.
        assert!(
            message.contains("close matches: \"test-provider/glm-5.3\""),
            "{message}"
        );
        let error = resolve_child_model(
            dir.path(),
            Some("zzz"),
            Some("test-provider/glm-5.3"),
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap_err();
        assert!(!error.to_string().contains("close matches:"), "{error}");
    }

    #[test]
    fn thinking_support_follows_the_resolved_model() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        // The custom catalog model is non-reasoning: only "off" is supported.
        assert_thinking_supported(dir.path(), Some("off"), "test-provider/glm-5.3").unwrap();
        let error = assert_thinking_supported(dir.path(), Some("high"), "test-provider/glm-5.3")
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Requested thinking level \"high\" is not supported by model \"test-provider/glm-5.3\"; supported levels: off"
        );
        // A model outside the catalog (scripted verification models) passes.
        assert_thinking_supported(dir.path(), Some("high"), "scripted/faux-1").unwrap();
    }

    /// The child-propagation regression: a spawned child resolves an
    /// entitled private `internal/*` model through the worker's same disk caches.
    #[test]
    fn a_spawned_child_resolves_an_entitled_private_model() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        // The worker-path auth (auth.json): one Prime Inference key+team.
        std::fs::write(
            dir.path().join("auth.json"),
            json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": "child-key",
                    "primeTeam": { "teamId": "team-7", "name": "Team 7" }
                }
            })
            .to_string(),
        )
        .unwrap();
        // The authorized private model: the compiled fallback lacks it, the
        // fingerprint-scoped disk cache carries it.
        let mut auth = pa_core::auth::AuthStorage::create(dir.path());
        let api_key = auth.get_api_key("prime-inference").expect("api key");
        // The stored team selection survives ambient env credentials (a
        // dogfood box's ambient `PRIME_API_KEY` changes the pair); the
        // cache below is written for whatever pair resolves.
        let team_id = auth
            .get_provider_headers("prime-inference")
            .and_then(|headers| headers.get("X-Prime-Team-ID").cloned())
            .expect("stored team selection");
        let fingerprint =
            pa_core::models::private_prime_authorization_fingerprint(&api_key, &team_id);
        pa_core::models::write_private_prime_authorization_cache(
            &dir.path().join("models.json"),
            &pa_core::models::PrivatePrimeAuthorizationCache {
                fingerprint,
                // The durable wire items (an `/models` payload shape): the
                // read path parses and builds the model from them.
                items: vec![json!({
                    "id": "internal/glm-5.3-fast",
                    "display_name": "GLM 5.3 Fast",
                    "pricing": {
                        "input_usd_per_mtok": 0.42, "output_usd_per_mtok": 2.1,
                        "cache_read_usd_per_mtok": 0.0, "cache_write_usd_per_mtok": 0.0,
                    },
                    "specs": {
                        "context_window": 400_000, "max_output_tokens": 131_072,
                        "supports_reasoning": true,
                        "modalities": { "input": ["text"], "output": ["text"] },
                    },
                })],
                models: Vec::new(),
                refreshed_at: 1,
            },
        );

        assert!(catalog_models(dir.path())
            .iter()
            .any(|model| model.id == "internal/glm-5.3-fast"));
        let resolved = resolve_child_model(
            dir.path(),
            Some("prime-inference/internal/glm-5.3-fast"),
            Some("prime-inference/z-ai/glm-5.3"),
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap();
        assert_eq!(resolved, "prime-inference/internal/glm-5.3-fast");
        let resolved = resolve_child_model(
            dir.path(),
            Some("internal/glm-5.3-fast"),
            Some("prime-inference/z-ai/glm-5.3"),
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap();
        assert_eq!(resolved, "prime-inference/internal/glm-5.3-fast");
        // The spawn-time thinking check follows the resolved entitlement.
        assert_thinking_supported(
            dir.path(),
            Some("high"),
            "prime-inference/internal/glm-5.3-fast",
        )
        .unwrap();
        assert_thinking_supported(
            dir.path(),
            Some("off"),
            "prime-inference/internal/glm-5.3-fast",
        )
        .unwrap();
    }

    /// The catalog-repo child-resolution regression: a fetched entry the compiled fallback lacks
    /// resolves through the on-disk provider catalog, once its provider is auth-configured.
    #[test]
    fn a_spawned_child_resolves_a_catalog_repo_entry_the_compiled_fallback_lacks() {
        const PROBE_ID: &str = "gpt-6-probe";
        assert!(
            !pa_ai::models_generated::get_models("openai-codex")
                .iter()
                .any(|model| model.id == PROBE_ID),
            "the probe entry is compiled in; pick another id"
        );
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("models")).unwrap();
        // The provider auth the resolution filters on: a models.json
        // provider entry (headers alone satisfy the config validation and
        // has_configured_auth).
        std::fs::write(
            dir.path().join("models.json"),
            json!({
                "providers": {
                    "openai-codex": {
                        "apiKey": "codex-key",
                        "headers": { "X-Probe": "catalog-chain" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        // The layer-A disk cache the startup refresh writes beside
        // models.json: one catalog-repo entry riding the compiled
        // openai-codex transport tuple (the pinning invariant).
        std::fs::write(
            dir.path()
                .join("models")
                .join("provider-model-catalog.v1.json"),
            json!({
                "url": pa_models::fetch::MODEL_CATALOG_URL,
                "scope": pa_models::cache::PUBLIC_SCOPE,
                "fetchedAt": 1,
                "payload": { "schemaVersion": 1, "models": [
                    {
                        "id": PROBE_ID, "name": "GPT-6 Probe",
                        "api": "openai-codex-responses", "provider": "openai-codex",
                        "baseUrl": "https://chatgpt.com/backend-api",
                        "reasoning": true,
                        "thinkingLevelMap": { "minimal": null, "xhigh": "xhigh", "max": "max" },
                        "input": ["text"],
                        "cost": { "input": 2, "output": 10, "cacheRead": 0.2, "cacheWrite": 2.5 },
                        "contextWindow": 272_000, "maxTokens": 128_000,
                    }
                ]}
            })
            .to_string(),
        )
        .unwrap();
        let selector = format!("openai-codex/{PROBE_ID}");
        let catalog = catalog_models(dir.path());
        let probe = catalog
            .iter()
            .find(|model| model.selector() == selector)
            .expect("the fetched entry lists for find_models");
        assert_eq!(probe.name, "GPT-6 Probe");
        let resolved = resolve_child_model(
            dir.path(),
            Some(&selector),
            Some("prime-inference/z-ai/glm-5.3"),
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap();
        assert_eq!(resolved, selector);
        let resolved = resolve_child_model(
            dir.path(),
            Some(PROBE_ID),
            Some("prime-inference/z-ai/glm-5.3"),
            "subagent",
            &DaemonAllowlist::Unrestricted,
        )
        .unwrap();
        assert_eq!(resolved, selector);
        // The spawn-time thinking check follows the fetched entry's map:
        // xhigh is explicitly mapped, minimal is explicitly nulled out.
        assert_thinking_supported(dir.path(), Some("xhigh"), &selector).unwrap();
        let error = assert_thinking_supported(dir.path(), Some("minimal"), &selector).unwrap_err();
        assert!(
            error.to_string().contains("not supported by model"),
            "{error}"
        );
    }

    #[test]
    fn roster_text_is_collapsed_and_capped() {
        let label = rlm_child_label("  ship   the\nlane  ");
        assert_eq!(label, "ship the lane");
        let long = "word ".repeat(100);
        let label = rlm_child_label(&long);
        assert!(label.chars().count() <= LABEL_MAX_CHARS);
        assert!(label.ends_with("..."));
        let preview = compact_rlm_text("  a\nshort   answer ");
        assert_eq!(preview, "a short answer");
        let long_answer = "x".repeat(ANSWER_PREVIEW_MAX_CHARS + 50);
        let preview = compact_rlm_text(&long_answer);
        assert_eq!(preview.chars().count(), ANSWER_PREVIEW_MAX_CHARS);
        assert!(preview.ends_with("..."));
    }

    fn helper_layer(model: Option<&str>, thinking: Option<&str>) -> HelperDefaults {
        HelperDefaults::new(model, thinking).unwrap()
    }

    fn helper(
        dir: &Path,
        (model, thinking): (Option<&str>, Option<&str>),
        session: &HelperDefaults,
        settings: &HelperDefaults,
    ) -> Result<ResolvedHelper> {
        resolve_helper(
            dir,
            HelperRequest {
                model,
                thinking,
                parent_model: Some("test-provider/glm-5.3"),
                parent_thinking: None,
                session,
                settings,
            },
            "subagent",
            &crate::model_allowlist::DaemonAllowlist::Unrestricted,
        )
    }

    /// The helper order per field: the spawn call, the session override, the settings file,
    /// the parent.
    #[test]
    fn an_unpinned_spawn_takes_the_helper_defaults_in_order() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        let settings = helper_layer(Some("test-provider/glm-5.3-turbo"), Some("max"));
        let session = helper_layer(Some("test-provider/glm-5.3"), None);
        let none = HelperDefaults::default();
        // A spawn without model= gets the settings file's model; the default thinking level
        // clamps to the non-reasoning catalog model.
        assert_eq!(
            helper(dir.path(), (None, None), &none, &settings).unwrap(),
            ResolvedHelper {
                selector: "test-provider/glm-5.3-turbo".to_string(),
                model_source: HelperSource::Settings,
                thinking: Some("off".to_string()),
                thinking_source: HelperSource::Settings,
            }
        );
        // The session override beats the settings file, field by field.
        assert_eq!(
            helper(dir.path(), (None, None), &session, &settings).unwrap(),
            ResolvedHelper {
                selector: "test-provider/glm-5.3".to_string(),
                model_source: HelperSource::Session,
                thinking: Some("off".to_string()),
                thinking_source: HelperSource::Settings,
            }
        );
        // The spawn call's own values beat both.
        assert_eq!(
            helper(
                dir.path(),
                (Some("glm-5.3-turbo"), Some("off")),
                &session,
                &settings
            )
            .unwrap(),
            ResolvedHelper {
                selector: "test-provider/glm-5.3-turbo".to_string(),
                model_source: HelperSource::Spawn,
                thinking: Some("off".to_string()),
                thinking_source: HelperSource::Spawn,
            }
        );
        // Nothing configured: the parent's model, and the host keeps the parent's level.
        assert_eq!(
            helper(dir.path(), (None, None), &none, &none).unwrap(),
            ResolvedHelper {
                selector: "test-provider/glm-5.3".to_string(),
                model_source: HelperSource::Parent,
                thinking: None,
                thinking_source: HelperSource::Parent,
            }
        );
    }

    /// An unknown default never fails a spawn: it falls back to the parent's model. The spawn
    /// call's own model and thinking level keep their strict checks.
    #[test]
    fn an_unknown_default_falls_back_to_the_parent_but_a_pinned_one_fails() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        let none = HelperDefaults::default();
        let unknown = helper_layer(Some("cpa-r/missing-helper"), Some("high"));
        assert_eq!(
            helper(dir.path(), (None, None), &none, &unknown).unwrap(),
            ResolvedHelper {
                selector: "test-provider/glm-5.3".to_string(),
                model_source: HelperSource::Parent,
                thinking: Some("off".to_string()),
                thinking_source: HelperSource::Settings,
            }
        );
        let error = helper(
            dir.path(),
            (Some("cpa-r/missing-helper"), None),
            &none,
            &none,
        )
        .unwrap_err();
        assert!(error.to_string().contains("is unavailable"), "{error}");
        let error = helper(dir.path(), (None, Some("high")), &none, &none).unwrap_err();
        assert!(error.to_string().contains("not supported"), "{error}");
        // `parent` in a default layer pins the parent's model and level past the settings file.
        let pinned = helper_layer(Some("parent"), Some("parent"));
        let settings = helper_layer(Some("test-provider/glm-5.3-turbo"), Some("off"));
        assert_eq!(
            helper(dir.path(), (None, None), &pinned, &settings).unwrap(),
            ResolvedHelper {
                selector: "test-provider/glm-5.3".to_string(),
                model_source: HelperSource::Parent,
                thinking: None,
                thinking_source: HelperSource::Parent,
            }
        );
        // The parent's own level reports the level the child runs at: clamped to the helper's
        // non-reasoning model.
        let resolved = resolve_helper_unchecked(
            dir.path(),
            HelperRequest {
                model: None,
                thinking: None,
                parent_model: Some("scripted/faux-1"),
                parent_thinking: Some("high"),
                session: &HelperDefaults::default(),
                settings: &helper_layer(Some("test-provider/glm-5.3"), None),
            },
            "subagent",
        )
        .unwrap();
        assert_eq!(
            resolved,
            ResolvedHelper {
                selector: "test-provider/glm-5.3".to_string(),
                model_source: HelperSource::Settings,
                thinking: Some("off".to_string()),
                thinking_source: HelperSource::Parent,
            }
        );
        assert!(helper_model_known(dir.path(), "parent"));
        assert!(helper_model_known(
            dir.path(),
            "test-provider/glm-5.3-turbo"
        ));
        assert!(!helper_model_known(dir.path(), "cpa-r/missing-helper"));
    }

    /// The helper model list: a spawn call naming a model off it is refused with the allowed
    /// models named; a settings default or the parent's model off it falls to its first entry; a
    /// person's choice (the session override or the session's own list) is allowed.
    #[test]
    fn the_helper_model_list_refuses_off_list_spawns_and_keeps_defaults_on_it() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        let none = HelperDefaults::default();
        let listed = |model: Option<&str>| {
            helper_layer(model, None)
                .with_models(Some(vec!["test-provider/glm-5.3-turbo".to_string()]))
        };
        let settings = listed(None);
        let refusal = "Requested subagent model \"test-provider/glm-5.3\" is not on the helper model list; use one of: test-provider/glm-5.3-turbo (or omit model= for the default)";
        let error = helper(
            dir.path(),
            (Some("test-provider/glm-5.3"), None),
            &none,
            &settings,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), refusal);
        // An unresolved reference gets the same refusal, never catalog matches off the list.
        let error = helper(dir.path(), (Some("zzz"), None), &none, &settings).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("use one of: test-provider/glm-5.3-turbo"),
            "{error}"
        );
        // A listed model, by selector or short form.
        let on_list = ResolvedHelper {
            selector: "test-provider/glm-5.3-turbo".to_string(),
            model_source: HelperSource::Spawn,
            thinking: None,
            thinking_source: HelperSource::Parent,
        };
        assert_eq!(
            helper(dir.path(), (Some("glm-5.3-turbo"), None), &none, &settings).unwrap(),
            on_list
        );
        // The parent's model and a settings default off the list fall to its first entry.
        let fallback = ResolvedHelper {
            model_source: HelperSource::List,
            ..on_list
        };
        assert_eq!(
            helper(dir.path(), (None, None), &none, &settings).unwrap(),
            fallback
        );
        assert_eq!(
            helper(
                dir.path(),
                (None, None),
                &none,
                &listed(Some("test-provider/glm-5.3"))
            )
            .unwrap(),
            fallback
        );
        // A person's choices are allowed: the session override, by default or by name, and the
        // session's own list.
        let session = helper_layer(Some("test-provider/glm-5.3"), None);
        assert_eq!(
            helper(dir.path(), (None, None), &session, &settings).unwrap(),
            ResolvedHelper {
                selector: "test-provider/glm-5.3".to_string(),
                model_source: HelperSource::Session,
                thinking: None,
                thinking_source: HelperSource::Parent,
            }
        );
        let widened = none
            .clone()
            .with_models(Some(vec!["test-provider/glm-5.3".to_string()]));
        for session in [&session, &widened] {
            assert_eq!(
                helper(
                    dir.path(),
                    (Some("test-provider/glm-5.3"), None),
                    session,
                    &settings
                )
                .unwrap()
                .selector,
                "test-provider/glm-5.3"
            );
        }
        // No settings list: the session's list limits nothing.
        assert_eq!(
            helper(
                dir.path(),
                (Some("test-provider/glm-5.3"), None),
                &widened,
                &none
            )
            .unwrap()
            .selector,
            "test-provider/glm-5.3"
        );
        // The fallback is the first entry itself: one the catalog lacks fails the spawn.
        let missing_first = none.clone().with_models(Some(vec![
            "cpa-r/missing-helper".to_string(),
            "test-provider/glm-5.3-turbo".to_string(),
        ]));
        let error = helper(dir.path(), (None, None), &none, &missing_first).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("\"cpa-r/missing-helper\" is unavailable"),
            "{error}"
        );
    }

    /// The daemon allowlist gates the helper model like any resolved model.
    #[test]
    fn the_allowlist_refuses_a_helper_model_outside_it() {
        let dir = tempfile::TempDir::new().unwrap();
        write_catalog(dir.path());
        let settings = helper_layer(Some("test-provider/glm-5.3-turbo"), None);
        let error = resolve_helper(
            dir.path(),
            HelperRequest {
                model: None,
                thinking: None,
                parent_model: Some("prime-inference/z-ai/glm-5.3"),
                parent_thinking: None,
                session: &HelperDefaults::default(),
                settings: &settings,
            },
            "subagent",
            &crate::model_allowlist::DaemonAllowlist::Allowed(
                vec!["prime-inference/*".to_string()],
            ),
        )
        .unwrap_err();
        let refusal = error
            .downcast_ref::<pa_core::models::ModelAllowlistRefusal>()
            .expect("typed refusal");
        assert_eq!(refusal.selector, "test-provider/glm-5.3-turbo");
    }

    #[test]
    fn the_binding_lane_keeps_far_more_than_the_preview_cap() {
        // The collect envelope's full-answer lane: a fenced JSON output
        // longer than the 160-character roster preview binds whole from
        // it, so the bound stays far above the preview cap and only a
        // genuinely oversized payload (over ANSWER_TEXT_MAX_CHARS) sees
        // the ellipsis.
        let long = "y".repeat(ANSWER_TEXT_MAX_CHARS + 50);
        let capped = cap_text(&long, ANSWER_TEXT_MAX_CHARS);
        assert_eq!(capped.chars().count(), ANSWER_TEXT_MAX_CHARS);
        assert!(capped.ends_with("..."));
        let wide_json = format!(
            "{{\"blob\": \"{}\"}}",
            "z".repeat(ANSWER_PREVIEW_MAX_CHARS * 4)
        );
        let lane = cap_text(&wide_json, ANSWER_TEXT_MAX_CHARS);
        assert_eq!(lane, wide_json, "a wide-but-bounded JSON keeps its tail");
    }
}
