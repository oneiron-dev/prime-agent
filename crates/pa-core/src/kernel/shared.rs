//! Shared constants, result shapes, and host-bridge types for the kernel layer.
//!
//! Ported from `core/kernel/shared.ts`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::kernel::bootstrap::KernelPythonSkill;

pub const DEFAULT_MAX_OUTPUT_CHARS: usize = 65_536;
pub const HOST_REQUEST_SHUTDOWN_TIMEOUT_MS: u64 = 5_000;
pub const KERNEL_SHUTDOWN_TIMEOUT_MS: u64 = 5_000;
pub const DEFAULT_SNAPSHOT_DEBOUNCE_MS: u64 = 1_500;
pub const SNAPSHOT_EXECUTION_TIMEOUT_MS: u64 = 5_000;
/// Restore deserializes everything a snapshot serializes: bounded like the repair step.
pub const RESTORE_EXECUTION_TIMEOUT_MS: u64 = 30_000;
pub const KERNEL_ABORT_GRACE_MS: u64 = 1_000;
pub const KERNEL_BUSY_REUSE_WAIT_MS: u64 = 5_000;
pub const KERNEL_BUSY_INTERRUPT_INTERVAL_MS: u64 = 500;
pub const MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS: usize = 256;
pub const KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE: &str = "The Python kernel is still running the previously interrupted cell. Wait and try again, or kill the kernel to start fresh.";

/// Cap for unattributed background output buffered between and during cells.
pub const MAX_BACKGROUND_OUTPUT_CHARS: usize = 64 * 1024;

pub const MAX_KERNEL_STDERR_CHARS: usize = 8 * 1024;
pub const MAX_KERNEL_STDERR_LOG_BYTES: u64 = 5 * 1024 * 1024;
pub const KERNEL_STDERR_LOG_BUDGET_MARKER: &str = "[stderr log budget exhausted]\n";

/// Hard ceiling on a single attachment's base64 payload, a defensive guard
/// against a runaway direct display emit. The `attach-image` skill caps its own
/// images well under this, so a skill-produced attachment is never dropped
/// here — only a non-skill emit can hit this.
pub const MAX_ATTACHMENT_DATA_CHARS: usize = 10_000_000;

/// MIME tag the `edit` skill emits diff payloads under.
pub const DIFF_DISPLAY_MIME: &str = "application/vnd.prime-agent.diff+json";
/// MIME tag the `attach-image` skill emits media payloads under.
pub const ATTACHMENT_DISPLAY_MIME: &str = "application/vnd.prime-agent.attachment+json";
/// MIME tag the `agent-message` skill emits after sending a message.
pub const AGENT_MESSAGE_DISPLAY_MIME: &str = "application/vnd.prime-agent.agent-message+json";
/// Internal lifetime notices, consumed before user display rendering.
pub const BASH_ACTIVITY_DISPLAY_MIME: &str = "application/vnd.prime-agent.bash-activity+json";

pub const EXECUTE_STATUS_OK: &str = "ok";
pub const EXECUTE_STATUS_ERROR: &str = "error";
pub const EXECUTE_STATUS_ABORTED: &str = "aborted";

/// Execution status of one cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExecuteStatus {
    #[default]
    Ok,
    Error,
    Aborted,
}

impl ExecuteStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            ExecuteStatus::Ok => EXECUTE_STATUS_OK,
            ExecuteStatus::Error => EXECUTE_STATUS_ERROR,
            ExecuteStatus::Aborted => EXECUTE_STATUS_ABORTED,
        }
    }
}

/// Stream a streamed chunk belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamName {
    Stdout,
    Stderr,
}

/// Callback receiving streamed output chunks as they arrive.
pub type StreamCallback = Arc<dyn Fn(&str, StreamName) + Send + Sync>;

/// Fires when the kernel's last live background `bash()` handle settles
/// (its activity track empties or the kernel tears down), so owed
/// continuations can resume (TS `KernelManagerOptions.onBackgroundWorkSettled`).
pub type BackgroundWorkSettledCallback = Arc<dyn Fn() + Send + Sync>;

