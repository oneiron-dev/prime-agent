//! The per-session policy a create config carries (fork schema revision
//! 31): `offline` (TS `--offline`, "disable startup network operations")
//! and `noSkills` (TS `--no-skills`, no skill discovery). A client sends
//! both keys only to a daemon that advertises [`SESSION_POLICY_CAPABILITY`];
//! a create without them is a pre-policy client and keeps the old behavior
//! (no policy, no reuse check).
//!
//! The supervisor validates the keys, persists them in the worker's durable
//! create command (so a respawn or a relaunch rebuilds the same session)
//! and in a per-session record that outlives the worker (so a passivated
//! session wakes under it; [`SessionLaunch`] keeps the session's tool
//! selection there too), and launches the session's worker with
//! `PI_OFFLINE=1` (offline) or without any inherited `PI_OFFLINE` (online)
//! in THAT worker's environment; its own environment and every other
//! worker stay as they are. A create that reuses a live worker must ask
//! for the policy the worker runs under: a mismatch is refused, never
//! applied to (or silently ignored by) another client's session.
//!
//! The offline boundary is the TS one: the worker's startup network
//! operations (catalog and private-model refreshes, package installs and
//! update checks, version checks, telemetry) stay off. Provider inference,
//! the kernel's own environment provisioning, explicit MCP handshakes and
//! whatever the model's tools run are not blocked; it is not a firewall.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use pa_types::daemon::ToolSelectionFlags;
use serde_json::{Map, Value};

/// The server capability a client checks before it sends the policy keys.
pub const SESSION_POLICY_CAPABILITY: &str = "session_policy";

/// The create-config key of [`SessionPolicy::offline`].
const OFFLINE_KEY: &str = "offline";
/// The create-config key of [`SessionPolicy::no_skills`].
const NO_SKILLS_KEY: &str = "noSkills";

/// The create-config keys of the launch tool selection
/// (`session_tool_selection`, [`ToolSelectionFlags`]).
const TOOL_SELECTION_KEYS: [&str; 3] = ["tools", "noTools", "noBuiltinTools"];

/// The offline switch every offline-aware subsystem reads (TS `PI_OFFLINE`).
pub(crate) const OFFLINE_ENV: &str = "PI_OFFLINE";

/// Whether this process runs offline: `PI_OFFLINE` is `1`, `true` or `yes`
/// (any case), the predicate the catalog, package and private-model
/// subsystems share.
pub(crate) fn process_is_offline() -> bool {
    std::env::var(OFFLINE_ENV).is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes"
        )
    })
}

/// One hosted session's policy.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionPolicy {
    /// Run the session's worker offline (`PI_OFFLINE=1`; telemetry off).
    pub offline: bool,
    /// No skill discovery: explicitly passed `skills` paths still load.
    pub no_skills: bool,
}

impl SessionPolicy {
    /// True for the policy a session without either flag runs under.
    #[must_use]
    pub fn is_default(self) -> bool {
        self == Self::default()
    }

    /// Write both keys into a create config (or a durable create command).
    pub fn write_into(self, config: &mut Map<String, Value>) {
        config.insert(OFFLINE_KEY.to_string(), Value::Bool(self.offline));
        config.insert(NO_SKILLS_KEY.to_string(), Value::Bool(self.no_skills));
    }

    /// The flags this policy stands for, as the user typed them.
    #[must_use]
    pub fn flags(self) -> String {
        match (self.offline, self.no_skills) {
            (true, true) => "--offline --no-skills".to_string(),
            (true, false) => "--offline".to_string(),
            (false, true) => "--no-skills".to_string(),
            (false, false) => "neither --offline nor --no-skills".to_string(),
        }
    }

