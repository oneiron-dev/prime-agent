//! The registry/pass battery: an injected reader and clock, fake kernels that
//! record what the pass asked of them, no real memory pressure.

use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::sync::Notify;

use super::*;
use crate::platform::kernel_memory::ProcessRow;

const GIB: u64 = 1024 * 1024 * 1024;

/// What a fake kernel was asked to do, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Call {
    Warn(u64),
    Child { pid: i32, machine: bool },
    Trim(u64),
    End(KernelEndCause),
}

struct FakeKernel {
    watch: Mutex<Option<MemoryWatch>>,
    calls: Mutex<Vec<Call>>,
}

impl FakeKernel {
    fn new(pid: i32, limit_bytes: u64, backstop: bool) -> Arc<Self> {
        Arc::new(Self {
            watch: Mutex::new(Some(MemoryWatch {
                pid,
                limit_bytes: limit_bytes as f64,
                backstop,
                python: None,
                bash_pgids: Vec::new(),
            })),
            calls: Mutex::new(Vec::new()),
        })
    }

    fn calls(&self) -> Vec<Call> {
        lock(&self.calls).clone()
    }
}

impl MemoryGuardedKernel for FakeKernel {
    fn memory_watch(&self) -> Option<MemoryWatch> {
        lock(&self.watch).clone()
    }

    fn warn_memory(&self, usage: &KernelTreeUsage) {
        lock(&self.calls).push(Call::Warn(usage.total_bytes));
    }

    fn stop_memory_child(
        self: Arc<Self>,
        step: ChildStep,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        lock(&self.calls).push(Call::Child {
            pid: step.unit.pid,
            machine: step.pressure == MachinePressure::BackstopVictim,
        });
        Box::pin(async { Ok(()) })
    }

    fn trim_memory(self: Arc<Self>, target_bytes: u64, _usage: &KernelTreeUsage) {
        lock(&self.calls).push(Call::Trim(target_bytes));
    }

    fn end_memory_kernel(
        self: Arc<Self>,
        _usage: KernelTreeUsage,
        cause: KernelEndCause,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        lock(&self.calls).push(Call::End(cause));
        Box::pin(async { anyhow::bail!("the step failed") })
    }
}

/// A reader serving the current scripted table; counts reads, and can hold
/// a read open until released (the overlap test).
struct ScriptedReader {
    table: Mutex<Option<Vec<(ProcessRow, u64)>>>,
    critical: Mutex<bool>,
    reads: AtomicUsize,
    gate: Mutex<Option<Arc<Notify>>>,
    entered: Notify,
}

impl ScriptedReader {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            table: Mutex::new(Some(Vec::new())),
            critical: Mutex::new(false),
            reads: AtomicUsize::new(0),
            gate: Mutex::new(None),
            entered: Notify::new(),
        })
    }

    fn serve(&self, rows: Vec<(ProcessRow, u64)>, critical: bool) {
        *lock(&self.table) = Some(rows);
        *lock(&self.critical) = critical;
    }

    fn fail(&self) {
        *lock(&self.table) = None;
    }
}

impl MemoryReader for ScriptedReader {
    fn read(&self, _python: Option<PathBuf>) -> BoxFuture<'static, anyhow::Result<ProcessTable>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        let rows = lock(&self.table).clone();
        let critical = *lock(&self.critical);
        let gate = lock(&self.gate).clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            let rows = rows.ok_or_else(|| anyhow::anyhow!("table unreadable"))?;
            Ok(ProcessTable::listed(rows, critical))
        })
    }
}

fn row(pid: i32, parent: i32, group: i32, name: &str) -> ProcessRow {
    ProcessRow {
        pid,
        ppid: parent,
        pgid: group,
        name: name.to_string(),
    }
}

struct Harness {
    reader: Arc<ScriptedReader>,
    guard: Arc<KernelMemoryGuard>,
    now: Arc<Mutex<Instant>>,
}

impl Harness {
    fn new() -> Self {
        let reader = ScriptedReader::new();
        let now = Arc::new(Mutex::new(Instant::now()));
        let clock_now = Arc::clone(&now);
        let guard = KernelMemoryGuard::new(
            Some(Arc::clone(&reader) as Arc<dyn MemoryReader>),
            Some(Duration::from_secs(2)),
            Arc::new(move || *lock(&clock_now)),
        );
        Self { reader, guard, now }
    }

    fn advance(&self, by: Duration) {
        *lock(&self.now) += by;
    }

    fn watch(&self, kernel: &Arc<FakeKernel>) {
        let kernel: Arc<dyn MemoryGuardedKernel> =
            Arc::clone(kernel) as Arc<dyn MemoryGuardedKernel>;
        self.guard.watch(&kernel);
    }
}

#[tokio::test]
async fn one_pass_measures_every_watched_kernel_from_one_table() {
    let harness = Harness::new();
    let warned = FakeKernel::new(100, 10 * GIB, true);
    let trimmed = FakeKernel::new(200, 10 * GIB, true);
    let quiet = FakeKernel::new(300, 10 * GIB, true);
    for kernel in [&warned, &trimmed, &quiet] {
        harness.watch(kernel);
    }
    harness.reader.serve(
        vec![
            (row(100, 1, 1, "python"), 7 * GIB),
            (row(200, 1, 1, "python"), 11 * GIB),
            (row(201, 200, 201, "sort"), GIB),
            (row(300, 1, 1, "python"), GIB),
        ],
        false,
    );
    harness.guard.tick().await;
    assert_eq!(
        (
            warned.calls(),
            trimmed.calls(),
            quiet.calls(),
            harness.reader.reads.load(Ordering::SeqCst)
        ),
        (
            vec![Call::Warn(7 * GIB)],
            vec![Call::Trim(5 * GIB)],
            vec![],
            1
        )
    );
}

