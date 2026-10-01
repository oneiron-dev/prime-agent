//! The pass over every registered kernel (TS `KernelMemoryGuard`): one
//! process-wide registry, one non-overlapping pass every two seconds while
//! any kernel is watched, one process table per pass shared by every tree.
//!
//! Kernels are held weakly: the registry never keeps a manager alive, and a
//! dropped manager is skipped (its teardown unregisters it too). Each pass
//! snapshots what it needs under short locks and acts with no lock held.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime};

use futures::future::{BoxFuture, FutureExt, Shared};

use super::policy::{
    decide_memory_steps, KernelEndCause, LadderState, MachinePressure, MemoryStep,
};
use super::tree::{index_children, measure_kernel_tree, ChildUnit, KernelTreeUsage};
use super::{BACKSTOP_MIN_TREE_BYTES, MEMORY_POLL_INTERVAL};
use crate::kernel::orphan_journal::{read_active_orphan_processes, ORPHAN_PROCESS_JOURNAL_ENV};
use crate::platform::kernel_memory::{platform_memory_reader, MemoryReader, ProcessTable};

/// What a watched kernel reports for one pass.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MemoryWatch {
    pub pid: i32,
    /// The kernel start this process belongs to: a step measured on one
    /// start never acts on its successor.
    pub generation: u64,
    pub limit_bytes: f64,
    pub backstop: bool,
    /// The kernel's interpreter (the macOS reader runs it).
    pub python: Option<PathBuf>,
    /// Process groups of the kernel's live `bash()` handles.
    pub bash_pgids: Vec<i32>,
}

/// One kernel start's tree as a pass measured it.
#[derive(Debug, Clone)]
pub(crate) struct MeasuredTree {
    pub usage: KernelTreeUsage,
    /// [`MemoryWatch::generation`] at the measurement.
    pub generation: u64,
}

/// The child step's inputs.
#[derive(Debug, Clone)]
pub(crate) struct ChildStep {
    pub unit: ChildUnit,
    pub measured: MeasuredTree,
    pub pressure: MachinePressure,
}

/// What a kernel exposes to the memory guard (TS `MemoryGuardedKernel`).
///
/// The guard holds implementations weakly and calls them from its pass:
/// `memory_watch` answers `None` while no kernel process runs or the ladder
/// is off; `warn_memory` and `trim_memory` only record or schedule work and
/// return at once. Every step carries the kernel start it measured and must
/// do nothing once that start is no longer the running one (a restart while
/// the table was read, or during the step's own awaits). The child and end
/// steps report real failures as errors (the guard logs them and goes on
/// with the other kernels).
pub(crate) trait MemoryGuardedKernel: Send + Sync {
    fn memory_watch(&self) -> Option<MemoryWatch>;
    fn warn_memory(&self, measured: &MeasuredTree);
    fn stop_memory_child(
        self: Arc<Self>,
        step: ChildStep,
    ) -> BoxFuture<'static, anyhow::Result<()>>;
    fn trim_memory(self: Arc<Self>, target_bytes: u64, measured: &MeasuredTree);
    fn end_memory_kernel(
        self: Arc<Self>,
        measured: MeasuredTree,
        cause: KernelEndCause,
    ) -> BoxFuture<'static, anyhow::Result<()>>;
}

type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;
type TickPass = Shared<BoxFuture<'static, ()>>;

struct Watched {
    kernel: Weak<dyn MemoryGuardedKernel>,
    /// Which watch this entry is: a re-watch (a kernel restart) starts a
    /// fresh ladder that an older pass must not step.
    registration: u64,
    ladder: LadderState,
}

impl Watched {
    fn is(&self, kernel: *const ()) -> bool {
        self.kernel.as_ptr().cast::<()>() == kernel
    }
}

#[derive(Default)]
struct GuardState {
    kernels: Vec<Watched>,
    registrations: u64,
    timer: Option<tokio::task::JoinHandle<()>>,
    /// The pass in flight, by number, so only its own completion clears it.
    ticking: Option<(u64, TickPass)>,
    passes: u64,
}

#[derive(PartialEq, Eq)]
struct JournalKey {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
}