    /// The policy a create config asks for: `Ok(None)` when it carries
    /// neither key (a pre-policy client), a missing key is `false`.
    ///
    /// # Errors
    ///
    /// Returns the refusal for a key that is not a boolean.
    pub(crate) fn requested(config: Option<&Map<String, Value>>) -> Result<Option<Self>> {
        let Some(config) = config else {
            return Ok(None);
        };
        let flag = |key: &str| match config.get(key) {
            None => Ok(None),
            Some(Value::Bool(value)) => Ok(Some(*value)),
            Some(_) => bail!("Invalid create config: {key} must be a boolean"),
        };
        let (offline, no_skills) = (flag(OFFLINE_KEY)?, flag(NO_SKILLS_KEY)?);
        if offline.is_none() && no_skills.is_none() {
            return Ok(None);
        }
        Ok(Some(Self {
            offline: offline.unwrap_or(false),
            no_skills: no_skills.unwrap_or(false),
        }))
    }

    /// The policy a durable create command records (a worker created
    /// before the policy existed runs under the default one).
    #[must_use]
    pub(crate) fn durable(rest: &Map<String, Value>) -> Self {
        let flag = |key: &str| rest.get(key) == Some(&Value::Bool(true));
        Self {
            offline: flag(OFFLINE_KEY),
            no_skills: flag(NO_SKILLS_KEY),
        }
    }

    /// The policy a durable create command carries; `None` for a worker
    /// created without one (a pre-policy client).
    #[must_use]
    pub(crate) fn carried(rest: &Map<String, Value>) -> Option<Self> {
        Self::requested(Some(rest)).ok().flatten()
    }
}

/// What a session's next worker starts under, beyond the worker that runs
/// it now: the session policy and the launch tool selection
/// (`session_tool_selection`). Each part is `None` when the create (or the
/// durable create command) carried none of its keys: a pre-policy or
/// pre-selection client, a daemon-initiated wake or revival, an RLM
/// child's first create.
///
/// A worker's descriptor dies with the worker (idle passivation, a
/// per-session stop), so the supervisor keeps both parts in one
/// per-session record wherever the session file changes (the create, every
/// identity move), and a create that carries neither part's keys starts
/// under the recalled one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SessionLaunch {
    pub(crate) policy: Option<SessionPolicy>,
    pub(crate) tool_selection: Option<ToolSelectionFlags>,
}

impl SessionLaunch {
    /// The launch a create config asks for. A client that sends the policy
    /// keys (the hosted client, against a daemon that advertises
    /// [`SESSION_POLICY_CAPABILITY`]) sends its whole launch: its tool
    /// selection is the one it sent, the defaults when it sent no tool key.
    ///
    /// # Errors
    ///
    /// Returns the refusal for a policy or tool key of the wrong type.
    pub(crate) fn requested(config: Option<&Map<String, Value>>) -> Result<Self> {
        let policy = SessionPolicy::requested(config)?;
        let tool_selection = match config.map(tool_selection_in).transpose()?.flatten() {
            Some(selection) => Some(selection),
            None => policy.map(|_| ToolSelectionFlags::default()),
        };
        Ok(Self {
            policy,
            tool_selection,
        })
    }

    /// The launch a durable create command carries; a key of the wrong
    /// type counts as absent (the create validated it).
    #[must_use]
    pub(crate) fn carried(rest: &Map<String, Value>) -> Self {
        Self {
            policy: SessionPolicy::carried(rest),
            tool_selection: tool_selection_in(rest).ok().flatten(),
        }
    }

    /// Nothing to keep: neither part was given.
    #[must_use]
    pub(crate) fn is_empty(&self) -> bool {
        self.policy.is_none() && self.tool_selection.is_none()
    }

    /// Fill each part this launch lacks from `kept` (a recalled record, a
    /// parent's launch).
    #[must_use]
    pub(crate) fn or_from(self, kept: &Self) -> Self {
        Self {
            policy: self.policy.or(kept.policy),
            tool_selection: self.tool_selection.or_else(|| kept.tool_selection.clone()),
        }
    }

