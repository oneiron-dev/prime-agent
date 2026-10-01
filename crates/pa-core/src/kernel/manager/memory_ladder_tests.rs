//! The ladder on a real kernel (the TS fork's `kernel-memory-guard.test.ts`
//! real-runtime suite): this worktree's `prime-agent-runtime` under the
//! `python3` on PATH, a guard of its own driven by explicit passes, and a
//! reader that lists the live process table but sizes it from the test's
//! script, so no test allocates real memory or depends on machine pressure.
//! FIFOs park a cell (or a `bash()` child) at a known point until the pass
//! has run.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tokio::sync::mpsc;

use super::*;
use crate::kernel::manager::KernelStartOptions;
use crate::kernel::memory_guard::tree::index_children;
use crate::kernel::shared::KernelShutdownOptions;
use crate::platform::kernel_memory::{platform_memory_reader, MemoryReader, ProcessTable};

const MIB: u64 = 1024 * 1024;

/// A value the runtime sizes at `nbytes` without holding that memory: its
/// sizing prefers an integer `nbytes` attribute, like an array's.
const SIZED_CLASS: &str =
    "class Sized:\n    def __init__(self, nbytes):\n        self.nbytes = nbytes\n";

/// Bound on any one wait below; a hang fails the test instead of the run.
const WAIT: Duration = Duration::from_secs(60);

/// The interpreter on PATH, or `None` (the test then skips with a note).
fn python3() -> Option<PathBuf> {
    let found = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("python3"))
            .find(|candidate| candidate.is_file())
    });
    if found.is_none() {
        eprintln!("python3 is not on PATH; skipping the real-kernel memory ladder test");
    }
    found
}

/// A Python string literal for a path.
fn py_str(path: &Path) -> String {
    serde_json::to_string(&path.display().to_string()).expect("a path serializes")
}

/// How one read sizes the live table: the kernel process itself and every
/// process-group leader under it (a `bash()` shell); every other process 0.
#[derive(Debug, Clone, Copy)]
struct Sizes {
    kernel: u64,
    group_leaders: u64,
}

/// The live procfs table with scripted sizes. Each read takes the next
/// scripted entry; the last one repeats.
struct ScriptedSizes {
    procfs: Arc<dyn MemoryReader>,
    kernel_pid: Mutex<i32>,
    script: Mutex<VecDeque<Sizes>>,
    /// The group leaders a read sized, with the command name it saw.
    seen: Arc<Mutex<HashMap<i32, String>>>,
    reads: AtomicUsize,
}

impl MemoryReader for ScriptedSizes {
    fn read(&self, python: Option<PathBuf>) -> BoxFuture<'static, anyhow::Result<ProcessTable>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let sizes = {
            let mut script = lock(&self.script);
            if script.len() > 1 {
                script.pop_front()
            } else {
                script.front().copied()
            }
        };
        let kernel_pid = *lock(&self.kernel_pid);
        let procfs = Arc::clone(&self.procfs);
        let seen = Arc::clone(&self.seen);
        Box::pin(async move {
            let sizes = sizes.ok_or_else(|| anyhow::anyhow!("no sizes scripted"))?;
            let live = procfs.read(python).await?;
            let children = index_children(&live.rows);
            let mut under_kernel = HashSet::new();
            let mut queue = vec![kernel_pid];
            while let Some(pid) = queue.pop() {
                for &child in children.get(&pid).map_or(&[][..], Vec::as_slice) {
                    if under_kernel.insert(child) {
                        queue.push(child);
                    }
                }
            }
            let rows = live
                .rows
                .into_values()
                .map(|row| {
                    let bytes = if row.pid == kernel_pid {
                        sizes.kernel
                    } else if under_kernel.contains(&row.pid) && row.pgid == row.pid {
                        lock(&seen).insert(row.pid, row.name.clone());
                        sizes.group_leaders
                    } else {
                        0
                    };
                    (row, bytes)
                })
                .collect::<Vec<_>>();
            Ok(ProcessTable::listed(rows, false))
        })
    }
}

/// One kernel on this worktree's runtime under a 1 GiB ceiling (backstop
/// off), joined to a guard only the test ticks.
struct Ladder {
    manager: ReplKernelManager,
    guard: Arc<KernelMemoryGuard>,
    reader: Arc<ScriptedSizes>,
    actions: tokio::sync::Mutex<mpsc::UnboundedReceiver<KernelMemoryActionStats>>,
    dir: tempfile::TempDir,
}