/// Callback receiving an agent message sent late by the kernel.
pub type LateSentAgentMessageCallback = Arc<dyn Fn(KernelSentAgentMessage) + Send + Sync>;

/// One file edit, captured from a [`DIFF_DISPLAY_MIME`] display payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelDiffDisplay {
    pub path: String,
    pub old_str: String,
    pub new_str: String,
    /// 1-based line where `old_str` begins in the file, for absolute line numbers.
    pub start_line: Option<u64>,
}

/// One media attachment, captured from an [`ATTACHMENT_DISPLAY_MIME`] display payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelAttachment {
    pub mime_type: String,
    /// base64-encoded bytes.
    pub data: String,
    /// Source path, surfaced to the TUI renderer.
    pub path: Option<String>,
}

/// A delivery receipt for one agent message sent from the kernel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelSentAgentMessage {
    pub id: String,
    pub message: String,
    pub delivery_status: SentDeliveryStatus,
    pub receiver_role: Option<ReceiverRole>,
    pub target: SentAgentMessageTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SentDeliveryStatus {
    Delivered,
    Queued,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiverRole {
    Parent,
    Sibling,
    Child,
}

impl ReceiverRole {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            ReceiverRole::Parent => "parent",
            ReceiverRole::Sibling => "sibling",
            ReceiverRole::Child => "child",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentAgentMessageTarget {
    pub active_session_id: String,
    pub session_id: String,
    pub session_name: Option<String>,
}

/// The cell line a failed or stopped cell was running (the runtime's
/// `line` field: its own innermost frame, source stripped and capped).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelCellLine {
    pub lineno: i64,
    pub source: String,
}

impl KernelCellLine {
    /// The wire `{lineno, source}` object; anything else is no line (TS `asCellLine`).
    #[must_use]
    pub fn from_value(value: &Value) -> Option<Self> {
        const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
        let lineno = value.get("lineno")?.as_i64()?;
        if lineno.unsigned_abs() > MAX_SAFE_INTEGER {
            return None;
        }
        Some(Self {
            lineno,
            source: value.get("source")?.as_str()?.to_string(),
        })
    }
}

/// A kernel error reported by a failed cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelError {
    pub ename: String,
    pub evalue: String,
    pub traceback: Vec<String>,
    /// The cell's own line the error (or interrupt) happened at.
    pub line: Option<KernelCellLine>,
}

/// Result of executing one cell.
#[derive(Debug, Clone)]
pub struct ExecuteResult {
    pub stdout: String,
    pub stderr: String,
    /// Text of the cell's trailing expression value, if the cell produced one.
    pub result: Option<String>,
    /// Diffs emitted via display events, in order.
    pub diffs: Option<Vec<KernelDiffDisplay>>,
    /// Media attachments emitted via display events, in order.
    pub attachments: Option<Vec<KernelAttachment>>,
    /// Agent messages sent from this cell, in order.
    pub sent_agent_messages: Option<Vec<KernelSentAgentMessage>>,
    /// Output that arrived without this cell's id (user threads, other cells' leftovers, raw fd writes).
    pub background_output: Option<String>,
    pub status: ExecuteStatus,
    pub error: Option<KernelError>,
    pub duration_ms: u64,
    /// What the kernel memory ceiling did while no user cell ran; shown above the output.
    pub queued_memory_notices: Option<Vec<String>>,
    /// What the kernel memory ceiling did during this cell; shown after the output.
    pub memory_notices: Option<Vec<String>>,
}