    /// Write the given parts into a durable create command (or a record):
    /// the policy's two booleans, and the selection's keys with both
    /// disable flags spelled out, so a kept default selection reads back as
    /// given rather than as absent.
    pub(crate) fn write_into(&self, rest: &mut Map<String, Value>) {
        if let Some(policy) = self.policy {
            policy.write_into(rest);
        }
        if let Some(selection) = &self.tool_selection {
            for key in TOOL_SELECTION_KEYS {
                rest.remove(key);
            }
            if let Some(tools) = &selection.tools {
                rest.insert("tools".to_string(), Value::from(tools.clone()));
            }
            rest.insert("noTools".to_string(), Value::Bool(selection.no_tools));
            rest.insert(
                "noBuiltinTools".to_string(),
                Value::Bool(selection.no_builtin_tools),
            );
        }
    }

    /// Keep this launch for `session_file` beside the worker descriptors in
    /// `descriptor_dir`: the session's next worker (a wake, a revival, an
    /// open that carries neither part) starts under the recalled one. The
    /// explicit defaults are kept too: an online session stays online on a
    /// supervisor an `--offline` client started, and a session reopened
    /// with every tool keeps them.
    ///
    /// # Errors
    ///
    /// Returns the write failure.
    pub(crate) fn remember(&self, descriptor_dir: &Path, session_file: &str) -> Result<()> {
        let path = record_path(descriptor_dir, session_file);
        let mut record = Map::from_iter([("sessionFile".to_string(), Value::from(session_file))]);
        self.write_into(&mut record);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::descriptor::write_file_atomic(&path, &Value::Object(record).to_string())
    }

    /// The launch [`SessionLaunch::remember`] kept for `session_file`;
    /// `Ok(None)` when it kept none. A kept record answers for both parts:
    /// one without selection keys (written before the record carried them)
    /// reads as the default selection.
    ///
    /// # Errors
    ///
    /// Returns the failure for a record that exists but cannot be read
    /// (the session's next worker must not start without its launch).
    pub(crate) fn recalled(descriptor_dir: &Path, session_file: &str) -> Result<Option<Self>> {
        let path = record_path(descriptor_dir, session_file);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => bail!(
                "the session policy record {} for {session_file} cannot be read: {error}",
                path.display()
            ),
        };
        let unreadable = || {
            anyhow::anyhow!(
                "the session policy record {} for {session_file} is not a policy",
                path.display()
            )
        };
        let record: Value = serde_json::from_str(&text).map_err(|_| unreadable())?;
        let record = record.as_object().ok_or_else(unreadable)?;
        let policy = SessionPolicy::requested(Some(record)).map_err(|_| unreadable())?;
        let tool_selection = tool_selection_in(record).map_err(|_| unreadable())?;
        if policy.is_none() && tool_selection.is_none() {
            return Err(unreadable());
        }
        Ok(Some(Self {
            policy,
            tool_selection: Some(tool_selection.unwrap_or_default()),
        }))
    }
}

/// The tool selection a create config (or a durable create command)
/// carries; `Ok(None)` when it has none of the three keys.
fn tool_selection_in(config: &Map<String, Value>) -> Result<Option<ToolSelectionFlags>> {
    let keys: Map<String, Value> = TOOL_SELECTION_KEYS
        .iter()
        .filter_map(|key| {
            config
                .get(*key)
                .map(|value| ((*key).to_string(), value.clone()))
        })
        .collect();
    if keys.is_empty() {
        return Ok(None);
    }
    ToolSelectionFlags::from_create_config(&Value::Object(keys))
        .map(Some)
        .map_err(|error| anyhow::anyhow!("Invalid create config: {error}"))
}

/// The directory beside the worker descriptors that keeps session policies.
const POLICY_RECORDS_DIR: &str = "session-policies";

