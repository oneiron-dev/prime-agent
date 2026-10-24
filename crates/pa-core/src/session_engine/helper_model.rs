//! The helper model of spawned agents (Oneiron fork): the model and thinking level an
//! `rlm.spawn` or `rlm.create_session` child runs on when the call names none.
//!
//! Each field resolves on its own; the first layer that names a value wins:
//! 1. the spawn call's `model=` / `thinking=`;
//! 2. the session override: `--subagent-model`/`--subagent-thinking`, the
//!    `PRIME_SUBAGENT_MODEL`/`PRIME_SUBAGENT_THINKING` env vars, or the TUI's
//!    `/subagent-model` (persisted in the session file as a `subagent_model_state` row);
//! 3. the settings file: `subagentDefaultModel`/`subagentDefaultThinking`;
//! 4. the parent's own model and thinking level (upstream behavior).
//!
//! The value `parent` at layer 2 or 3 stops the walk there and keeps the parent's value. Pure
//! decisions live here; each host resolves the picked model reference against its catalog (an
//! unknown default warns once and falls back to the parent's model).
//!
//! The helper model list ([`HelperModelList`], settings `subagentModels`) limits what spawned
//! agents may run on: a spawn call naming a model outside it is refused, a settings default or
//! parent model outside it falls to its first entry, and a person's choice (the session override,
//! or the session's own additions to the list) is always allowed.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use pa_types::ai::thinking_level_from_str;
use serde_json::{Map, Value};

use crate::settings::SettingsManager;

/// The env var a headless invocation reads as its session's helper model.
pub const SUBAGENT_MODEL_ENV: &str = "PRIME_SUBAGENT_MODEL";
/// The env var a headless invocation reads as its session's helper thinking level.
pub const SUBAGENT_THINKING_ENV: &str = "PRIME_SUBAGENT_THINKING";
/// The value that pins a layer to the parent's model or thinking level.
pub const INHERIT_PARENT: &str = "parent";
/// The custom session row that persists the session override.
pub const SUBAGENT_MODEL_STATE_CUSTOM_TYPE: &str = "subagent_model_state";
/// The create-config key carrying the session override's model (RLM children, durable creates).
pub const SUBAGENT_MODEL_CONFIG_KEY: &str = "subagentModel";
/// The create-config key carrying the session override's thinking level.
pub const SUBAGENT_THINKING_CONFIG_KEY: &str = "subagentThinking";
/// The env var a headless invocation reads as its session's additions to the helper model list.
pub const SUBAGENT_MODELS_ENV: &str = "PRIME_SUBAGENT_MODELS";
/// The create-config key carrying the session's additions to the helper model list.
pub const SUBAGENT_MODELS_CONFIG_KEY: &str = "subagentModels";

/// The layer a resolved helper value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperSource {
    /// The spawn call named it.
    Spawn,
    /// The session override.
    Session,
    /// The settings file.
    Settings,
    /// The parent's own value.
    Parent,
    /// The helper model list's first entry: the settings default or the parent's model fell
    /// outside the list.
    List,
}

impl HelperSource {
    /// The wire label the status command and the spawn handle carry.
    #[must_use]
    pub fn wire_name(self) -> &'static str {
        match self {
            HelperSource::Spawn => "spawn",
            HelperSource::Session => "session",
            HelperSource::Settings => "settings",
            HelperSource::Parent => "parent",
            HelperSource::List => "list",
        }
    }
}

/// One layer of helper defaults: a model reference (`provider/model-id` or `parent`), a
/// thinking level (a level name or `parent`), and models for the helper model list. `None`
/// leaves the field to the next layer.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HelperDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// The settings layer: the file's `subagentModels`. The session layer: the session's
    /// additions to that list (`--subagent-models`, `PRIME_SUBAGENT_MODELS`, `/subagent-models`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
}

