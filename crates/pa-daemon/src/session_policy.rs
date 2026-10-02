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
//! session wakes under it), and launches the session's worker with
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
use serde_json::{Map, Value};

/// The server capability a client checks before it sends the policy keys.
pub const SESSION_POLICY_CAPABILITY: &str = "session_policy";

/// The create-config key of [`SessionPolicy::offline`].
const OFFLINE_KEY: &str = "offline";
/// The create-config key of [`SessionPolicy::no_skills`].
const NO_SKILLS_KEY: &str = "noSkills";

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

    /// Keep this policy for `session_file` beside the worker descriptors in
    /// `descriptor_dir`: a worker's descriptor dies with the worker (idle
    /// passivation, a per-session stop), and the session's next worker (a
    /// wake, a revival, an open that carries no policy) starts under the
    /// recalled one. The explicit default policy is kept too: an online
    /// session stays online on a supervisor an `--offline` client started.
    ///
    /// # Errors
    ///
    /// Returns the write failure.
    pub(crate) fn remember(self, descriptor_dir: &Path, session_file: &str) -> Result<()> {
        let path = record_path(descriptor_dir, session_file);
        let mut record = Map::from_iter([("sessionFile".to_string(), Value::from(session_file))]);
        self.write_into(&mut record);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::descriptor::write_file_atomic(&path, &Value::Object(record).to_string())
    }

    /// The policy [`SessionPolicy::remember`] kept for `session_file`;
    /// `Ok(None)` when it kept none.
    ///
    /// # Errors
    ///
    /// Returns the failure for a record that exists but cannot be read
    /// (the session's next worker must not start without its policy).
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
        Self::requested(record.as_object())
            .map_err(|_| unreadable())?
            .map(Some)
            .ok_or_else(unreadable)
    }

    /// The policy a durable create command carries; `None` for a worker
    /// created without one (a pre-policy client).
    #[must_use]
    pub(crate) fn carried(rest: &Map<String, Value>) -> Option<Self> {
        Self::requested(Some(rest)).ok().flatten()
    }
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
        let factory = SessionPolicy {
            offline: true,
            no_skills: true,
        };
        assert_eq!(SessionPolicy::recalled(&descriptors, &file).unwrap(), None);
        factory.remember(&descriptors, &file).unwrap();
        assert_eq!(
            SessionPolicy::recalled(&descriptors, spelled).unwrap(),
            Some(factory)
        );
        SessionPolicy::default()
            .remember(&descriptors, spelled)
            .unwrap();
        assert_eq!(
            SessionPolicy::recalled(&descriptors, &file).unwrap(),
            Some(SessionPolicy::default())
        );
        std::fs::write(record_path(&descriptors, &file), "{\"sessionFile\": \"x\"}").unwrap();
        let error = SessionPolicy::recalled(&descriptors, &file)
            .unwrap_err()
            .to_string();
        assert!(error.ends_with("is not a policy"), "{error}");
    }

    #[test]
    fn a_worker_created_before_the_policy_runs_under_the_default() {
        assert_eq!(
            SessionPolicy::durable(json!({ "cwd": "/w" }).as_object().unwrap()),
            SessionPolicy::default()
        );
    }
}