impl Ladder {
    async fn start(python: PathBuf, limit_gb: f64) -> Self {
        let reader = Arc::new(ScriptedSizes {
            procfs: platform_memory_reader().expect("Linux has a procfs reader"),
            kernel_pid: Mutex::new(0),
            script: Mutex::new(VecDeque::new()),
            seen: Arc::new(Mutex::new(HashMap::new())),
            reads: AtomicUsize::new(0),
        });
        let guard = KernelMemoryGuard::new(
            Some(Arc::clone(&reader) as Arc<dyn MemoryReader>),
            None,
            Arc::new(Instant::now),
        );
        let (actions_tx, actions) = mpsc::unbounded_channel();
        let dir = tempfile::tempdir().expect("temp dir");
        let runtime = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../prime-agent-runtime/src");
        let options = KernelManagerOptions {
            python: Some(python),
            cwd: Some(dir.path().to_path_buf()),
            env: HashMap::from([("PYTHONPATH".to_string(), runtime.display().to_string())]),
            memory_limit_gb: Some(limit_gb),
            memory_backstop: Some(false),
            on_memory_action: Some(Arc::new(move |stats| {
                let _ = actions_tx.send(stats);
            })),
            ..KernelManagerOptions::default()
        };
        let manager = ReplKernelManager::with_memory_guard(options, Arc::clone(&guard));
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("a kernel starts on this worktree's runtime");
        Self {
            manager,
            guard,
            reader,
            actions: tokio::sync::Mutex::new(actions),
            dir,
        }
    }

    fn kernel_pid(&self) -> i32 {
        self.manager.process_id().expect("a running kernel")
    }

    async fn run(&self, code: &str) -> ExecuteResult {
        tokio::time::timeout(WAIT, self.manager.execute(code, ExecuteOptions::default()))
            .await
            .expect("the cell settles")
            .expect("the cell runs")
    }

    /// One pass over the scripted sizes (the first for the pass itself, the
    /// rest for the measurements its steps take afterwards).
    async fn pass(&self, sizes: &[Sizes]) {
        *lock(&self.reader.kernel_pid) = self.kernel_pid();
        *lock(&self.reader.script) = sizes.iter().copied().collect();
        tokio::time::timeout(WAIT, self.guard.tick())
            .await
            .expect("the pass finishes");
    }

    /// The next memory step the kernel reported (its telemetry seam).
    async fn next_action(&self) -> KernelMemoryActionStats {
        tokio::time::timeout(WAIT, async { self.actions.lock().await.recv().await })
            .await
            .expect("a memory step is reported")
            .expect("the manager is alive")
    }

    fn fifo(&self, name: &str) -> PathBuf {
        let path = self.dir.path().join(name);
        nix::unistd::mkfifo(&path, nix::sys::stat::Mode::S_IRWXU).expect("mkfifo");
        path
    }

    /// Wait until the cell (or its child) opens `fifo` for writing.
    async fn reached(fifo: &Path) {
        tokio::time::timeout(WAIT, tokio::fs::read(fifo))
            .await
            .expect("the cell reached its parking point")
            .expect("read the fifo");
    }

    async fn shutdown(self) {
        self.manager
            .shutdown(KernelShutdownOptions::default())
            .await
            .expect("shutdown");
    }
}

fn sized(name: &str, bytes: u64, type_name: &str) -> SizedVariable {
    SizedVariable {
        name: name.to_string(),
        bytes: bytes as f64,
        type_name: type_name.to_string(),
        shape: None,
        dtype: None,
        length: None,
    }
}

fn stats(
    action: KernelMemoryAction,
    cause: KernelMemoryCause,
    tree: u64,
    kernel: u64,
) -> KernelMemoryActionStats {
    KernelMemoryActionStats {
        action,
        cause,
        tree_bytes: tree,
        kernel_bytes: kernel,
        limit_bytes: 1024 * MIB,
        after_bytes: None,
        dropped_count: None,
        cell_running: false,
    }
}

