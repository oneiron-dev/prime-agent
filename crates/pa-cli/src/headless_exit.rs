//! The headless run's exit path (print/json, in-process and
//! `--daemon-hosted`): once the run's last output is written, flush stdout
//! and stderr, then shut the Tokio runtime down within
//! [`EXIT_BUDGET`] instead of the runtime drop's unbounded wait for
//! started blocking work. Every semantic step (compaction, refinement,
//! continuations, the disposal refinement drain, the transcript's durable
//! writes) finishes before this point; only work nobody waits for is cut.
//!
//! `--verbose` turns on the exit-phase trace: one stderr line per phase,
//! stamped with the milliseconds since the run started - the json
//! `agent_end` line written, each settled-turn boundary (compaction,
//! refinement, continuations), the terminal result, the disposal
//! refinement drain, the kernel abandon (hosted: the completion barrier and
//! the detach), the output flush and the runtime shutdown - plus the kernel
//! environment trace (the readiness check, each bootstrap subprocess's
//! start and end). Off by default; stdout never carries it.

use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// How long the exit may spend on what is left after the answer: the
/// runtime shutdown's bound, and the hosted client's detach wait.
pub(crate) const EXIT_BUDGET: Duration = Duration::from_millis(300);

static TRACE_ON: AtomicBool = AtomicBool::new(false);
static TRACE_START: OnceLock<Instant> = OnceLock::new();

/// Turn the exit-phase trace on for this process (`--verbose`), with the
/// kernel environment trace routed through the same stamped lines.
pub(crate) fn enable_trace() {
    TRACE_START.get_or_init(Instant::now);
    TRACE_ON.store(true, Ordering::Relaxed);
    pa_core::kernel::bootstrap::set_kernel_setup_trace(Arc::new(|line: &str| write_trace(line)));
}

/// One exit phase reached (a no-op unless the trace is on).
pub(crate) fn phase(name: &str) {
    if TRACE_ON.load(Ordering::Relaxed) {
        write_trace(name);
    }
}

fn write_trace(line: &str) {
    let start = TRACE_START.get_or_init(Instant::now);
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    eprintln!("[prime-agent exit +{elapsed_ms:.1}ms] {line}");
}

/// The run's output is complete: flush it, then shut the runtime down
/// within [`EXIT_BUDGET`]. Blocking work still running past the budget
/// (none of it the run's own) is left to the process exit that follows.
pub(crate) fn shut_down(runtime: tokio::runtime::Runtime) {
    phase("output flush");
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    phase("runtime shutdown start");
    runtime.shutdown_timeout(EXIT_BUDGET);
    phase("runtime shutdown end");
}
