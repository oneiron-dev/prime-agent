//! The memory ladder's steps on one kernel (the TS fork's `ReplKernelManager`
//! memory half): owe a warning, stop a child unit, trim the largest variables
//! in the request slot, end the kernel - plus the out-of-band notice/report
//! requests and the notices owed to the model's next cell result.

use std::collections::HashSet;
use std::io::Write as _;
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::{
    lock, AbortSignal, Arc, ExecuteOptions, ExecuteResult, ExecuteStatus, Inner, KernelError,
    KernelManagerOptions, KernelState, ReplKernelManager, Request,
};
use crate::kernel::memory_guard::messages::{
    format_gb, memory_child_message, memory_kill_message, memory_trim_message,
    memory_warning_message, ChildStepContext, HeldVariables, KillStepContext, SizedVariable,
    StoppedChild, TrimStepContext,
};
use crate::kernel::memory_guard::policy::{KernelEndCause, MachinePressure};
use crate::kernel::memory_guard::tree::KernelTreeUsage;
use crate::kernel::memory_guard::watcher::{
    kernel_identity, ChildStep, KernelMemoryGuard, MeasuredTree, MemoryGuardedKernel, MemoryWatch,
};
use crate::kernel::memory_guard::{
    resolve_kernel_memory_backstop, resolve_kernel_memory_limit_gb, GIB,
    KERNEL_MEMORY_BACKSTOP_ENV, KERNEL_MEMORY_LIMIT_ENV, MEMORY_TRIM_MIN_BYTES,
};
use crate::kernel::shared::{
    KernelCellLine, KernelMemoryAction, KernelMemoryActionHandler, KernelMemoryActionStats,
    KernelMemoryCause,
};
use crate::platform::kernel_memory::kill_child_unit;

/// A trim sizes every top-level value (pandas deep usage can be slow); past this the last step decides.
const MEMORY_TRIM_TIMEOUT: Duration = Duration::from_secs(30);
/// The runtime acknowledges a memory notice from its reader thread; a wedged kernel must not delay the kill.
const MEMORY_NOTICE_ACK_TIMEOUT: Duration = Duration::from_millis(200);
/// Before the last step the kernel names its running line and variables; one long C call holding the GIL cannot answer.
const MEMORY_REPORT_TIMEOUT: Duration = Duration::from_secs(1);
/// The variable step's interrupt of a running request, like the abort path's: a kernel that stopped reading its input must not hold the task.
const MEMORY_INTERRUPT_TIMEOUT: Duration = Duration::from_millis(super::KERNEL_ABORT_GRACE_MS);
/// The last step's message lists this many of the names the kernel held.
const MEMORY_HELD_NAMES: u64 = 30;
/// The warning names this many of the largest variables.
const MEMORY_WARNING_NAMES: usize = 3;

/// The resolved ceiling of one kernel manager.
pub(super) struct MemoryConfig {
    /// 0 when the ladder is off.
    limit_bytes: f64,
    backstop: bool,
    on_action: Option<KernelMemoryActionHandler>,
    /// The registry this kernel joins (the process-wide one outside tests).
    guard: Arc<KernelMemoryGuard>,
}

impl MemoryConfig {
    pub(super) fn resolve(options: &KernelManagerOptions, guard: Arc<KernelMemoryGuard>) -> Self {
        let limit_gb = resolve_kernel_memory_limit_gb(
            options.memory_limit_gb,
            std::env::var(KERNEL_MEMORY_LIMIT_ENV).ok().as_deref(),
        );
        Self {
            limit_bytes: limit_gb * GIB,
            backstop: resolve_kernel_memory_backstop(
                options.memory_backstop,
                std::env::var(KERNEL_MEMORY_BACKSTOP_ENV).ok().as_deref(),
            ),
            on_action: options.on_memory_action.clone(),
            guard,
        }
    }
}

/// Where an owed notice lands in the next user cell's result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoticePlacement {
    /// The action happened while no user cell ran: above the output.
    Queued,
    /// The action concerned the running cell: after its output.
    Current,
}

impl NoticePlacement {
    fn for_cell(cell_running: bool) -> Self {
        if cell_running {
            Self::Current
        } else {
            Self::Queued
        }
    }
}