/// Options for one `execute` call.
#[derive(Default)]
pub struct ExecuteOptions {
    /// Aborting interrupts the kernel out-of-band.
    pub signal: Option<crate::kernel::cancellation::AbortSignal>,
    /// Streaming callback for stdout/stderr chunks.
    pub on_stream: Option<StreamCallback>,
    /// Receives agent messages the kernel reports after the cell settled.
    pub on_late_sent_agent_message: Option<LateSentAgentMessageCallback>,
    /// Cap stdout / stderr / result at this many characters. Default 65536.
    pub max_output_chars: Option<usize>,
    /// Synthetic host cell (snapshot/restore/list); excluded from lastCellCode attribution.
    pub internal: bool,
    /// The protocol repair's own request; exempt from waiting on the repair it belongs to.
    pub protocol_repair: bool,
}

/// The error raised when a new cell cannot start because the previously
/// interrupted cell is still running.
#[derive(Debug, thiserror::Error)]
#[error("{KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE}")]
pub struct KernelBusyAfterInterruptError;

/// A typed request from Python code running in the kernel to the host.
#[derive(Debug, Clone)]
pub struct HostRequestPayload {
    /// The request payload with `cellSourceCode` merged in when known.
    pub data: Value,
    /// Source of the cell that triggered the request, when attributable.
    pub cell_source_code: Option<String>,
}

pub type HostHandlerFuture = Pin<Box<dyn Future<Output = anyhow::Result<Value>> + Send>>;
pub type HostHandlerFn = Arc<dyn Fn(HostRequestPayload) -> HostHandlerFuture + Send + Sync>;

/// Handles one typed request from Python code running in the kernel.
/// The returned value is delivered verbatim to the Python caller.
pub trait HostRequestHandler: Send + Sync {
    fn handle(&self, payload: HostRequestPayload) -> HostHandlerFuture;
}

impl<F> HostRequestHandler for F
where
    F: Fn(HostRequestPayload) -> HostHandlerFuture + Send + Sync,
{
    fn handle(&self, payload: HostRequestPayload) -> HostHandlerFuture {
        self(payload)
    }
}

/// Build a [`HostRequestHandler`] from a closure returning a future.
pub fn host_handler<F, Fut>(f: F) -> HostHandlerFn
where
    F: Fn(HostRequestPayload) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<Value>> + Send + 'static,
{
    Arc::new(move |payload| Box::pin(f(payload)) as HostHandlerFuture)
}

/// Host request handlers keyed by request type (e.g. `rlm.run`, `goal.complete`).
#[derive(Clone, Default)]
pub struct HostRequestHandlers {
    handlers: Arc<HashMap<String, HostHandlerFn>>,
}

impl HostRequestHandlers {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, request_type: impl Into<String>, handler: HostHandlerFn) {
        let mut map = Arc::try_unwrap(std::mem::take(&mut self.handlers))
            .unwrap_or_else(|shared| (*shared).clone());
        map.insert(request_type.into(), handler);
        self.handlers = Arc::new(map);
    }

    /// Merge another registry into this one; the other registry's entries
    /// win on key collisions (later registrations override).
    pub fn merge(&mut self, other: Self) {
        let other_map = Arc::try_unwrap(other.handlers).unwrap_or_else(|shared| (*shared).clone());
        let mut map = Arc::try_unwrap(std::mem::take(&mut self.handlers))
            .unwrap_or_else(|shared| (*shared).clone());
        for (key, handler) in other_map {
            map.insert(key, handler);
        }
        self.handlers = Arc::new(map);
    }

    #[must_use]
    pub fn get(&self, request_type: &str) -> Option<&HostHandlerFn> {
        self.handlers.get(request_type)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.handlers.len()
    }
}

/// Where and how to persist the kernel's user namespace so it survives resume.
#[derive(Debug, Clone)]
pub struct KernelSnapshotConfig {
    /// Absolute path for the dill payload.
    pub path: std::path::PathBuf,
    /// Absolute path for the JSON manifest written alongside the payload.
    pub manifest_path: std::path::PathBuf,
    /// Maximum aggregate snapshot size. Default 64 MiB.
    pub max_bytes: Option<u64>,
    /// Maximum serialized size of one variable. Default 8 MiB.
    pub max_variable_bytes: Option<u64>,
    /// Debounce window for the auto-snapshot after a successful execution. Default 1500 ms.
    pub debounce_ms: Option<u64>,
}

