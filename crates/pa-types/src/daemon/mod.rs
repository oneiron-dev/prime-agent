//! Daemon wire protocol (TS `daemon-protocol.ts`, `daemon-worker-protocol.ts`): the local JSONL
//! transport between clients (TUI/CLI), the supervisor, and per-session workers; shapes match the
//! TS
//! wire exactly, payloads owned by other subsystems ride as opaque [`Value`]s.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::session::AgentMessage;
use crate::JsonMap;

pub const DAEMON_PROTOCOL_NAME: &str = "prime-agent.daemon";
pub const DAEMON_PROTOCOL_VERSION: u64 = 7;
/// Revision 30 publishes `deletedDescendantUsage` on saved-session rows
/// (TS #2506's field, landing ahead of TS main: the Rust deletion lifecycle
/// captures the tombstoned child's usage durably before any unlink, so the
/// field is populated where TS's open PR reads a removed path).
/// The Oneiron fork used revision 31 for its additions:
/// - the create failure of a worker that died during startup is typed
///   (`errorInfo.code: "worker_startup_failed"`, server capability
///   `worker_startup_failure`); older clients read the code as `Unknown` and
///   keep the plain message;
/// - the capability-gated `create` keys `tools`/`noTools`/`noBuiltinTools`
///   (server capability `session_tool_selection`) and the worker summary's
///   `toolSelection`;
/// - the capability-gated `create` keys `offline`/`noSkills` (server
///   capability `session_policy`): a hosted session's `--offline` and
///   `--no-skills`.
///
/// Combined revision 32 includes those fork additions and upstream's schema-30
/// changes plus its `mark_anthropic_warning_shown` command and the `renamedBy`
/// and `waitForRlmQuiescence` fields. Its fresh identity keeps a pre-merge
/// revision-31 daemon from passing the schema probe.
///
/// Combined revision 33 is the sync to upstream 71beca947. It adds upstream's
/// transcript paging (`get_messages` with `page`, `capabilities` and
/// `historyLeafId`, which the TUI sends without a capability gate) and the
/// `list_persistent_shells`, `tail_persistent_shell` and
/// `kill_persistent_shell` commands. Upstream kept its own schema id for
/// these, so the fork takes a fresh identity again: a revision-32 daemon
/// reads as stale to a revision-33 client, and the reverse.
pub const DAEMON_SCHEMA_REVISION: u64 = 33;
pub const DAEMON_SCHEMA_ID: &str = "protocol-7-schema-33-20261024a1f7";

/// Fork-only server capability (no schema bump: a client checks it before it sends either
/// command): the daemon answers `get_subagent_model_status` and `set_subagent_model`, the
/// session's helper-model override, and its RLM creates carry `subagentModel`/`subagentThinking`.
pub const SUBAGENT_MODEL_CAPABILITY: &str = "subagent_model";

/// Fork-only server capability (no schema bump): the daemon enforces the helper model list
/// (settings `subagentModels`) on spawns, answers `set_subagent_models`, reports the list in
/// `get_subagent_model_status`, and its RLM creates carry `subagentModels`.
pub const SUBAGENT_MODELS_CAPABILITY: &str = "subagent_models";