impl HelperDefaults {
    /// Validate one layer: values are trimmed, an empty value is unset, and the thinking level
    /// must be a level name or `parent`.
    ///
    /// # Errors
    ///
    /// Returns the message for an unknown thinking level.
    pub fn new(model: Option<&str>, thinking: Option<&str>) -> Result<Self, String> {
        let trimmed = |value: Option<&str>| {
            value
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let thinking = trimmed(thinking);
        if let Some(level) = &thinking {
            if level != INHERIT_PARENT && thinking_level_from_str(level).is_none() {
                return Err(format!(
                    "Invalid helper thinking level \"{level}\". Valid values: {INHERIT_PARENT}, off, minimal, low, medium, high, xhigh, max"
                ));
            }
        }
        Ok(Self {
            model: trimmed(model),
            thinking,
            models: None,
        })
    }

    /// The layer with its model list replaced: entries are normalized
    /// ([`normalize_model_list`]), and a list with no entries left is unset.
    #[must_use]
    pub fn with_models(self, models: Option<Vec<String>>) -> Self {
        let models = models
            .map(|models| normalize_model_list(models.iter().map(String::as_str)))
            .filter(|models| !models.is_empty());
        Self { models, ..self }
    }

    /// True when the layer names no field.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.thinking.is_none() && self.models.is_none()
    }

    /// Fill each field this layer lacks from `fallback`.
    #[must_use]
    pub fn or(self, fallback: &Self) -> Self {
        Self {
            model: self.model.or_else(|| fallback.model.clone()),
            thinking: self.thinking.or_else(|| fallback.thinking.clone()),
            models: self.models.or_else(|| fallback.models.clone()),
        }
    }

    /// The settings-file layer (`subagentDefaultModel`/`subagentDefaultThinking`/
    /// `subagentModels`).
    #[must_use]
    pub fn from_settings(settings: &SettingsManager) -> Self {
        Self {
            model: settings.get_subagent_default_model(),
            thinking: settings.get_subagent_default_thinking(),
            models: settings.get_subagent_models(),
        }
    }

    /// The settings-file layer read from disk for one cwd and agent dir.
    #[must_use]
    pub fn load_settings(cwd: &std::path::Path, agent_dir: &std::path::Path) -> Self {
        Self::from_settings(&SettingsManager::create(cwd, agent_dir))
    }

    /// The layer a create config carries (`subagentModel`/`subagentThinking`/`subagentModels`);
    /// a key of the wrong type or an invalid level reads as unset.
    #[must_use]
    pub fn from_create_config(config: &Map<String, Value>) -> Self {
        let field = |key: &str| config.get(key).and_then(Value::as_str);
        Self::new(
            field(SUBAGENT_MODEL_CONFIG_KEY),
            field(SUBAGENT_THINKING_CONFIG_KEY),
        )
        .unwrap_or_default()
        .with_models(string_list(config.get(SUBAGENT_MODELS_CONFIG_KEY)))
    }

    /// Write the layer into a create config; unset fields write nothing.
    pub fn write_into(&self, config: &mut Map<String, Value>) {
        if let Some(models) = &self.models {
            config.insert(
                SUBAGENT_MODELS_CONFIG_KEY.to_string(),
                serde_json::json!(models),
            );
        }
        if let Some(model) = &self.model {
            config.insert(
                SUBAGENT_MODEL_CONFIG_KEY.to_string(),
                Value::String(model.clone()),
            );
        }
        if let Some(thinking) = &self.thinking {
            config.insert(
                SUBAGENT_THINKING_CONFIG_KEY.to_string(),
                Value::String(thinking.clone()),
            );
        }
    }
}

/// The string entries of a JSON array (other entries dropped); `None` for a missing or non-array
/// value.
fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|entries| {
        entries
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

/// Model-list entries as stored: trimmed, blanks dropped, repeats (ignoring case) dropped, order
/// kept.
#[must_use]
pub fn normalize_model_list<'a>(entries: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut models: Vec<String> = Vec::new();
    for entry in entries.into_iter().map(str::trim) {
        if !entry.is_empty() && !models.iter().any(|model| model.eq_ignore_ascii_case(entry)) {
            models.push(entry.to_string());
        }
    }
    models
}

/// A typed model list (`--subagent-models a,b`, `PRIME_SUBAGENT_MODELS`, `/subagent-models`):
/// entries split on commas or whitespace, then normalized.
#[must_use]
pub fn parse_model_list(text: &str) -> Vec<String> {
    normalize_model_list(text.split(|c: char| c == ',' || c.is_whitespace()))
}

/// The helper model list of one session (Oneiron fork): the models spawned agents may run on.
/// The settings file's `subagentModels` come first (so its first entry is the fallback), then the
/// session's additions and its person-set helper model, which a person chose and so are always
/// allowed. Built only by [`HelperModelList::active`], so it is never empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperModelList {
    entries: Vec<String>,
    widened: bool,
}