struct OwedNotice {
    text: String,
    placement: NoticePlacement,
}

/// The variable step awaiting its trim, run once the stopped (or next) request settles.
struct PendingTrim {
    target_bytes: u64,
    usage: KernelTreeUsage,
    cell_stopped: bool,
}

/// The names the kernel held at its last trim report: the last step's
/// fallback when the kernel cannot answer.
#[derive(Clone)]
struct HeldNames {
    names: Vec<SizedVariable>,
    more: u64,
    at: Instant,
}

/// The per-kernel ladder state on the manager.
#[derive(Default)]
pub(super) struct MemoryState {
    /// Optional requests the running runtime announced in its ready event.
    features: HashSet<String>,
    pending_trim: Option<PendingTrim>,
    pending_warning: Option<KernelTreeUsage>,
    /// Memory messages owed to the model, delivered with the next user cell's result.
    notices: Vec<OwedNotice>,
    last_held: Option<HeldNames>,
}

impl MemoryState {
    pub(super) fn set_features(&mut self, features: Vec<String>) {
        self.features = features.into_iter().collect();
    }

    /// A teardown ends the measured kernel: its owed steps and last reading
    /// go with it, while notices already owed to the model stay.
    pub(super) fn clear_kernel_steps(&mut self) {
        self.pending_trim = None;
        self.pending_warning = None;
        self.last_held = None;
    }
}

/// What settled in the request slot before the follow-up runs.
pub(super) enum SettledRequest<'a> {
    /// A user cell: owed warnings ride its result.
    User(&'a ExecuteResult),
    /// An internal request (snapshot, bootstrap, listing): only a pending trim runs.
    Internal(&'a ExecuteResult),
    /// No request: the trim was asked for while the kernel was idle.
    Idle,
}

/// One trim report from the runtime.
struct TrimReport {
    dropped: Vec<SizedVariable>,
    largest: Vec<SizedVariable>,
}

/// A nonnegative safe integer, else 0 (TS `asCount`).
fn as_count(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_u64)
        .filter(|count| *count < 1 << 53)
        .unwrap_or(0)
}