struct JournalCache {
    key: JournalKey,
    by_kernel: HashMap<i32, Vec<i32>>,
}

/// The process-wide registry and its pass.
pub(crate) struct KernelMemoryGuard {
    reader: Option<Arc<dyn MemoryReader>>,
    /// `None`: no timer; only explicit [`KernelMemoryGuard::tick`]s walk the ladder.
    interval: Option<Duration>,
    clock: Clock,
    state: Mutex<GuardState>,
    journal: Mutex<Option<JournalCache>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The data address of a kernel: its registry identity.
pub(crate) fn kernel_identity<T: ?Sized>(kernel: &T) -> *const () {
    std::ptr::from_ref(kernel).cast::<()>()
}

/// The guard every kernel manager in this process registers with.
pub(crate) fn kernel_memory_guard() -> &'static Arc<KernelMemoryGuard> {
    static GUARD: OnceLock<Arc<KernelMemoryGuard>> = OnceLock::new();
    GUARD.get_or_init(|| {
        KernelMemoryGuard::new(
            platform_memory_reader(),
            Some(MEMORY_POLL_INTERVAL),
            // Tokio's clock, so paused-time tests drive the grace window.
            Arc::new(|| tokio::time::Instant::now().into_std()),
        )
    })
}

impl KernelMemoryGuard {
    pub(crate) fn new(
        reader: Option<Arc<dyn MemoryReader>>,
        interval: Option<Duration>,
        clock: Clock,
    ) -> Arc<Self> {
        Arc::new(Self {
            reader,
            interval,
            clock,
            state: Mutex::new(GuardState::default()),
            journal: Mutex::new(None),
        })
    }

    /// Start (or restart) watching a kernel with a fresh ladder. No-op on a
    /// platform without a reader.
    pub(crate) fn watch(self: &Arc<Self>, kernel: &Arc<dyn MemoryGuardedKernel>) {
        if self.reader.is_none() {
            return;
        }
        let identity = kernel_identity(kernel.as_ref());
        let mut state = lock(&self.state);
        state.kernels.retain(|watched| !watched.is(identity));
        state.registrations += 1;
        let registration = state.registrations;
        state.kernels.push(Watched {
            kernel: Arc::downgrade(kernel),
            registration,
            ladder: LadderState::default(),
        });
        // A timer whose runtime is gone (a finished test runtime) restarts.
        if state
            .timer
            .as_ref()
            .is_none_or(tokio::task::JoinHandle::is_finished)
        {
            state.timer = self.start_timer();
        }
    }

    /// Stop watching; the timer stops with the last kernel, and so does the
    /// registry's hold on a pass the timer was running (a pass someone else
    /// awaits still finishes for them).
    pub(crate) fn unwatch(&self, kernel: *const ()) {
        let mut state = lock(&self.state);
        state
            .kernels
            .retain(|watched| !watched.is(kernel) && watched.kernel.strong_count() > 0);
        if state.kernels.is_empty() {
            if let Some(timer) = state.timer.take() {
                timer.abort();
            }
            state.ticking = None;
        }
    }

    /// The variable step's trim finished: the grace clock for the last step restarts here.
    pub(crate) fn note_trimmed(&self, kernel: *const ()) {
        let now = (self.clock)();
        let mut state = lock(&self.state);
        if let Some(watched) = state.kernels.iter_mut().find(|watched| watched.is(kernel)) {
            if watched.ladder.trim_at.is_some() {
                watched.ladder.trim_at = Some(now);
            }
        }
    }