impl HelperModelList {
    /// The list a session's spawns check; `None` when the settings file sets none (no limit:
    /// the session's additions widen a list, they never start one).
    #[must_use]
    pub fn active(session: &HelperDefaults, settings: &HelperDefaults) -> Option<Self> {
        let base = normalize_model_list(settings.models.iter().flatten().map(String::as_str));
        if base.is_empty() {
            return None;
        }
        let person_model = session
            .model
            .as_deref()
            .filter(|model| *model != INHERIT_PARENT);
        let entries = normalize_model_list(
            base.iter()
                .chain(session.models.iter().flatten())
                .map(String::as_str)
                .chain(person_model),
        );
        Some(Self {
            widened: entries.len() > base.len(),
            entries,
        })
    }

    /// The entries in order.
    #[must_use]
    pub fn entries(&self) -> &[String] {
        &self.entries
    }

    /// The fallback for a settings default or parent model outside the list.
    #[must_use]
    pub fn first(&self) -> &str {
        &self.entries[0]
    }

    /// Whether a model reference is on the list (an exact, case-insensitive match).
    #[must_use]
    pub fn allows(&self, selector: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case(selector))
    }

    /// The status label of where the list came from: `settings`, or `settings+session` when the
    /// session added entries.
    #[must_use]
    pub fn source(&self) -> &'static str {
        if self.widened {
            "settings+session"
        } else {
            "settings"
        }
    }

    /// The refusal of a spawn call naming a model outside the list: it names the allowed models
    /// so the agent can retry with one.
    #[must_use]
    pub fn refusal(&self, reference: &str, target: &str) -> String {
        format!(
            "Requested {target} model \"{reference}\" is not on the helper model list; use one of: {} (or omit model= for the default)",
            self.entries.join(", ")
        )
    }
}

/// One field's pick: the value the winning layer names, `None` for the parent's own value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperPick {
    pub value: Option<String>,
    pub source: HelperSource,
}

/// The helper picks for one spawn, before the host resolves the model reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperPlan {
    pub model: HelperPick,
    pub thinking: HelperPick,
}

/// Walk the layers for each field: the spawn call, the session override, the settings file, the
/// parent. A `parent` value stops the walk at the parent.
#[must_use]
pub fn plan_helper(
    requested_model: Option<&str>,
    requested_thinking: Option<&str>,
    session: &HelperDefaults,
    settings: &HelperDefaults,
) -> HelperPlan {
    let pick = |requested: Option<&str>, session: Option<&str>, settings: Option<&str>| {
        let parent = HelperPick {
            value: None,
            source: HelperSource::Parent,
        };
        if let Some(value) = requested {
            // The spawn call's own value goes to the host as given (its strict checks apply).
            return HelperPick {
                value: Some(value.to_string()),
                source: HelperSource::Spawn,
            };
        }
        [
            (session, HelperSource::Session),
            (settings, HelperSource::Settings),
        ]
        .into_iter()
        .find_map(|(value, source)| value.map(|value| (value, source)))
        .map_or(parent.clone(), |(value, source)| {
            if value == INHERIT_PARENT {
                parent.clone()
            } else {
                HelperPick {
                    value: Some(value.to_string()),
                    source,
                }
            }
        })
    };
    HelperPlan {
        model: pick(
            requested_model,
            session.model.as_deref(),
            settings.model.as_deref(),
        ),
        thinking: pick(
            requested_thinking,
            session.thinking.as_deref(),
            settings.thinking.as_deref(),
        ),
    }
}

/// Record one helper-model warning line: `true` the first time this process sees it, so the
/// caller warns once.
#[must_use]
pub fn first_helper_notice(line: &str) -> bool {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(line.to_string())
}

/// The warning line for a default helper model the catalog does not know.
#[must_use]
pub fn unknown_helper_model_warning(reference: &str, source: HelperSource) -> String {
    let origin = match source {
        HelperSource::Settings => "subagentDefaultModel",
        HelperSource::Session => "The session's helper model",
        HelperSource::Spawn | HelperSource::Parent | HelperSource::List => "The helper model",
    };
    format!(
        "Warning: {origin} \"{reference}\" is not in the model catalog (models.json); spawned agents use the parent's model"
    )
}

