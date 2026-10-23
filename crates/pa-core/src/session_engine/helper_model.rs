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
        }
    }
}

/// One layer of helper defaults: a model reference (`provider/model-id` or `parent`) and a
/// thinking level (a level name or `parent`). `None` leaves the field to the next layer.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HelperDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
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
        })
    }

    /// True when the layer names neither field.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.thinking.is_none()
    }

    /// Fill each field this layer lacks from `fallback`.
    #[must_use]
    pub fn or(self, fallback: &Self) -> Self {
        Self {
            model: self.model.or_else(|| fallback.model.clone()),
            thinking: self.thinking.or_else(|| fallback.thinking.clone()),
        }
    }

    /// The settings-file layer (`subagentDefaultModel`/`subagentDefaultThinking`).
    #[must_use]
    pub fn from_settings(settings: &SettingsManager) -> Self {
        Self {
            model: settings.get_subagent_default_model(),
            thinking: settings.get_subagent_default_thinking(),
        }
    }

    /// The settings-file layer read from disk for one cwd and agent dir.
    #[must_use]
    pub fn load_settings(cwd: &std::path::Path, agent_dir: &std::path::Path) -> Self {
        Self::from_settings(&SettingsManager::create(cwd, agent_dir))
    }

    /// The layer a create config carries (`subagentModel`/`subagentThinking`); a key of the
    /// wrong type or an invalid level reads as unset.
    #[must_use]
    pub fn from_create_config(config: &Map<String, Value>) -> Self {
        let field = |key: &str| config.get(key).and_then(Value::as_str);
        Self::new(
            field(SUBAGENT_MODEL_CONFIG_KEY),
            field(SUBAGENT_THINKING_CONFIG_KEY),
        )
        .unwrap_or_default()
    }

    /// Write the layer into a create config; unset fields write nothing.
    pub fn write_into(&self, config: &mut Map<String, Value>) {
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

/// Record that a default model reference failed to resolve: `true` the first time this process
/// sees the reference from this layer, so the caller warns once.
#[must_use]
pub fn first_unknown_helper_model(reference: &str, source: HelperSource) -> bool {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(format!("{}\u{0}{reference}", source.wire_name()))
}

/// The warning line for a default helper model the catalog does not know.
#[must_use]
pub fn unknown_helper_model_warning(reference: &str, source: HelperSource) -> String {
    let origin = match source {
        HelperSource::Settings => "subagentDefaultModel",
        HelperSource::Session => "The session's helper model",
        HelperSource::Spawn | HelperSource::Parent => "The helper model",
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
    Some(HelperDefaults::new(field("model"), field("thinking")).unwrap_or_default())
}

/// The fields of the `custom` session entry that persists one override (the worker's
/// `SessionFile::persist_entry("custom", ...)`); unset fields persist as `null`.
#[must_use]
pub fn session_override_row(layer: &HelperDefaults) -> Value {
    serde_json::json!({
        "customType": SUBAGENT_MODEL_STATE_CUSTOM_TYPE,
        "data": { "model": layer.model, "thinking": layer.thinking },
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
        let override_layer = layer(Some("cpa-r/deepseek-flash-1017"), Some("max"));
        let mut config = Map::new();
        override_layer.write_into(&mut config);
        assert_eq!(HelperDefaults::from_create_config(&config), override_layer);
        // A malformed level reads as no override, never a create failure.
        config.insert(
            SUBAGENT_THINKING_CONFIG_KEY.to_string(),
            Value::String("loud".into()),
        );
        assert_eq!(
            HelperDefaults::from_create_config(&config),
            HelperDefaults::default()
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
                row(&layer(Some("cpa-r/deepseek-flash-1017"), Some("max"))),
                r#"{"type":"message","id":"m"}"#.to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        let path = file.to_string_lossy().to_string();
        assert_eq!(
            persisted_session_override(Some(&path)),
            Some(layer(Some("cpa-r/deepseek-flash-1017"), Some("max")))
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
        assert!(first_unknown_helper_model(
            reference,
            HelperSource::Settings
        ));
        assert!(!first_unknown_helper_model(
            reference,
            HelperSource::Settings
        ));
        assert!(first_unknown_helper_model(reference, HelperSource::Session));
    }
}