/// Idle, over the limit: the runtime drops the largest values (never one
/// under the 256 MiB floor) until the kernel is back at 60% of the limit,
/// the host measures again, and the next cell's result opens with it.
#[tokio::test]
async fn an_idle_trim_drops_the_largest_values_and_opens_the_next_result() {
    let Some(python) = python3() else {
        return;
    };
    let ladder = Ladder::start(python, 1.0).await;
    ladder
        .run(&format!(
            "{SIZED_CLASS}big = Sized({})\nbigger = Sized({})\nsmall = Sized({})",
            300 * MIB,
            400 * MIB,
            10 * MIB
        ))
        .await;
    ladder
        .pass(&[
            Sizes {
                kernel: 1300 * MIB,
                group_leaders: 0,
            },
            Sizes {
                kernel: 600 * MIB,
                group_leaders: 0,
            },
        ])
        .await;
    // The trim runs in its own request slot; its report is the readiness signal.
    let trimmed = ladder.next_action().await;
    let next = ladder
        .run("print('after')\n('big' in globals(), 'bigger' in globals(), 'small' in globals())")
        .await;
    let text = memory_trim_message(&TrimStepContext {
        total_bytes: (1300 * MIB) as f64,
        after_bytes: Some((600 * MIB) as f64),
        limit_bytes: GIB,
        dropped: &[
            sized("bigger", 400 * MIB, "Sized"),
            sized("big", 300 * MIB, "Sized"),
        ],
        cell_stopped: false,
        line: None,
    });
    assert_eq!(
        (
            next.queued_memory_notices,
            next.memory_notices,
            next.stdout,
            next.result,
            trimmed
        ),
        (
            Some(vec![text]),
            None,
            "after\n".to_string(),
            Some("(False, False, True)".to_string()),
            KernelMemoryActionStats {
                after_bytes: Some(600 * MIB),
                dropped_count: Some(2),
                ..stats(
                    KernelMemoryAction::Trim,
                    KernelMemoryCause::Limit,
                    1300 * MIB,
                    1300 * MIB
                )
            }
        )
    );
    ladder.shutdown().await;
}

/// Past 1.5x the limit while a cell runs: the kernel names its running line
/// and the values it holds, the host ends it and every process it started,
/// the cell settles as `KernelMemoryLimit`, and the next cell runs on a
/// fresh kernel with no revived namespace.
#[tokio::test]
async fn past_the_hard_limit_the_kernel_ends_at_its_running_line_and_the_next_cell_is_fresh() {
    let Some(python) = python3() else {
        return;
    };
    let ladder = Ladder::start(python, 1.0).await;
    ladder.run(&format!("{SIZED_CLASS}x = 1")).await;
    let first_pid = ladder.kernel_pid();
    let ready = ladder.fifo("ready");
    let release = ladder.fifo("release");
    let code = format!(
        "big = Sized({})\nopen({}, 'w').close()\nopen({}).read()",
        900 * MIB,
        py_str(&ready),
        py_str(&release)
    );
    let running = tokio::spawn({
        let manager = ladder.manager.clone();
        async move { manager.execute(&code, ExecuteOptions::default()).await }
    });
    Ladder::reached(&ready).await;
    ladder
        .pass(&[Sizes {
            kernel: 1600 * MIB,
            group_leaders: 0,
        }])
        .await;
    let ended = tokio::time::timeout(WAIT, running)
        .await
        .expect("the cell settles")
        .expect("the cell task")
        .expect("the cell result");
    let line = KernelCellLine {
        lineno: 3,
        source: format!("open({}).read()", py_str(&release)),
    };
    let text = memory_kill_message(&KillStepContext {
        total_bytes: (1600 * MIB) as f64,
        limit_bytes: GIB,
        cause: KernelEndCause::Hard,
        cell_running: true,
        line: Some(&line),
        held: Some(HeldVariables {
            // A small int is 28 bytes on 64-bit CPython.
            names: &[sized("big", 900 * MIB, "Sized"), sized("x", 28, "int")],
            more: 0,
            stale_seconds: None,
        }),
    });
    let ended_action = ladder.next_action().await;
    let fresh = ladder.run("'x' in globals()").await;
    assert_eq!(
        (
            ended.status,
            ended.error,
            ended.memory_notices,
            ended.queued_memory_notices,
            ended_action,
            fresh.result,
            ladder.kernel_pid() == first_pid
        ),
        (
            ExecuteStatus::Error,
            Some(KernelError {
                ename: "KernelMemoryLimit".to_string(),
                evalue: text.clone(),
                traceback: Vec::new(),
                line: None,
            }),
            Some(vec![text]),
            None,
            KernelMemoryActionStats {
                cell_running: true,
                ..stats(
                    KernelMemoryAction::End,
                    KernelMemoryCause::Hard,
                    1600 * MIB,
                    1600 * MIB
                )
            },
            Some("False".to_string()),
            false
        )
    );
    ladder.shutdown().await;
}