/// The latest persisted `subagent_model_state` row of a session file: the session override a
/// resumed session re-seeds from. `Some` with both fields unset is an explicit clear; `None`
/// when the file has no row or cannot be read.
#[must_use]
pub fn persisted_session_override(path: Option<&str>) -> Option<HelperDefaults> {
    let content = std::fs::read_to_string(path?).ok()?;
    content
        .lines()
        .rev()
        // A matching row's raw text carries the `customType` literal or a `\u`-escape.
        .filter(|line| line.contains(SUBAGENT_MODEL_STATE_CUSTOM_TYPE) || line.contains("\\u"))
        .find_map(parse_override_row)
}

/// One candidate line's override: `Some` for a `subagent_model_state` custom row.
fn parse_override_row(line: &str) -> Option<HelperDefaults> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("custom")
        || value.get("customType").and_then(Value::as_str) != Some(SUBAGENT_MODEL_STATE_CUSTOM_TYPE)
    {
        return None;
    }
    let data = value.get("data").and_then(Value::as_object);
    let field = |key: &str| data.and_then(|data| data.get(key)).and_then(Value::as_str);
    Some(
        HelperDefaults::new(field("model"), field("thinking"))
            .unwrap_or_default()
            .with_models(string_list(data.and_then(|data| data.get("models")))),
    )
}