/// Options for constructing a [`ReplKernelManager`].
#[derive(Clone, Default)]
pub struct KernelManagerOptions {
    /// Python interpreter with the kernel runtime available. Defaults to the auto-bootstrapped kernel.
    pub python: Option<std::path::PathBuf>,
    pub cwd: Option<std::path::PathBuf>,
    pub env: HashMap<String, String>,
    pub session_id: Option<String>,
    pub host_handlers: HostRequestHandlers,
    pub python_skills: Vec<KernelPythonSkill>,
    /// Fires when the last live background `bash()` handle settles (its
    /// activity track empties or the kernel tears down), so owed
    /// continuations can resume.
    pub on_background_work_settled: Option<BackgroundWorkSettledCallback>,
    /// Persist/revive the user namespace across kernel restarts and session resume.
    pub snapshot: Option<KernelSnapshotConfig>,
    /// Runtime bootstrap re-run on a protocol-repaired kernel so live handles (rlm, bash, skills) exist again.
    pub bootstrap_code: Option<String>,
    /// File receiving the kernel process's stderr, rotated once at each spawn.
    pub stderr_log_path: Option<std::path::PathBuf>,
    /// Memory ceiling per kernel tree (the kernel and every process it
    /// starts) in GiB. `None` resolves `PRIME_AGENT_KERNEL_MEMORY_LIMIT_GB`,
    /// else 16; `0` turns the memory ladder off.
    pub memory_limit_gb: Option<f64>,
    /// End the heaviest kernel tree when the machine runs out of memory.
    /// `None` resolves `PRIME_AGENT_KERNEL_MEMORY_BACKSTOP`, else on.
    pub memory_backstop: Option<bool>,
    /// Reports each memory step taken, for `kernel memory action`
    /// telemetry. Telemetry only; kernel behavior never depends on it.
    pub on_memory_action: Option<KernelMemoryActionHandler>,
    /// Reports what the file-handle snapshot guard skipped or purged, for
    /// `kernel snapshot guard` telemetry. Telemetry only.
    pub on_snapshot_guard: Option<KernelSnapshotGuardHandler>,
}

/// Which memory step a kernel took (`kernel memory action` `action`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelMemoryAction {
    /// A warning is owed to the model.
    Warn,
    /// A child process unit was stopped.
    Child,
    /// The largest variables were deleted.
    Trim,
    /// The kernel was ended.
    End,
}

impl KernelMemoryAction {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Warn => "warn",
            Self::Child => "child",
            Self::Trim => "trim",
            Self::End => "end",
        }
    }
}

/// Why a memory step fired (`kernel memory action` `cause`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelMemoryCause {
    /// The tree crossed its own limit (or the warning line).
    Limit,
    /// Past the hard limit (1.5x).
    Hard,
    /// Still over the limit after the grace window.
    Grace,
    /// The machine backstop.
    Machine,
}

impl KernelMemoryCause {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Limit => "limit",
            Self::Hard => "hard",
            Self::Grace => "grace",
            Self::Machine => "machine",
        }
    }
}

/// One memory step, as primitives only (no names, pids, or text).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KernelMemoryActionStats {
    pub action: KernelMemoryAction,
    pub cause: KernelMemoryCause,
    pub tree_bytes: u64,
    pub kernel_bytes: u64,
    pub limit_bytes: u64,
    /// The tree after the step, when known.
    pub after_bytes: Option<u64>,
    /// How many variable groups the trim deleted.
    pub dropped_count: Option<u64>,
    pub cell_running: bool,
}

/// Reports kernel memory steps (`kernel memory action`).
pub type KernelMemoryActionHandler = Arc<dyn Fn(KernelMemoryActionStats) + Send + Sync>;

/// Which snapshot direction the file-handle guard acted in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotGuardPhase {
    Capture,
    Restore,
}

impl SnapshotGuardPhase {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Restore => "restore",
        }
    }
}