/// One session file's policy record: named by a digest of its canonical
/// path (the registry's comparison rule), so any spelling finds it.
fn record_path(descriptor_dir: &Path, session_file: &str) -> PathBuf {
    use sha2::Digest as _;
    let canonical = Path::new(session_file).canonicalize().map_or_else(
        |_| session_file.to_string(),
        |path| path.to_string_lossy().to_string(),
    );
    let digest = sha2::Sha256::digest(canonical.as_bytes());
    let name = digest[..16]
        .iter()
        .fold(String::with_capacity(32), |mut name, byte| {
            use std::fmt::Write as _;
            let _ = write!(name, "{byte:02x}");
            name
        });
    descriptor_dir
        .join(POLICY_RECORDS_DIR)
        .join(format!("{name}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn requested(config: &Value) -> Result<Option<SessionPolicy>> {
        SessionPolicy::requested(config.as_object())
    }

    #[test]
    fn a_create_without_either_key_asks_for_no_policy() {
        assert_eq!(requested(&json!({ "cwd": "/w" })).unwrap(), None);
        assert_eq!(SessionPolicy::requested(None).unwrap(), None);
    }

    #[test]
    fn written_keys_read_back_as_the_same_policy() {
        for policy in [
            SessionPolicy::default(),
            SessionPolicy {
                offline: true,
                no_skills: false,
            },
            SessionPolicy {
                offline: false,
                no_skills: true,
            },
            SessionPolicy {
                offline: true,
                no_skills: true,
            },
        ] {
            let mut config = Map::from_iter([("cwd".to_string(), json!("/w"))]);
            policy.write_into(&mut config);
            assert_eq!(
                SessionPolicy::requested(Some(&config)).unwrap(),
                Some(policy)
            );
            assert_eq!(SessionPolicy::durable(&config), policy);
        }
    }

    #[test]
    fn one_key_alone_is_a_policy_with_the_other_off() {
        assert_eq!(
            requested(&json!({ "noSkills": true })).unwrap(),
            Some(SessionPolicy {
                offline: false,
                no_skills: true,
            })
        );
    }

    #[test]
    fn a_non_boolean_key_is_refused() {
        for config in [json!({ "offline": "yes" }), json!({ "noSkills": 1 })] {
            let error = requested(&config).unwrap_err().to_string();
            assert!(error.starts_with("Invalid create config: "), "{error}");
        }
    }

    /// A remembered policy is recalled for any spelling of the session file;
    /// the explicit default replaces it (and is recalled as such), and a
    /// record that exists but is not a policy fails the recall.
    #[test]
    fn a_remembered_policy_outlives_its_worker() {
        let dir = tempfile::tempdir().unwrap();
        let descriptors = dir.path().join("daemon-workers").join("key");
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let file = sessions.join("s.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        let (file, spelled) = (
            file.to_str().unwrap().to_string(),
            sessions.join("..").join("sessions").join("s.jsonl"),
        );
        let spelled = spelled.to_str().unwrap();
        let factory = SessionLaunch {
            policy: Some(SessionPolicy {
                offline: true,
                no_skills: true,
            }),
            tool_selection: Some(ToolSelectionFlags {
                tools: Some(Vec::new()),
                no_tools: true,
                no_builtin_tools: false,
            }),
        };
        assert_eq!(SessionLaunch::recalled(&descriptors, &file).unwrap(), None);
        factory.remember(&descriptors, &file).unwrap();
        assert_eq!(
            SessionLaunch::recalled(&descriptors, spelled).unwrap(),
            Some(factory)
        );
        let defaults = SessionLaunch {
            policy: Some(SessionPolicy::default()),
            tool_selection: Some(ToolSelectionFlags::default()),
        };
        defaults.remember(&descriptors, spelled).unwrap();
        assert_eq!(
            SessionLaunch::recalled(&descriptors, &file).unwrap(),
            Some(defaults)
        );
        std::fs::write(record_path(&descriptors, &file), "{\"sessionFile\": \"x\"}").unwrap();
        let error = SessionLaunch::recalled(&descriptors, &file)
            .unwrap_err()
            .to_string();
        assert!(error.ends_with("is not a policy"), "{error}");
    }

    /// A record written before it carried the tool selection (a policy
    /// alone) reads as the default selection, never as "no record": the
    /// session's next worker starts with every tool, as it was created.
    #[test]
    fn a_record_without_selection_keys_reads_as_the_default_selection() {
        let dir = tempfile::tempdir().unwrap();
        let descriptors = dir.path().join("daemon-workers").join("key");
        let file = dir.path().join("s.jsonl").to_str().unwrap().to_string();
        let path = record_path(&descriptors, &file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            json!({ "sessionFile": file, "offline": true, "noSkills": false }).to_string(),
        )
        .unwrap();
        assert_eq!(
            SessionLaunch::recalled(&descriptors, &file).unwrap(),
            Some(SessionLaunch {
                policy: Some(SessionPolicy {
                    offline: true,
                    no_skills: false,
                }),
                tool_selection: Some(ToolSelectionFlags::default()),
            })
        );
    }

    /// The policy keys make a create's launch whole (the hosted client's
    /// default selection sends no tool key); tool keys alone are a
    /// selection without a policy; neither is an empty launch the record
    /// fills.
    #[test]
    fn a_create_asks_for_each_part_it_carries() {
        let launch = |config: Value| SessionLaunch::requested(config.as_object()).unwrap();
        assert_eq!(
            [
                launch(json!({ "cwd": "/w" })),
                launch(json!({ "cwd": "/w", "offline": true, "noSkills": true })),
                launch(json!({ "cwd": "/w", "noTools": true })),
                launch(json!({ "cwd": "/w", "noSkills": true, "tools": ["ipython"] })),
            ],
            [
                SessionLaunch::default(),
                SessionLaunch {
                    policy: Some(SessionPolicy {
                        offline: true,
                        no_skills: true,
                    }),
                    tool_selection: Some(ToolSelectionFlags::default()),
                },
                SessionLaunch {
                    policy: None,
                    tool_selection: Some(ToolSelectionFlags {
                        no_tools: true,
                        ..ToolSelectionFlags::default()
                    }),
                },
                SessionLaunch {
                    policy: Some(SessionPolicy {
                        offline: false,
                        no_skills: true,
                    }),
                    tool_selection: Some(ToolSelectionFlags {
                        tools: Some(vec!["ipython".to_string()]),
                        ..ToolSelectionFlags::default()
                    }),
                },
            ]
        );
        let error = SessionLaunch::requested(json!({ "noTools": "yes" }).as_object())
            .unwrap_err()
            .to_string();
        assert!(error.starts_with("Invalid create config: "), "{error}");
    }

    /// A launch written into a durable create command reads back whole,
    /// the explicit default selection included; a missing part is filled
    /// from the kept one and a given part never is.
    #[test]
    fn a_durable_launch_reads_back_and_fills_only_its_missing_parts() {
        let no_tools = ToolSelectionFlags {
            no_tools: true,
            ..ToolSelectionFlags::default()
        };
        for launch in [
            SessionLaunch {
                policy: None,
                tool_selection: Some(no_tools.clone()),
            },
            SessionLaunch {
                policy: Some(SessionPolicy::default()),
                tool_selection: Some(ToolSelectionFlags::default()),
            },
        ] {
            let mut rest = Map::from_iter([("noTools".to_string(), json!("stale"))]);
            launch.write_into(&mut rest);
            assert_eq!(SessionLaunch::carried(&rest), launch);
        }
        let kept = SessionLaunch {
            policy: Some(SessionPolicy {
                offline: true,
                no_skills: true,
            }),
            tool_selection: Some(no_tools),
        };
        assert_eq!(
            [
                SessionLaunch::default().or_from(&kept),
                SessionLaunch {
                    policy: None,
                    tool_selection: Some(ToolSelectionFlags::default()),
                }
                .or_from(&kept),
            ],
            [
                kept.clone(),
                SessionLaunch {
                    policy: kept.policy,
                    tool_selection: Some(ToolSelectionFlags::default()),
                },
            ]
        );
    }

    #[test]
    fn a_worker_created_before_the_policy_runs_under_the_default() {
        assert_eq!(
            SessionPolicy::durable(json!({ "cwd": "/w" }).as_object().unwrap()),
            SessionPolicy::default()
        );
    }
}