#[tokio::test]
async fn overlapping_ticks_join_the_pass_in_flight() {
    let harness = Harness::new();
    let kernel = FakeKernel::new(100, 10 * GIB, true);
    harness.watch(&kernel);
    harness
        .reader
        .serve(vec![(row(100, 1, 1, "python"), 7 * GIB)], false);
    let gate = Arc::new(Notify::new());
    *lock(&harness.reader.gate) = Some(Arc::clone(&gate));
    let first = tokio::spawn({
        let guard = Arc::clone(&harness.guard);
        async move { guard.tick().await }
    });
    harness.reader.entered.notified().await;
    let second = tokio::spawn({
        let guard = Arc::clone(&harness.guard);
        async move { guard.tick().await }
    });
    gate.notify_one();
    first.await.expect("first tick");
    second.await.expect("second tick");
    assert_eq!(
        (harness.reader.reads.load(Ordering::SeqCst), kernel.calls()),
        (1, vec![Call::Warn(7 * GIB)])
    );
}

#[tokio::test]
async fn an_unreadable_table_skips_the_pass_and_a_failed_step_never_stops_the_others() {
    let harness = Harness::new();
    let ended = FakeKernel::new(100, 10 * GIB, true);
    let warned = FakeKernel::new(200, 10 * GIB, true);
    harness.watch(&ended);
    harness.watch(&warned);
    harness.reader.fail();
    harness.guard.tick().await;
    assert_eq!((ended.calls(), warned.calls()), (vec![], vec![]));
    harness.reader.serve(
        vec![
            (row(100, 1, 1, "python"), 16 * GIB),
            (row(200, 1, 1, "python"), 6 * GIB),
        ],
        false,
    );
    harness.guard.tick().await;
    assert_eq!(
        (ended.calls(), warned.calls()),
        (
            vec![Call::End(KernelEndCause::Hard)],
            vec![Call::Warn(6 * GIB)]
        )
    );
}

#[tokio::test]
async fn the_backstop_picks_the_largest_enabled_tree_of_at_least_256_mib() {
    let harness = Harness::new();
    let largest_disabled = FakeKernel::new(100, 100 * GIB, false);
    let largest_enabled = FakeKernel::new(200, 100 * GIB, true);
    let smaller = FakeKernel::new(300, 100 * GIB, true);
    let tiny = FakeKernel::new(400, 100 * GIB, true);
    for kernel in [&largest_disabled, &largest_enabled, &smaller, &tiny] {
        harness.watch(kernel);
    }
    harness.reader.serve(
        vec![
            (row(100, 1, 1, "python"), 9 * GIB),
            (row(200, 1, 1, "python"), GIB),
            (row(201, 200, 201, "sort"), 2 * GIB),
            (row(300, 1, 1, "python"), GIB),
            (row(400, 1, 1, "python"), 255 * 1024 * 1024),
        ],
        true,
    );
    harness.guard.tick().await;
    assert_eq!(
        (
            largest_disabled.calls(),
            largest_enabled.calls(),
            smaller.calls(),
            tiny.calls()
        ),
        (
            vec![],
            vec![Call::Child {
                pid: 201,
                machine: true
            }],
            vec![],
            vec![]
        )
    );
}

#[tokio::test]
async fn a_finished_trim_restarts_the_grace_clock_and_dropped_kernels_are_skipped() {
    let harness = Harness::new();
    let kernel = FakeKernel::new(100, 10 * GIB, true);
    let dropped = FakeKernel::new(200, 10 * GIB, true);
    harness.watch(&kernel);
    harness.watch(&dropped);
    harness.reader.serve(
        vec![
            (row(100, 1, 1, "python"), 11 * GIB),
            (row(200, 1, 1, "python"), 11 * GIB),
        ],
        false,
    );
    drop(dropped);
    harness.guard.tick().await;
    harness.advance(Duration::from_secs(8));
    harness
        .guard
        .note_trimmed(kernel_identity(kernel.as_ref() as &dyn MemoryGuardedKernel));
    harness.advance(Duration::from_secs(9));
    harness.guard.tick().await;
    harness.advance(Duration::from_secs(1));
    harness.guard.tick().await;
    assert_eq!(
        kernel.calls(),
        vec![Call::Trim(5 * GIB), Call::End(KernelEndCause::Grace)]
    );
    // Unwatched kernels are never asked again.
    harness
        .guard
        .unwatch(kernel_identity(kernel.as_ref() as &dyn MemoryGuardedKernel));
    harness.guard.tick().await;
    assert_eq!(kernel.calls().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn the_timer_runs_one_pass_per_interval_after_the_first_watch_and_stops_with_the_last() {
    let harness = Harness::new();
    let kernel = FakeKernel::new(100, 10 * GIB, true);
    harness
        .reader
        .serve(vec![(row(100, 1, 1, "python"), GIB)], false);
    harness.watch(&kernel);
    // No pass at the watch itself.
    tokio::task::yield_now().await;
    assert_eq!(harness.reader.reads.load(Ordering::SeqCst), 0);
    harness.reader.entered.notified().await;
    assert_eq!(harness.reader.reads.load(Ordering::SeqCst), 1);
    harness.reader.entered.notified().await;
    assert_eq!(harness.reader.reads.load(Ordering::SeqCst), 2);
    harness
        .guard
        .unwatch(kernel_identity(kernel.as_ref() as &dyn MemoryGuardedKernel));
    assert!(lock(&harness.guard.state).timer.is_none());
}