/// What the file-handle snapshot guard did in one capture or restore.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KernelSnapshotGuardStats {
    pub phase: SnapshotGuardPhase,
    /// Values skipped (capture) or blobs refused (restore) as file handles.
    pub rejected_count: u64,
    /// Direct handle names deleted from the namespace after the commit.
    pub purged_count: u64,
}

/// Reports file-handle snapshot guard actions (`kernel snapshot guard`).
pub type KernelSnapshotGuardHandler = Arc<dyn Fn(KernelSnapshotGuardStats) + Send + Sync>;

/// Shutdown options: whether to flush a final namespace snapshot and drain
/// in-flight host requests before tearing the kernel down.
#[derive(Debug, Clone, Copy, Default)]
pub struct KernelShutdownOptions {
    pub snapshot: bool,
    pub drain_host_requests: bool,
}

/// Parse a [`DIFF_DISPLAY_MIME`] payload, tolerating malformed input.
#[must_use]
pub fn parse_diff_display(payload: &Value) -> Option<KernelDiffDisplay> {
    let obj = payload.as_object()?;
    let path = obj.get("path")?.as_str()?;
    let old_str = obj.get("old_str")?.as_str()?;
    let new_str = obj.get("new_str")?.as_str()?;
    let start_line = match obj.get("start_line") {
        Some(v) => v.as_u64(),
        None => None,
    };
    Some(KernelDiffDisplay {
        path: path.to_string(),
        old_str: old_str.to_string(),
        new_str: new_str.to_string(),
        start_line,
    })
}

/// Parse an [`ATTACHMENT_DISPLAY_MIME`] payload. Malformed payloads are
/// tolerantly ignored (`None`); a well-formed payload exceeding
/// [`MAX_ATTACHMENT_DATA_CHARS`] is reported as [`AttachmentParse::Oversized`]
/// so the caller can fail the cell loudly rather than silently dropping the image.
pub fn parse_attachment_display(
    payload: &Value,
) -> Option<Result<KernelAttachment, AttachmentOversized>> {
    let obj = payload.as_object()?;
    let mime_type = obj.get("mime_type")?.as_str()?;
    let data = obj.get("data")?.as_str()?;
    if data.len() > MAX_ATTACHMENT_DATA_CHARS {
        return Some(Err(AttachmentOversized));
    }
    Some(Ok(KernelAttachment {
        mime_type: mime_type.to_string(),
        data: data.to_string(),
        path: obj.get("path").and_then(Value::as_str).map(str::to_string),
    }))
}

/// Marker for an attachment exceeding the size ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentOversized;

/// Parse an [`AGENT_MESSAGE_DISPLAY_MIME`] payload, tolerating malformed input.
pub fn parse_sent_agent_message(payload: &Value) -> Option<KernelSentAgentMessage> {
    let obj = payload.as_object()?;
    let target = obj.get("target")?.as_object()?;
    let id = obj.get("id")?.as_str()?;
    let message = obj.get("message")?.as_str()?;
    let delivery_status = match obj.get("deliveryStatus")?.as_str()? {
        "delivered" => SentDeliveryStatus::Delivered,
        "queued" => SentDeliveryStatus::Queued,
        _ => return None,
    };
    let active_session_id = target.get("activeSessionId")?.as_str()?;
    let session_id = target.get("sessionId")?.as_str()?;
    let receiver_role = match obj.get("receiverRole").and_then(Value::as_str) {
        Some("parent") => Some(ReceiverRole::Parent),
        Some("sibling") => Some(ReceiverRole::Sibling),
        Some("child") => Some(ReceiverRole::Child),
        _ => None,
    };
    Some(KernelSentAgentMessage {
        id: id.to_string(),
        message: message.to_string(),
        delivery_status,
        receiver_role,
        target: SentAgentMessageTarget {
            active_session_id: active_session_id.to_string(),
            session_id: session_id.to_string(),
            session_name: target
                .get("sessionName")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
    })
}