/// The fields of the `custom` session entry that persists one override (the worker's
/// `SessionFile::persist_entry("custom", ...)`); unset fields persist as `null`.
#[must_use]
pub fn session_override_row(layer: &HelperDefaults) -> Value {
    serde_json::json!({
        "customType": SUBAGENT_MODEL_STATE_CUSTOM_TYPE,
        "data": { "model": layer.model, "thinking": layer.thinking, "models": layer.models },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(model: Option<&str>, thinking: Option<&str>) -> HelperDefaults {
        HelperDefaults::new(model, thinking).unwrap()
    }

    fn pick(value: Option<&str>, source: HelperSource) -> HelperPick {
        HelperPick {
            value: value.map(str::to_string),
            source,
        }
    }

    #[test]
    fn each_field_takes_the_first_layer_that_names_it() {
        let session = layer(Some("cpa-r/kimi-k3.1"), None);
        let settings = layer(Some("cpa-r/deepseek-flash-1017"), Some("max"));
        // The spawn call wins both fields.
        assert_eq!(
            plan_helper(Some("cpa-r/astra"), Some("low"), &session, &settings),
            HelperPlan {
                model: pick(Some("cpa-r/astra"), HelperSource::Spawn),
                thinking: pick(Some("low"), HelperSource::Spawn),
            }
        );
        // No spawn values: the session override's model, the settings file's thinking.
        assert_eq!(
            plan_helper(None, None, &session, &settings),
            HelperPlan {
                model: pick(Some("cpa-r/kimi-k3.1"), HelperSource::Session),
                thinking: pick(Some("max"), HelperSource::Settings),
            }
        );
        // No override: the settings file.
        assert_eq!(
            plan_helper(None, None, &HelperDefaults::default(), &settings),
            HelperPlan {
                model: pick(Some("cpa-r/deepseek-flash-1017"), HelperSource::Settings),
                thinking: pick(Some("max"), HelperSource::Settings),
            }
        );
        // Nothing configured: the parent's model and thinking (upstream behavior).
        assert_eq!(
            plan_helper(
                None,
                None,
                &HelperDefaults::default(),
                &HelperDefaults::default()
            ),
            HelperPlan {
                model: pick(None, HelperSource::Parent),
                thinking: pick(None, HelperSource::Parent),
            }
        );
    }

    #[test]
    fn a_parent_value_stops_the_walk_at_the_parent() {
        let session = layer(Some(INHERIT_PARENT), Some(INHERIT_PARENT));
        let settings = layer(Some("cpa-r/deepseek-flash-1017"), Some("max"));
        assert_eq!(
            plan_helper(None, None, &session, &settings),
            HelperPlan {
                model: pick(None, HelperSource::Parent),
                thinking: pick(None, HelperSource::Parent),
            }
        );
        // The spawn call's own value is passed through for the host to resolve.
        assert_eq!(
            plan_helper(Some(INHERIT_PARENT), None, &session, &settings).model,
            pick(Some(INHERIT_PARENT), HelperSource::Spawn)
        );
    }

    #[test]
    fn a_layer_trims_values_and_rejects_unknown_levels() {
        assert_eq!(
            HelperDefaults::new(Some("  cpa-r/deepseek-flash-1017 "), Some(" ")).unwrap(),
            layer(Some("cpa-r/deepseek-flash-1017"), None)
        );
        let error = HelperDefaults::new(None, Some("loud")).unwrap_err();
        assert!(error.contains("\"loud\""), "{error}");
        assert_eq!(
            HelperDefaults::new(None, Some(INHERIT_PARENT)).unwrap(),
            layer(None, Some(INHERIT_PARENT))
        );
    }

    #[test]
    fn the_create_config_round_trips_the_override() {
        let override_layer = layer(Some("cpa-r/deepseek-flash-1017"), Some("max"))
            .with_models(Some(vec!["cpa-a/gpt-6".to_string()]));
        let mut config = Map::new();
        override_layer.write_into(&mut config);
        assert_eq!(HelperDefaults::from_create_config(&config), override_layer);
        // A malformed level reads as no model or thinking override, never a create failure; the
        // list keeps its own key.
        config.insert(
            SUBAGENT_THINKING_CONFIG_KEY.to_string(),
            Value::String("loud".into()),
        );
        assert_eq!(
            HelperDefaults::from_create_config(&config),
            list_layer(&["cpa-a/gpt-6"])
        );
    }

    #[test]
    fn the_settings_layer_reads_both_keys() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"subagentDefaultModel":" cpa-r/deepseek-flash-1017 ","subagentDefaultThinking":"max"}"#,
        )
        .unwrap();
        assert_eq!(
            HelperDefaults::load_settings(dir.path(), &agent_dir),
            layer(Some("cpa-r/deepseek-flash-1017"), Some("max"))
        );
        // A wrong-typed value loads as unset (the lenient settings load).
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"subagentDefaultModel":42,"subagentDefaultThinking":"loud"}"#,
        )
        .unwrap();
        assert_eq!(
            HelperDefaults::load_settings(dir.path(), &agent_dir),
            HelperDefaults::default()
        );
        // A project's `parent` overrides a global level: the walk stops at the parent.
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"subagentDefaultThinking":"max"}"#,
        )
        .unwrap();
        let project = dir.path().join(".prime").join("agent");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join("settings.json"),
            r#"{"subagentDefaultThinking":"parent"}"#,
        )
        .unwrap();
        let settings = HelperDefaults::load_settings(dir.path(), &agent_dir);
        assert_eq!(settings, layer(None, Some(INHERIT_PARENT)));
        assert_eq!(
            plan_helper(None, None, &HelperDefaults::default(), &settings).thinking,
            HelperPick {
                value: None,
                source: HelperSource::Parent,
            }
        );
    }

    #[test]
    fn the_latest_persisted_row_is_the_session_override() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("session.jsonl");
        // The entry the worker's `persist_entry("custom", ...)` writes.
        let row = |layer: &HelperDefaults| {
            let mut entry = session_override_row(layer);
            entry["type"] = Value::String("custom".to_string());
            entry.to_string()
        };
        std::fs::write(
            &file,
            [
                r#"{"type":"session","id":"s"}"#.to_string(),
                row(&layer(Some("cpa-r/kimi"), None)),
                row(&layer(Some("cpa-r/deepseek-flash-1017"), Some("max"))
                    .with_models(Some(vec!["cpa-a/gpt-6".to_string()]))),
                r#"{"type":"message","id":"m"}"#.to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        let path = file.to_string_lossy().to_string();
        assert_eq!(
            persisted_session_override(Some(&path)),
            Some(
                layer(Some("cpa-r/deepseek-flash-1017"), Some("max"))
                    .with_models(Some(vec!["cpa-a/gpt-6".to_string()]))
            )
        );
        // A cleared override is an explicit, empty row.
        let mut content = std::fs::read_to_string(&file).unwrap();
        content.push('\n');
        content.push_str(&row(&HelperDefaults::default()));
        std::fs::write(&file, content).unwrap();
        assert_eq!(
            persisted_session_override(Some(&path)),
            Some(HelperDefaults::default())
        );
        assert_eq!(persisted_session_override(None), None);
    }

    #[test]
    fn an_unknown_default_warns_once_per_reference_and_layer() {
        let reference = "cpa-r/warn-once-probe";
        let settings = unknown_helper_model_warning(reference, HelperSource::Settings);
        assert!(first_helper_notice(&settings));
        assert!(!first_helper_notice(&settings));
        assert!(first_helper_notice(&unknown_helper_model_warning(
            reference,
            HelperSource::Session
        )));
    }

    fn list_layer(models: &[&str]) -> HelperDefaults {
        HelperDefaults::default()
            .with_models(Some(models.iter().map(ToString::to_string).collect()))
    }

    /// The settings file's list comes first; the session's additions and its person-set model
    /// widen it; a session list alone starts no limit.
    #[test]
    fn the_helper_model_list_is_the_settings_list_widened_by_the_session() {
        let settings = list_layer(&["cpa-r/deepseek-flash-1017", "cpa-r/kimi-k3.1"]);
        let list = HelperModelList::active(&HelperDefaults::default(), &settings).unwrap();
        assert_eq!(
            list.entries(),
            ["cpa-r/deepseek-flash-1017", "cpa-r/kimi-k3.1"]
        );
        assert_eq!(list.first(), "cpa-r/deepseek-flash-1017");
        assert_eq!(list.source(), "settings");
        assert!(list.allows("CPA-R/Kimi-K3.1"));
        assert!(!list.allows("cpa-a/claude-opus-5"));
        assert!(!list.allows("kimi-k3.1"), "a short form is not an entry");
        assert_eq!(
            list.refusal("cpa-a/claude-opus-5", "subagent"),
            "Requested subagent model \"cpa-a/claude-opus-5\" is not on the helper model list; use one of: cpa-r/deepseek-flash-1017, cpa-r/kimi-k3.1 (or omit model= for the default)"
        );

        // A person's choices widen the list: the session's own entries and its helper model.
        let session = layer(Some("cpa-a/claude-opus-5"), None).with_models(Some(vec![
            "cpa-a/gpt-6".to_string(),
            "cpa-r/kimi-k3.1".to_string(),
        ]));
        let list = HelperModelList::active(&session, &settings).unwrap();
        assert_eq!(
            list.entries(),
            [
                "cpa-r/deepseek-flash-1017",
                "cpa-r/kimi-k3.1",
                "cpa-a/gpt-6",
                "cpa-a/claude-opus-5"
            ]
        );
        assert_eq!(list.source(), "settings+session");
        // `parent` is no model.
        let list = HelperModelList::active(&layer(Some(INHERIT_PARENT), None), &settings).unwrap();
        assert_eq!(list.source(), "settings");

        // No settings list: no limit, whatever the session adds.
        assert_eq!(
            HelperModelList::active(&session, &HelperDefaults::default()),
            None
        );
        assert_eq!(
            HelperModelList::active(&session, &list_layer(&[" ", ""])),
            None
        );
    }

    #[test]
    fn model_lists_parse_trim_and_drop_repeats() {
        assert_eq!(
            parse_model_list(" cpa-r/a, cpa-r/b  CPA-R/A,,cpa-r/c "),
            ["cpa-r/a", "cpa-r/b", "cpa-r/c"]
        );
        assert_eq!(parse_model_list(" , "), Vec::<String>::new());
        assert_eq!(list_layer(&[" ", ""]).models, None);
    }

    /// The settings list is global only, accepts an array (non-strings dropped) or one
    /// comma-separated string, and a project file cannot widen it.
    #[test]
    fn the_settings_list_is_global_only() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let project = dir.path().join(".prime").join("agent");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join("settings.json"),
            r#"{"subagentModels":["cpa-a/claude-opus-5"]}"#,
        )
        .unwrap();
        assert_eq!(
            HelperDefaults::load_settings(dir.path(), &agent_dir),
            HelperDefaults::default()
        );
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"subagentModels":[" cpa-r/deepseek-flash-1017 ", 42, "cpa-r/kimi-k3.1"]}"#,
        )
        .unwrap();
        assert_eq!(
            HelperDefaults::load_settings(dir.path(), &agent_dir),
            list_layer(&["cpa-r/deepseek-flash-1017", "cpa-r/kimi-k3.1"])
        );
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"subagentModels":"cpa-r/deepseek-flash-1017, cpa-r/kimi-k3.1"}"#,
        )
        .unwrap();
        assert_eq!(
            HelperDefaults::load_settings(dir.path(), &agent_dir),
            list_layer(&["cpa-r/deepseek-flash-1017", "cpa-r/kimi-k3.1"])
        );
    }
}