    fn start_timer(self: &Arc<Self>) -> Option<tokio::task::JoinHandle<()>> {
        let interval = self.interval?;
        let runtime = tokio::runtime::Handle::try_current().ok()?;
        let guard = Arc::downgrade(self);
        Some(runtime.spawn(async move {
            // No immediate first pass: the first one runs one interval after the watch.
            let mut ticks =
                tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                let Some(guard) = guard.upgrade() else {
                    return;
                };
                guard.tick().await;
            }
        }))
    }

    /// One kernel's tree now, outside the pass: the "memory now" figure after a step.
    #[tracing::instrument(level = "debug", name = "kernel_memory_measure", skip_all)]
    pub(crate) async fn measure(
        self: &Arc<Self>,
        kernel: &dyn MemoryGuardedKernel,
    ) -> Option<KernelTreeUsage> {
        let reader = self.reader.clone()?;
        let watch = kernel.memory_watch()?;
        let table = match reader.read(watch.python.clone()).await {
            Ok(table) => table,
            Err(error) => {
                tracing::debug!(error = %format!("{error:#}"), "kernel memory table unreadable");
                return None;
            }
        };
        let guard = Arc::clone(self);
        let measured = tokio::task::spawn_blocking(move || {
            let mut usages = guard.measure_trees(&table, &[watch]);
            usages.pop().flatten()
        })
        .await;
        measured.unwrap_or_else(|error| {
            tracing::warn!(error = %error, "kernel memory measurement failed");
            None
        })
    }

    /// One measurement pass for every watched kernel; overlapping calls join
    /// the pass in flight.
    pub(crate) async fn tick(self: &Arc<Self>) {
        let pass = {
            let mut state = lock(&self.state);
            if let Some((_, pass)) = &state.ticking {
                pass.clone()
            } else {
                state.passes += 1;
                let number = state.passes;
                let guard = Arc::clone(self);
                let pass = async move {
                    guard.run_tick().await;
                    let mut state = lock(&guard.state);
                    if state
                        .ticking
                        .as_ref()
                        .is_some_and(|(current, _)| *current == number)
                    {
                        state.ticking = None;
                    }
                }
                .boxed()
                .shared();
                state.ticking = Some((number, pass.clone()));
                pass
            }
        };
        pass.await;
    }

    #[tracing::instrument(level = "debug", name = "kernel_memory_pass", skip_all)]
    async fn run_tick(self: &Arc<Self>) {
        let Some(reader) = self.reader.clone() else {
            return;
        };
        // Weak across the table read: the pass never keeps a manager alive
        // while it waits on the OS.
        let registered: Vec<(Weak<dyn MemoryGuardedKernel>, u64)> = lock(&self.state)
            .kernels
            .iter()
            .map(|watched| (watched.kernel.clone(), watched.registration))
            .collect();
        // The macOS reader runs the first live kernel's interpreter.
        let Some(python) = registered.iter().find_map(|(kernel, _)| {
            kernel
                .upgrade()
                .and_then(|kernel| kernel.memory_watch())
                .map(|watch| watch.python)
        }) else {
            return;
        };
        let table = match reader.read(python).await {
            Ok(table) => table,
            Err(error) => {
                // An unreadable table skips this pass; the next one retries.
                tracing::debug!(error = %format!("{error:#}"), "kernel memory table unreadable");
                return;
            }
        };
        // Each kernel's watch is read after the table (TS reads
        // `memoryWatch` there too): a kernel restarted during the read is
        // measured as the process now running, never as the one it replaced.
        let live: Vec<(Arc<dyn MemoryGuardedKernel>, u64, MemoryWatch)> = registered
            .iter()
            .filter_map(|(kernel, registration)| {
                let kernel = kernel.upgrade()?;
                let watch = kernel.memory_watch()?;
                Some((kernel, *registration, watch))
            })
            .collect();
        if live.is_empty() {
            return;
        }
        let critical = table.critical;
        let guard = Arc::clone(self);
        let watches: Vec<MemoryWatch> = live.iter().map(|(_, _, watch)| watch.clone()).collect();
        let usages = match tokio::task::spawn_blocking(move || {
            guard.measure_trees(&table, &watches)
        })
        .await
        {
            Ok(usages) => usages,
            Err(error) => {
                tracing::warn!(error = %error, "kernel memory measurement failed");
                return;
            }
        };
        let measured: Vec<(usize, KernelTreeUsage)> = usages
            .into_iter()
            .enumerate()
            .filter_map(|(index, usage)| usage.map(|usage| (index, usage)))
            .collect();
        let victim = if critical {
            measured
                .iter()
                .filter(|(index, usage)| {
                    live[*index].2.backstop && usage.total_bytes >= BACKSTOP_MIN_TREE_BYTES
                })
                .fold(
                    None::<&(usize, KernelTreeUsage)>,
                    |best, candidate| match best {
                        Some(best) if best.1.total_bytes >= candidate.1.total_bytes => Some(best),
                        _ => Some(candidate),
                    },
                )
                .map(|(index, _)| *index)
        } else {
            None
        };
        let now = (self.clock)();
        for (index, usage) in measured {
            let (kernel, registration, watch) = &live[index];
            let pressure = if victim == Some(index) {
                MachinePressure::BackstopVictim
            } else {
                MachinePressure::Normal
            };
            let steps =
                {
                    let identity = kernel_identity(kernel.as_ref());
                    let mut state = lock(&self.state);
                    // Re-watched since the pass began (a restart): that start's
                    // fresh ladder is not this measurement's to step.
                    let Some(entry) = state.kernels.iter_mut().find(|watched| {
                        watched.is(identity) && watched.registration == *registration
                    }) else {
                        continue;
                    };
                    decide_memory_steps(&usage, watch.limit_bytes, &mut entry.ladder, now, pressure)
                };
            let measured = MeasuredTree {
                usage,
                generation: watch.generation,
            };
            for step in steps {
                // One kernel's failed step must not stop the pass for the others.
                match step {
                    MemoryStep::Warn => kernel.warn_memory(&measured),
                    MemoryStep::Child(unit) => {
                        let step = ChildStep {
                            unit,
                            measured: measured.clone(),
                            pressure,
                        };
                        if let Err(error) = Arc::clone(kernel).stop_memory_child(step).await {
                            tracing::warn!(error = %format!("{error:#}"), pid = watch.pid, "kernel memory child step failed");
                        }
                    }
                    MemoryStep::Trim { target_bytes } => {
                        Arc::clone(kernel).trim_memory(target_bytes, &measured);
                    }
                    MemoryStep::Kill(cause) => {
                        if let Err(error) = Arc::clone(kernel)
                            .end_memory_kernel(measured.clone(), cause)
                            .await
                        {
                            tracing::warn!(error = %format!("{error:#}"), pid = watch.pid, "kernel memory last step failed");
                        }
                    }
                }
            }
        }
    }

    /// Every watched tree in one table (blocking: procfs size reads).
    fn measure_trees(
        &self,
        table: &ProcessTable,
        watches: &[MemoryWatch],
    ) -> Vec<Option<KernelTreeUsage>> {
        let journal = self.journal_pgids();
        let children = index_children(&table.rows);
        let own_pgid = table
            .rows
            .get(&(std::process::id() as i32))
            .map(|row| row.pgid);
        watches
            .iter()
            .map(|watch| {
                let mut bash: HashSet<i32> = watch.bash_pgids.iter().copied().collect();
                bash.extend(journal.get(&watch.pid).into_iter().flatten().copied());
                measure_kernel_tree(table, &children, watch.pid, &bash, own_pgid)
            })
            .collect()
    }

    /// Active `bash()` process groups per kernel pid from this host's orphan
    /// journal, re-read only when the file changes.
    fn journal_pgids(&self) -> HashMap<i32, Vec<i32>> {
        let Some(path) = std::env::var_os(ORPHAN_PROCESS_JOURNAL_ENV)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
        else {
            return HashMap::new();
        };
        let Ok(metadata) = std::fs::metadata(&path) else {
            return HashMap::new();
        };
        let key = JournalKey {
            path,
            size: metadata.len(),
            modified: metadata.modified().ok(),
        };
        let mut cache = lock(&self.journal);
        if cache.as_ref().is_none_or(|cached| cached.key != key) {
            let mut by_kernel: HashMap<i32, Vec<i32>> = HashMap::new();
            match read_active_orphan_processes(&key.path) {
                Ok(records) => {
                    for record in records {
                        if let Some(kernel_pid) = record.kernel_pid {
                            by_kernel.entry(kernel_pid).or_default().push(record.pid);
                        }
                    }
                }
                // An unreadable journal leaves the parent-pid walk.
                Err(error) => {
                    tracing::debug!(error = %format!("{error:#}"), "orphan journal unreadable");
                }
            }
            *cache = Some(JournalCache { key, by_kernel });
        }
        cache
            .as_ref()
            .map(|cached| cached.by_kernel.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
#[path = "watcher_tests.rs"]
mod tests;