pub type DaemonClientId = String;
pub type DaemonCommandId = String;
pub type DaemonEventId = String;
pub type DaemonEventSequence = u64;
/// Client/server capability wire strings (closed TS unions, open on the wire, so raw strings).
pub type DaemonClientCapability = String;
pub type DaemonServerCapability = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonProtocolInfo {
    pub name: String,
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEventCursor {
    pub generation: String,
    pub sequence: DaemonEventSequence,
}

/// Resume cursor accepted on attach. The TS wire shape is a union (`DaemonEventCursor`, or a bare
/// `eventSequence`, each with optional `activeSessionId`); this optional-field struct accepts both
/// forms and serializes each back to its original shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonResumeCursor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<DaemonEventSequence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_sequence: Option<DaemonEventSequence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonReplayStatus {
    Complete,
    Partial,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonReplayInfo {
    pub status: DaemonReplayStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_sequence: Option<DaemonEventSequence>,
    pub to_sequence: DaemonEventSequence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_cursor: Option<DaemonEventCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_cursor: Option<DaemonEventCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEventMeta {
    pub id: DaemonEventId,
    pub protocol: DaemonProtocolInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<DaemonEventSequence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<DaemonEventCursor>,
    pub emitted_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replayed: Option<bool>,
}

pub mod agent_roster;
mod command;
pub mod framing;
pub mod herdr_env;
pub mod launch_env;
mod outbound;
mod plane;
mod tool_selection;
pub mod update_flow;
mod worker;

pub use command::{
    CycleDirection, DaemonCommand, DaemonCommandEnvelope, DaemonCommandFrameType,
    DaemonCommandWire, DaemonSessionLifecycle, ForkPosition, PromptInput, StreamingBehavior,
    TranscriptPage,
};
pub use outbound::{
    DaemonClosingReason, DaemonErrorInfo, DaemonEventEnvelope, DaemonOutbound,
    DaemonPeerTransportTicket, DaemonResponse, DaemonRuntimeIdentity, DaemonSavedSessionInfo,
    DaemonSessionClosedReason, DaemonSessionSnapshot, SnapshotPurpose, SocketIdentity,
    KERNEL_NOT_RUNNING_MESSAGE, UPDATE_RESTART_PREPARING_MESSAGE,
};
pub use plane::{
    command_plane, is_daemon_mutating_command, is_session_plane_daemon_command,
    is_update_drain_command, DaemonCommandPlane,
};
pub use tool_selection::{ToolSelectionFlags, SESSION_TOOL_SELECTION_CAPABILITY};
pub use update_flow::{
    legacy_update_restart_status, legacy_update_restarts_dir, prepared_marker_expiry,
    socket_update_dir, update_intent_path, update_marker_path, update_prepared_dir,
    update_restarts_dir, update_roster_path, update_status_path, update_transition_allowed,
    PreparedMarkerExpiry, UpdateHeartbeatDeliveryMode, UpdateHeartbeatStatus, UpdateId,
    UpdateIntent, UpdatePreparedMarker, UpdateProcessIdentity, UpdateRoster, UpdateRosterBinary,
    UpdateRosterHeartbeat, UpdateRosterInFlight, UpdateRosterQueue, UpdateRosterSession,
    UpdateRosterSessionKind, UpdateRosterSubagent, UpdateRosterSubagentStatus, UpdateRosterWorker,
    UpdateState, UpdateStatus, UpdateStatusCounts, UpdateStatusFailure, UpdateSupervisorIdentity,
    UpdateTimeoutBudget, UPDATE_ENV_PREFIX, UPDATE_ROSTER_FORMAT_VERSION,
    UPDATE_STATUS_FORMAT_VERSION,
};
pub use worker::{
    DaemonPeerCommand, DaemonUpdateRestartManifest, DaemonUpdateRestartQueue,
    DaemonUpdateRestartSession, DaemonWorkerCommand, DaemonWorkerDescriptor,
    DaemonWorkerFrameHeader, DaemonWorkerLifecycle, DaemonWorkerPeerGrant,
    DaemonWorkerRosterOutbound, DurableDaemonCreateCommand, PayloadEncoding,
    DAEMON_UPDATE_RESTART_FORMAT_VERSION,
};

/// Round-trip helper: a parsed type must serialize back to the exact original value.
#[cfg(test)]
pub(crate) fn rt<T: serde::Serialize + for<'de> serde::Deserialize<'de>>(json: &str) {
    let original: serde_json::Value = serde_json::from_str(json).unwrap();
    let parsed: T = serde_json::from_str(json).expect("deserialize");
    let out = serde_json::to_string(&parsed).expect("serialize");
    let reparsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(original, reparsed, "round trip changed the value: {out}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_wire_bare_and_envelope() {
        rt::<DaemonCommandWire>(r#"{"type":"list","id":"c1","cwd":"/w","future":1}"#);
        rt::<DaemonCommandWire>(
            r#"{"type":"command","id":"e1","protocol":{"name":"prime-agent.daemon","version":7},"clientId":"cl","command":{"type":"prompt","activeSessionId":"s1","message":"hi","queueIfBusy":true,"extra":"kept"}}"#,
        );
    }

    #[test]
    fn resume_cursor_and_replay_roundtrip() {
        rt::<DaemonResumeCursor>(r#"{"generation":"g","sequence":3,"activeSessionId":"s"}"#);
        rt::<DaemonResumeCursor>(r#"{"activeSessionId":"s","eventSequence":3}"#);
        rt::<DaemonReplayInfo>(
            r#"{"status":"unavailable","fromSequence":1,"toSequence":5,"fromCursor":{"generation":"g","sequence":1},"toCursor":{"generation":"g","sequence":5},"reason":"event_replay_not_available"}"#,
        );
    }

    #[test]
    fn protocol_constants_match_ts() {
        assert_eq!(DAEMON_PROTOCOL_NAME, "prime-agent.daemon");
        assert_eq!(DAEMON_PROTOCOL_VERSION, 7);
        assert_eq!(DAEMON_SCHEMA_REVISION, 33);
        assert_eq!(DAEMON_SCHEMA_ID, "protocol-7-schema-33-20261024a1f7");
        assert_eq!(DAEMON_UPDATE_RESTART_FORMAT_VERSION, 1);
    }
}
