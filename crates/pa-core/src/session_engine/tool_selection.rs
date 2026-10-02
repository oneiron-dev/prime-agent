//! Session tool selection: which of a session's tools are active, from the
//! launch flags `--tools <list>`, `--no-tools` and `--no-builtin-tools`
//! (TS `createAgentSession`'s `allowedToolNames`/`initialActiveToolNames`
//! plus `_refreshToolRegistry`). One policy for every surface: the engine
//! filters both the request's tool definitions and the executable tools
//! through it, so a tool the model cannot see can never run.
//!
//! Precedence (the shipped TS build, independent of argument order): an
//! explicit `--tools` list, empty included, is the allowlist and wins over
//! both disable flags; otherwise `--no-tools` activates nothing; otherwise
//! `--no-builtin-tools` keeps only supplied (non-built-in) tools; otherwise
//! the defaults. Names that match no registered tool are dropped, and a
//! name listed twice activates once.

use pa_types::daemon::ToolSelectionFlags;

/// The resolved selection policy for one session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ToolSelection {
    /// No flag: every supplied tool plus the built-in `ipython`.
    #[default]
    Defaults,
    /// `--no-tools`: no tool at all.
    NoTools,
    /// `--no-builtin-tools`: the supplied tools only.
    SuppliedOnly,
    /// `--tools <list>`: exactly the registered tools named, in list order.
    Allowlist(Vec<String>),
}

impl ToolSelection {
    /// Resolve the launch flags (the precedence in the module docs).
    #[must_use]
    pub fn from_flags(flags: &ToolSelectionFlags) -> Self {
        if let Some(tools) = &flags.tools {
            return Self::Allowlist(tools.clone());
        }
        if flags.no_tools {
            return Self::NoTools;
        }
        if flags.no_builtin_tools {
            return Self::SuppliedOnly;
        }
        Self::Defaults
    }

    /// The active tools out of the session's registry: the `supplied`
    /// tools first, then the `builtins` no supplied tool shadows (a supplied
    /// tool replaces a built-in of the same name, as TS custom tools do).
    /// `name` reads a tool's registered name.
    pub fn select<T>(
        &self,
        supplied: Vec<T>,
        builtins: Vec<T>,
        name: impl Fn(&T) -> &str,
    ) -> Vec<T> {
        let mut registry: Vec<(bool, T)> = Vec::new();
        for (is_builtin, tool) in supplied
            .into_iter()
            .map(|tool| (false, tool))
            .chain(builtins.into_iter().map(|tool| (true, tool)))
        {
            if !registry
                .iter()
                .any(|(_, registered)| name(registered) == name(&tool))
            {
                registry.push((is_builtin, tool));
            }
        }
        match self {
            Self::Defaults => registry.into_iter().map(|(_, tool)| tool).collect(),
            Self::NoTools => Vec::new(),
            Self::SuppliedOnly => registry
                .into_iter()
                .filter(|(is_builtin, _)| !is_builtin)
                .map(|(_, tool)| tool)
                .collect(),
            Self::Allowlist(allowed) => {
                let mut active = Vec::new();
                for wanted in allowed {
                    if let Some(at) = registry
                        .iter()
                        .position(|(_, tool)| name(tool) == wanted.as_str())
                    {
                        active.push(registry.remove(at).1);
                    }
                }
                active
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(tools: Option<&[&str]>, no_tools: bool, no_builtin_tools: bool) -> ToolSelectionFlags {
        ToolSelectionFlags {
            tools: tools.map(|names| names.iter().map(|name| (*name).to_string()).collect()),
            no_tools,
            no_builtin_tools,
        }
    }

    fn active(selection: &ToolSelection) -> Vec<&'static str> {
        selection.select(vec!["echo", "ipython-custom"], vec!["ipython"], |name| name)
    }

    #[test]
    fn the_explicit_list_wins_over_both_disable_flags() {
        let resolved: Vec<ToolSelection> = [
            flags(None, false, false),
            flags(None, true, false),
            flags(None, false, true),
            flags(None, true, true),
            flags(Some(&["ipython"]), true, false),
            flags(Some(&["ipython"]), false, true),
            flags(Some(&["ipython"]), true, true),
            flags(Some(&[]), false, false),
        ]
        .iter()
        .map(ToolSelection::from_flags)
        .collect();
        assert_eq!(
            resolved,
            vec![
                ToolSelection::Defaults,
                ToolSelection::NoTools,
                ToolSelection::SuppliedOnly,
                ToolSelection::NoTools,
                ToolSelection::Allowlist(vec!["ipython".to_string()]),
                ToolSelection::Allowlist(vec!["ipython".to_string()]),
                ToolSelection::Allowlist(vec!["ipython".to_string()]),
                ToolSelection::Allowlist(Vec::new()),
            ]
        );
    }

    #[test]
    fn each_policy_picks_its_tools_from_the_registry() {
        let allow = |names: &[&str]| {
            ToolSelection::Allowlist(names.iter().map(|name| (*name).to_string()).collect())
        };
        assert_eq!(
            [
                ToolSelection::Defaults,
                ToolSelection::NoTools,
                ToolSelection::SuppliedOnly,
                allow(&["ipython"]),
                allow(&[]),
                allow(&["echo"]),
                allow(&["ipython", "nope", "echo", "ipython"]),
            ]
            .iter()
            .map(active)
            .collect::<Vec<_>>(),
            vec![
                vec!["echo", "ipython-custom", "ipython"],
                vec![],
                vec!["echo", "ipython-custom"],
                vec!["ipython"],
                vec![],
                vec!["echo"],
                vec!["ipython", "echo"],
            ]
        );
    }

    #[test]
    fn a_supplied_tool_shadows_the_builtin_of_the_same_name() {
        let supplied = vec![("ipython", "supplied")];
        let builtins = vec![("ipython", "builtin")];
        assert_eq!(
            ToolSelection::Defaults.select(supplied.clone(), builtins.clone(), |tool| tool.0),
            vec![("ipython", "supplied")]
        );
        assert_eq!(
            ToolSelection::SuppliedOnly.select(supplied, builtins, |tool| tool.0),
            vec![("ipython", "supplied")]
        );
    }
}