/// The runtime's sized-variable records (TS `asSizedArray`): entries without
/// a string name and numeric bytes are dropped.
fn as_sized_array(value: Option<&Value>) -> Vec<SizedVariable> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let name = entry.get("name")?.as_str()?;
                    let bytes = entry.get("bytes")?.as_f64()?;
                    let shape = entry
                        .get("shape")
                        .and_then(Value::as_array)
                        .and_then(|dims| {
                            dims.iter()
                                .map(|dim| dim.as_i64().filter(|n| n.unsigned_abs() < 1 << 53))
                                .collect::<Option<Vec<i64>>>()
                        });
                    Some(SizedVariable {
                        name: name.to_string(),
                        bytes,
                        type_name: entry
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("object")
                            .to_string(),
                        shape,
                        dtype: entry
                            .get("dtype")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        length: entry.get("length").map(|length| as_count(Some(length))),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

impl Inner {
    /// Register this kernel with the process-wide guard once it runs.
    pub(super) fn watch_memory(self: &Arc<Self>) {
        if self.memory.limit_bytes > 0.0 {
            let kernel: Arc<dyn MemoryGuardedKernel> =
                Arc::clone(self) as Arc<dyn MemoryGuardedKernel>;
            self.memory.guard.watch(&kernel);
        }
    }

    /// Owed notices move into a user cell's result: queued ones above its
    /// output, the cell's own after it.
    pub(super) fn take_memory_notices(&self, result: &mut ExecuteResult) {
        let notices = std::mem::take(&mut lock(&self.guarded).memory.notices);
        if notices.is_empty() {
            return;
        }
        let (queued, current): (Vec<OwedNotice>, Vec<OwedNotice>) = notices
            .into_iter()
            .partition(|notice| notice.placement == NoticePlacement::Queued);
        let texts = |notices: Vec<OwedNotice>| {
            (!notices.is_empty()).then(|| notices.into_iter().map(|notice| notice.text).collect())
        };
        result.queued_memory_notices = texts(queued);
        result.memory_notices = texts(current);
    }

    fn note_memory(&self, text: String, placement: NoticePlacement) {
        lock(&self.guarded)
            .memory
            .notices
            .push(OwedNotice { text, placement });
    }

    fn has_feature(&self, request: &Request) -> bool {
        lock(&self.guarded)
            .memory
            .features
            .contains(request.type_name())
    }

    /// Memory actions go to the diagnostics tail, the stderr log, and the
    /// trace: pids, process names, sizes and types, never cell source or
    /// process arguments.
    fn log_memory(&self, line: &str) {
        self.append_diagnostic(&format!("memory {line}"));
        tracing::info!(target: "pa_core::kernel::memory", "{line}");
        let Some(log) = lock(&self.stderr_log).clone() else {
            return;
        };
        let entry = format!("[kernel] memory {line}\n");
        let mut log = lock(&log);
        if log.budget >= entry.len() as u64 {
            if let Err(error) = log.file.write_all(entry.as_bytes()) {
                tracing::debug!(error = %error, "kernel stderr log write failed");
            } else {
                log.budget -= entry.len() as u64;
            }
        }
    }

    fn describe_tree(&self, usage: &KernelTreeUsage) -> String {
        format!(
            "pid={} tree={}GB kernel={}GB limit={}GB",
            usage.kernel_pid,
            format_gb(usage.total_bytes as f64),
            format_gb(usage.kernel_bytes as f64),
            format_gb(self.memory.limit_bytes)
        )
    }

    fn report_memory_action(&self, stats: KernelMemoryActionStats) {
        if let Some(on_action) = &self.memory.on_action {
            on_action(stats);
        }
    }

    fn action_stats(
        &self,
        action: KernelMemoryAction,
        cause: KernelMemoryCause,
        usage: &KernelTreeUsage,
        cell_running: bool,
    ) -> KernelMemoryActionStats {
        KernelMemoryActionStats {
            action,
            cause,
            tree_bytes: usage.total_bytes,
            kernel_bytes: usage.kernel_bytes,
            limit_bytes: self.memory.limit_bytes as u64,
            after_bytes: None,
            dropped_count: None,
            cell_running,
        }
    }

    /// A user cell is running and has not settled.
    fn user_cell_running(&self) -> bool {
        let active = lock(&self.guarded).active_execution.clone();
        active
            .is_some_and(|execution| !execution.opts.internal && !lock(&execution.buffers).settled)
    }

    /// A request the runtime answers off its request queue, even while a cell
    /// runs. Its done fields, or `None` when the runtime lacks the request or
    /// does not answer in time. The write is bounded too: a kernel that
    /// stopped draining stdin must not hold the writer past the deadline.
    #[tracing::instrument(level = "debug", name = "kernel_memory_out_of_band", skip_all, fields(request = request.type_name()))]
    async fn send_out_of_band(
        self: &Arc<Self>,
        request: Request,
        timeout: Duration,
    ) -> Option<Value> {
        if !self.has_feature(&request) {
            return None;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (reply_tx, reply_rx) = oneshot::channel();
        lock(&self.guarded)
            .pending_done_waiters
            .insert(id.clone(), reply_tx);
        let mut frame = request.to_json();
        frame["id"] = json!(id);
        let writer = {
            let inner = Arc::clone(self);
            tokio::spawn(async move { inner.write_line(&frame).await })
        };
        let reply = tokio::time::timeout(timeout, reply_rx)
            .await
            .ok()
            .and_then(Result::ok);
        lock(&self.guarded).pending_done_waiters.remove(&id);
        if writer.is_finished() {
            if let Ok(Err(error)) = writer.await {
                self.log_memory(&format!("{} write failed: {error:#}", request.type_name()));
            }
        } else {
            writer.abort();
        }
        reply
    }

    async fn stop_child(self: Arc<Self>, step: ChildStep) -> anyhow::Result<()> {
        let ChildStep {
            unit,
            measured: MeasuredTree { usage, generation },
            pressure,
        } = step;
        // Measured on an earlier kernel start: none of that tree is this kernel's.
        if self.start_stale(generation) {
            return Ok(());
        }
        let machine = pressure == MachinePressure::BackstopVictim;
        let text = memory_child_message(&ChildStepContext {
            child: StoppedChild {
                name: &unit.name,
                pid: unit.pid,
                bytes: unit.bytes as f64,
            },
            total_bytes: usage.total_bytes as f64,
            after_bytes: usage.total_bytes.saturating_sub(unit.bytes) as f64,
            limit_bytes: self.memory.limit_bytes,
            machine,
        });
        let pids: Vec<i32> = unit
            .pgid
            .into_iter()
            .chain(unit.pids.iter().copied())
            .collect();
        // The runtime records the reason before the kill, so the bash() call
        // that owned the group returns it.
        let ack = self
            .send_out_of_band(
                Request::MemoryNotice {
                    pids,
                    text: text.clone(),
                },
                MEMORY_NOTICE_ACK_TIMEOUT,
            )
            .await;
        // A teardown during the acknowledgement already reaped this tree.
        if self.start_stale(generation) {
            return Ok(());
        }
        let cell_running = self.user_cell_running();
        if let Err(error) = kill_child_unit(unit.pgid, &unit.pids) {
            // Not stopped: claim nothing (no notice, no telemetry); the next
            // pass measures the tree again.
            self.log_memory(&format!(
                "child-step failed child={} process={}: {error:#}",
                unit.pid, unit.name
            ));
            return Err(error);
        }
        self.log_memory(&format!(
            "child-step {}{} child={} process={} child_gb={}",
            if machine { "machine " } else { "" },
            self.describe_tree(&usage),
            unit.pid,
            unit.name,
            format_gb(unit.bytes as f64)
        ));
        let mut stats = self.action_stats(
            KernelMemoryAction::Child,
            if machine {
                KernelMemoryCause::Machine
            } else {
                KernelMemoryCause::Limit
            },
            &usage,
            cell_running,
        );
        stats.after_bytes = Some(usage.total_bytes.saturating_sub(unit.bytes));
        self.report_memory_action(stats);
        // Only a bash() call the running cell awaits returns the message; any
        // other kill is reported by the host.
        let awaited = ack
            .as_ref()
            .and_then(|fields| fields.get("awaited"))
            .and_then(Value::as_bool);
        if !cell_running || awaited != Some(true) {
            self.note_memory(text, NoticePlacement::for_cell(cell_running));
        }
        Ok(())
    }

    async fn end_kernel(
        self: Arc<Self>,
        measured: MeasuredTree,
        cause: KernelEndCause,
    ) -> anyhow::Result<()> {
        let MeasuredTree { usage, generation } = measured;
        // Measured on an earlier kernel start: this kernel is not the one that outgrew the limit.
        if lock(&self.guarded).state != KernelState::Running || self.start_stale(generation) {
            return Ok(());
        }
        // Asked before the kill: the kernel names the line it runs and the variables it holds.
        let report = self
            .send_out_of_band(
                Request::MemoryReport {
                    count: MEMORY_HELD_NAMES,
                },
                MEMORY_REPORT_TIMEOUT,
            )
            .await;
        if lock(&self.guarded).state != KernelState::Running || self.start_stale(generation) {
            return Ok(());
        }
        let answered = report
            .as_ref()
            .filter(|fields| fields.get("status").and_then(Value::as_str) == Some("ok"));
        let last = lock(&self.guarded).memory.last_held.clone();
        let cell_running = self.user_cell_running();
        let line = answered
            .filter(|_| cell_running)
            .and_then(|fields| fields.get("line"))
            .and_then(KernelCellLine::from_value);
        let fresh_names = answered.map(|fields| as_sized_array(fields.get("names")));
        let held = match (&fresh_names, &last) {
            (Some(names), _) => Some(HeldVariables {
                names,
                more: as_count(answered.and_then(|fields| fields.get("more"))),
                stale_seconds: None,
            }),
            (None, Some(last)) => Some(HeldVariables {
                names: &last.names,
                more: last.more,
                stale_seconds: Some(last.at.elapsed().as_secs_f64().round() as u64),
            }),
            (None, None) => None,
        };
        let text = memory_kill_message(&KillStepContext {
            total_bytes: usage.total_bytes as f64,
            limit_bytes: self.memory.limit_bytes,
            cause,
            cell_running,
            line: line.as_ref(),
            held,
        });
        self.log_memory(&format!(
            "last-step cause={} {} report={}",
            cause.as_str(),
            self.describe_tree(&usage),
            match (&fresh_names, &last) {
                (Some(_), _) => "fresh",
                (None, Some(_)) => "stale",
                (None, None) => "none",
            }
        ));
        for unit in &usage.units {
            // The kernel itself ends below either way; a unit that cannot be
            // signaled is reported, not hidden.
            if let Err(error) = kill_child_unit(unit.pgid, &unit.pids) {
                self.log_memory(&format!(
                    "last-step child failed child={} process={}: {error:#}",
                    unit.pid, unit.name
                ));
            }
        }
        // Owed before the settle: the awaiting execute() collects notices as soon as it wakes.
        self.note_memory(text.clone(), NoticePlacement::for_cell(cell_running));
        let active = lock(&self.guarded).active_execution.clone();
        if let Some(execution) = active {
            let unsettled = {
                let mut buffers = lock(&execution.buffers);
                if buffers.settled {
                    false
                } else {
                    buffers.status = ExecuteStatus::Error;
                    buffers.error = Some(KernelError {
                        ename: "KernelMemoryLimit".to_string(),
                        evalue: text,
                        traceback: Vec::new(),
                        line: None,
                    });
                    true
                }
            };
            if unsettled {
                self.resolve_execution(&execution, true);
            }
        }
        self.report_memory_action(self.action_stats(
            KernelMemoryAction::End,
            match cause {
                KernelEndCause::Grace => KernelMemoryCause::Grace,
                KernelEndCause::Hard => KernelMemoryCause::Hard,
                KernelEndCause::Machine => KernelMemoryCause::Machine,
            },
            &usage,
            cell_running,
        ));
        let tearing_down = {
            let g = lock(&self.guarded);
            g.teardown_in_flight > 0 || g.flushing_snapshot_for_dispose
        };
        if tearing_down {
            // During teardown or the final flush: kill rather than reopen.
            ReplKernelManager { inner: self }.kill();
            return Ok(());
        }
        self.kill_child_to_idle();
        // The message promises a fresh kernel: never revive the namespace that outgrew the limit.
        lock(&self.guarded).pending_restore = false;
        Ok(())
    }
}

impl MemoryGuardedKernel for Inner {
    fn memory_watch(&self) -> Option<MemoryWatch> {
        // The resolved limit is finite: 0 (or below) is the ladder off.
        if self.memory.limit_bytes <= 0.0 {
            return None;
        }
        let pid = lock(&self.child).as_ref().map(|child| child.pid)?;
        let (generation, bash_pgids) = {
            let g = lock(&self.guarded);
            if g.state != KernelState::Running {
                return None;
            }
            (
                g.start_generation,
                g.background_bash_handles.values().copied().collect(),
            )
        };
        Some(MemoryWatch {
            pid,
            generation,
            limit_bytes: self.memory.limit_bytes,
            backstop: self.memory.backstop,
            python: self
                .options
                .python
                .clone()
                .or_else(|| lock(&self.resolved_python).clone()),
            bash_pgids,
        })
    }

    fn warn_memory(&self, measured: &MeasuredTree) {
        if self.start_stale(measured.generation) {
            return;
        }
        let usage = &measured.usage;
        self.log_memory(&format!("warn {}", self.describe_tree(usage)));
        {
            let mut g = lock(&self.guarded);
            if g.memory
                .pending_warning
                .as_ref()
                .is_none_or(|pending| usage.total_bytes > pending.total_bytes)
            {
                g.memory.pending_warning = Some(usage.clone());
            }
        }
        self.report_memory_action(self.action_stats(
            KernelMemoryAction::Warn,
            KernelMemoryCause::Limit,
            usage,
            self.user_cell_running(),
        ));
    }

    fn stop_memory_child(
        self: Arc<Self>,
        step: ChildStep,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        Box::pin(self.stop_child(step))
    }

    fn trim_memory(self: Arc<Self>, target_bytes: u64, measured: &MeasuredTree) {
        if self.start_stale(measured.generation) {
            return;
        }
        let usage = &measured.usage;
        let cell_stopped = self.user_cell_running();
        self.log_memory(&format!(
            "variable-step {} target={}GB cell={cell_stopped}",
            self.describe_tree(usage),
            format_gb(target_bytes as f64)
        ));
        let probe = Request::TrimMemory {
            target_bytes,
            min_bytes: MEMORY_TRIM_MIN_BYTES,
            count: MEMORY_HELD_NAMES,
        };
        if !self.has_feature(&probe) {
            self.log_memory("variable-step unavailable: the kernel runtime has no trim_memory; the last step decides");
            return;
        }
        let active_id = {
            let mut g = lock(&self.guarded);
            g.memory.pending_trim = Some(PendingTrim {
                target_bytes,
                usage: usage.clone(),
                cell_stopped,
            });
            g.active_execution
                .as_ref()
                .map(|execution| execution.request_id.clone())
        };
        // The trim runs in the stopped request's slot once it settles.
        if let Some(request_id) = active_id {
            tokio::spawn(async move {
                // Bounded: a runtime that stopped draining its input must
                // not keep this task, and with it the kernel, alive.
                match tokio::time::timeout(
                    MEMORY_INTERRUPT_TIMEOUT,
                    self.interrupt(Some(&request_id)),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        self.log_memory(&format!("variable-step interrupt failed: {error:#}"));
                    }
                    Err(_) => self.log_memory(
                        "variable-step interrupt timed out: the kernel is not reading its input",
                    ),
                }
            });
            return;
        }
        if lock(&self.guarded).flushing_snapshot_for_dispose {
            return;
        }
        // Idle: reserve the slot now, before any request can queue ahead of
        // the trim (TS chains it onto the queue synchronously). A slot
        // already held by a request leaves the trim to that request's
        // follow-up, which runs before the slot is released.
        let queue = Arc::clone(&self.execution_queue);
        let manager = ReplKernelManager { inner: self };
        if let Ok(slot) = Arc::clone(&queue).try_lock_owned() {
            tokio::spawn(manager.run_idle_memory_follow_up(slot));
        } else {
            tokio::spawn(async move {
                let slot = queue.lock_owned().await;
                manager.run_idle_memory_follow_up(slot).await;
            });
        }
    }

    fn end_memory_kernel(
        self: Arc<Self>,
        measured: MeasuredTree,
        cause: KernelEndCause,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        Box::pin(self.end_kernel(measured, cause))
    }
}

impl ReplKernelManager {
    /// The variable step's trim and the owed warning, run in the request
    /// slot right after a request settles (or in an idle slot of their own).
    pub(super) async fn run_memory_follow_up(&self, settled: SettledRequest<'_>) {
        let inner = &self.inner;
        let (internal, finished) = match settled {
            SettledRequest::User(result) => (false, Some(result)),
            SettledRequest::Internal(result) => (true, Some(result)),
            SettledRequest::Idle => (true, None),
        };
        {
            let g = lock(&inner.guarded);
            if g.memory.pending_trim.is_none() && (internal || g.memory.pending_warning.is_none()) {
                return;
            }
        }
        if !inner.memory_follow_up_ready() {
            return;
        }
        let trim = lock(&inner.guarded).memory.pending_trim.take();
        if let Some(trim) = trim {
            if let Some(report) = self.request_trim(trim.target_bytes).await {
                let after = inner.memory.guard.measure(inner.as_ref()).await;
                let dropped = report
                    .dropped
                    .iter()
                    .map(|variable| {
                        format!(
                            "{} {}GB {}",
                            variable.name,
                            format_gb(variable.bytes),
                            variable.type_name
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                inner.log_memory(&format!(
                    "variable-step dropped=[{dropped}] pid={} after={}",
                    trim.usage.kernel_pid,
                    after.as_ref().map_or_else(
                        || "unknown".to_string(),
                        |after| format!("{}GB", format_gb(after.total_bytes as f64))
                    )
                ));
                // The interrupt may land after the cell already finished; only
                // a KeyboardInterrupt means it stopped the cell.
                let stopped_at = finished
                    .filter(|_| trim.cell_stopped)
                    .and_then(|result| result.error.as_ref())
                    .filter(|error| error.ename == "KeyboardInterrupt");
                let text = memory_trim_message(&TrimStepContext {
                    total_bytes: trim.usage.total_bytes as f64,
                    after_bytes: after.as_ref().map(|after| after.total_bytes as f64),
                    limit_bytes: inner.memory.limit_bytes,
                    dropped: &report.dropped,
                    cell_stopped: stopped_at.is_some(),
                    line: stopped_at.and_then(|error| error.line.as_ref()),
                });
                inner.note_memory(text, NoticePlacement::for_cell(trim.cell_stopped));
                // The step's own message supersedes a warning owed from the same climb.
                lock(&inner.guarded).memory.pending_warning = None;
                inner
                    .memory
                    .guard
                    .note_trimmed(kernel_identity(inner.as_ref()));
                let mut stats = inner.action_stats(
                    KernelMemoryAction::Trim,
                    KernelMemoryCause::Limit,
                    &trim.usage,
                    trim.cell_stopped,
                );
                stats.after_bytes = after.map(|after| after.total_bytes);
                stats.dropped_count = Some(report.dropped.len() as u64);
                inner.report_memory_action(stats);
            }
        }
        if internal || !inner.memory_follow_up_ready() {
            return;
        }
        let Some(warning) = lock(&inner.guarded).memory.pending_warning.take() else {
            return;
        };
        let report = self.request_trim(0).await;
        let largest: Vec<SizedVariable> = report
            .map(|report| {
                report
                    .largest
                    .into_iter()
                    .take(MEMORY_WARNING_NAMES)
                    .collect()
            })
            .unwrap_or_default();
        inner.note_memory(
            memory_warning_message(
                warning.total_bytes as f64,
                inner.memory.limit_bytes,
                &largest,
            ),
            NoticePlacement::Current,
        );
    }

    /// A trim asked for while no request ran, in the serialized slot it holds.
    async fn run_idle_memory_follow_up(self, _slot: tokio::sync::OwnedMutexGuard<()>) {
        self.run_memory_follow_up(SettledRequest::Idle).await;
    }

    async fn request_trim(&self, target_bytes: u64) -> Option<TrimReport> {
        let inner = &self.inner;
        let request = Request::TrimMemory {
            target_bytes,
            min_bytes: MEMORY_TRIM_MIN_BYTES,
            count: MEMORY_HELD_NAMES,
        };
        if !inner.has_feature(&request) {
            return None;
        }
        let deadline = AbortSignal::new();
        let timer = {
            let deadline = deadline.clone();
            tokio::spawn(async move {
                tokio::time::sleep(MEMORY_TRIM_TIMEOUT).await;
                deadline.abort();
            })
        };
        let result = self
            .execute_inner(
                request,
                "",
                ExecuteOptions {
                    internal: true,
                    signal: Some(deadline),
                    ..ExecuteOptions::default()
                },
                Instant::now(),
            )
            .await;
        timer.abort();
        match result {
            Ok(settled)
                if settled.result.status == ExecuteStatus::Ok && settled.done_fields.is_some() =>
            {
                let fields = settled.done_fields.unwrap_or_default();
                let largest = as_sized_array(fields.get("largest"));
                lock(&inner.guarded).memory.last_held = Some(HeldNames {
                    names: largest.clone(),
                    more: as_count(fields.get("more")),
                    at: Instant::now(),
                });
                Some(TrimReport {
                    dropped: as_sized_array(fields.get("dropped")),
                    largest,
                })
            }
            Ok(settled) => {
                inner.log_memory(&format!(
                    "trim {}: {}",
                    settled.result.status.as_str(),
                    settled
                        .result
                        .error
                        .as_ref()
                        .map(|error| error.evalue.as_str())
                        .unwrap_or_default()
                ));
                None
            }
            Err(error) => {
                inner.log_memory(&format!("trim error: {error:#}"));
                None
            }
        }
    }
}

impl Inner {
    /// Leave the guard's registry (every teardown).
    pub(super) fn unwatch_memory(&self) {
        self.memory.guard.unwatch(kernel_identity(self));
    }

    /// The follow-up only runs on a live, idle kernel nobody is tearing down or repairing.
    fn memory_follow_up_ready(&self) -> bool {
        let g = lock(&self.guarded);
        g.state == KernelState::Running
            && g.teardown_in_flight == 0
            && g.protocol_repair.is_none()
            && g.active_execution.is_none()
    }
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;

// The real-runtime suite sizes the live procfs table (Linux only).
#[cfg(all(test, target_os = "linux"))]
#[path = "memory_ladder_tests.rs"]
mod ladder_tests;