/// A `bash()` child that holds more than the kernel is stopped alone: the
/// awaiting call returns the reason with its SIGKILL, the host does not say
/// it twice, and the kernel's variables survive.
#[tokio::test]
async fn a_child_holding_most_is_stopped_alone_and_its_bash_call_returns_why() {
    let Some(python) = python3() else {
        return;
    };
    let ladder = Ladder::start(python, 1.0).await;
    ladder.run("before = 41").await;
    let go = ladder.fifo("child-go");
    let ready = ladder.fifo("child-ready");
    // The loop callback runs only once the cell is suspended on its handle,
    // and the shell signals READY only after that callback let it go: the
    // pass always sees a child whose bash() call the cell awaits.
    let code = format!(
        "import asyncio, shlex\nfrom rlm import bash\nh = bash('read _ < ' + shlex.quote({go}) + '; echo > ' + shlex.quote({ready}) + '; tail -f /dev/null')\nasyncio.get_running_loop().call_soon(lambda: open({go}, 'w').write('go\\n'))\nr = await h\nprint(r.exit_code)\nprint(r.output.strip())",
        go = py_str(&go),
        ready = py_str(&ready)
    );
    let running = tokio::spawn({
        let manager = ladder.manager.clone();
        async move { manager.execute(&code, ExecuteOptions::default()).await }
    });
    Ladder::reached(&ready).await;
    ladder
        .pass(&[Sizes {
            kernel: 100 * MIB,
            group_leaders: 1200 * MIB,
        }])
        .await;
    let result = tokio::time::timeout(WAIT, running)
        .await
        .expect("the cell settles")
        .expect("the cell task")
        .expect("the cell result");
    let (shell_pid, shell_name) = {
        let seen = lock(&ladder.reader.seen);
        assert_eq!(seen.len(), 1, "one bash() shell under the kernel: {seen:?}");
        seen.iter()
            .map(|(pid, name)| (*pid, name.clone()))
            .next()
            .expect("the shell")
    };
    let text = memory_child_message(&ChildStepContext {
        child: StoppedChild {
            name: &shell_name,
            pid: shell_pid,
            bytes: (1200 * MIB) as f64,
        },
        total_bytes: (1300 * MIB) as f64,
        after_bytes: (100 * MIB) as f64,
        limit_bytes: GIB,
        machine: false,
    });
    let stopped = ladder.next_action().await;
    let after = ladder.run("before + 1").await;
    assert_eq!(
        (
            result.stdout,
            result.memory_notices,
            result.queued_memory_notices,
            stopped,
            after.result
        ),
        (
            format!("-9\n{text}\n"),
            None,
            None,
            KernelMemoryActionStats {
                after_bytes: Some(100 * MIB),
                cell_running: true,
                ..stats(
                    KernelMemoryAction::Child,
                    KernelMemoryCause::Limit,
                    1300 * MIB,
                    100 * MIB
                )
            },
            Some("42".to_string())
        )
    );
    ladder.shutdown().await;
}

/// A ceiling of 0 turns the ladder off: the kernel never joins the guard,
/// so a pass reads no table at all.
#[tokio::test]
async fn a_zero_limit_never_watches_the_kernel() {
    let Some(python) = python3() else {
        return;
    };
    let ladder = Ladder::start(python, 0.0).await;
    let result = ladder.run("x = 1").await;
    ladder
        .pass(&[Sizes {
            kernel: 100 * 1024 * MIB,
            group_leaders: 0,
        }])
        .await;
    assert_eq!(
        (
            result.status,
            ladder.reader.reads.load(Ordering::SeqCst),
            ladder.manager.inner.memory_watch()
        ),
        (ExecuteStatus::Ok, 0, None)
    );
    ladder.shutdown().await;
}
