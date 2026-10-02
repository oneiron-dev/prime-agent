//! The session tool-selection flags on the create contract (fork-only, kept
//! after upstream #3211 deleted them): TS `--tools <list>`, `--no-tools` and
//! `--no-builtin-tools` under their `AgentSessionRuntimeConfig` names
//! (`tools`, `noTools`, `noBuiltinTools`). The policy that turns them into
//! a session's active tools lives in `pa-core`; this is the wire vocabulary
//! the CLI, the TUI and the daemon share.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The server capability a daemon advertises when its `create` honors the
/// tool-selection keys. A client must not send a non-default selection to a
/// daemon without it: an older daemon ignores the keys and would run the
/// session with every tool enabled.
pub const SESSION_TOOL_SELECTION_CAPABILITY: &str = "session_tool_selection";

/// The tool-selection flags as given at launch. `tools: Some(vec![])` (an
/// explicit empty `--tools ""`) differs from `None` (no `--tools`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSelectionFlags {
    /// The explicit allowlist (`--tools`); it wins over both disable flags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    /// `--no-tools`: no tools unless `tools` names some.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_tools: bool,
    /// `--no-builtin-tools`: only supplied (non-built-in) tools unless
    /// `tools` names some.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_builtin_tools: bool,
}

impl ToolSelectionFlags {
    /// True when no flag was given: the session gets its default tools.
    #[must_use]
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }

    /// Read the flags from a `create` config object (absent keys are the
    /// defaults).
    ///
    /// # Errors
    ///
    /// Returns the serde error when a key has the wrong type (`noTools` not
    /// a boolean, `tools` not a list of strings).
    pub fn from_create_config(config: &Value) -> Result<Self, serde_json::Error> {
        let mut flags = Self::default();
        if let Some(tools) = config.get("tools") {
            flags.tools = serde_json::from_value(tools.clone())?;
        }
        if let Some(no_tools) = config.get("noTools") {
            flags.no_tools = serde_json::from_value(no_tools.clone())?;
        }
        if let Some(no_builtin_tools) = config.get("noBuiltinTools") {
            flags.no_builtin_tools = serde_json::from_value(no_builtin_tools.clone())?;
        }
        Ok(flags)
    }

    /// Write the given flags into a `create` config object; default flags
    /// write nothing, so a default create stays byte-identical to one from
    /// a build without tool selection.
    pub fn write_into_create_config(&self, config: &mut Value) {
        if let Some(tools) = &self.tools {
            config["tools"] = Value::from(tools.clone());
        }
        if self.no_tools {
            config["noTools"] = Value::Bool(true);
        }
        if self.no_builtin_tools {
            config["noBuiltinTools"] = Value::Bool(true);
        }
    }

    /// The flags in their command-line form (`--tools a,b --no-tools`), or
    /// `no tool flags` for the defaults: the wording refusals use.
    #[must_use]
    pub fn describe(&self) -> String {
        let mut parts = Vec::new();
        if let Some(tools) = &self.tools {
            parts.push(format!("--tools \"{}\"", tools.join(",")));
        }
        if self.no_tools {
            parts.push("--no-tools".to_string());
        }
        if self.no_builtin_tools {
            parts.push("--no-builtin-tools".to_string());
        }
        if parts.is_empty() {
            "no tool flags".to_string()
        } else {
            parts.join(" ")
        }
    }

    /// The refusal for sending these flags to a daemon whose hello did not
    /// advertise [`SESSION_TOOL_SELECTION_CAPABILITY`]; `None` when the
    /// flags are the defaults or the daemon supports them.
    #[must_use]
    pub fn unsupported_by_daemon(&self, daemon_supports_selection: bool) -> Option<String> {
        if self.is_default() || daemon_supports_selection {
            return None;
        }
        Some(format!(
            "the running daemon does not support --tools, --no-tools or --no-builtin-tools (it does not advertise `{SESSION_TOOL_SELECTION_CAPABILITY}`); restart it with this build, or drop the flags"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_config_round_trip_keeps_absence_and_explicit_empty_apart() {
        let cases = [
            ToolSelectionFlags::default(),
            ToolSelectionFlags {
                tools: Some(Vec::new()),
                ..ToolSelectionFlags::default()
            },
            ToolSelectionFlags {
                tools: Some(vec!["ipython".to_string()]),
                no_tools: true,
                no_builtin_tools: true,
            },
        ];
        let written: Vec<Value> = cases
            .iter()
            .map(|flags| {
                let mut config = serde_json::json!({ "cwd": "/w" });
                flags.write_into_create_config(&mut config);
                config
            })
            .collect();
        assert_eq!(
            written,
            vec![
                serde_json::json!({ "cwd": "/w" }),
                serde_json::json!({ "cwd": "/w", "tools": [] }),
                serde_json::json!({
                    "cwd": "/w",
                    "tools": ["ipython"],
                    "noTools": true,
                    "noBuiltinTools": true,
                }),
            ]
        );
        let read: Vec<ToolSelectionFlags> = written
            .iter()
            .map(|config| ToolSelectionFlags::from_create_config(config).unwrap())
            .collect();
        assert_eq!(read, cases);
    }

    #[test]
    fn a_wrongly_typed_key_is_an_error_not_a_default() {
        for config in [
            serde_json::json!({ "noTools": "yes" }),
            serde_json::json!({ "tools": "ipython" }),
            serde_json::json!({ "noBuiltinTools": 1 }),
        ] {
            assert!(ToolSelectionFlags::from_create_config(&config).is_err());
        }
    }

    #[test]
    fn only_a_non_default_selection_needs_the_capability() {
        let restricted = ToolSelectionFlags {
            no_tools: true,
            ..ToolSelectionFlags::default()
        };
        assert_eq!(
            [
                ToolSelectionFlags::default().unsupported_by_daemon(false),
                restricted.unsupported_by_daemon(true),
                restricted
                    .unsupported_by_daemon(false)
                    .is_some()
                    .then_some(String::new()),
            ],
            [None, None, Some(String::new())]
        );
    }
}
