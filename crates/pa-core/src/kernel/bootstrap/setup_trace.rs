//! Opt-in diagnostics for kernel environment work: a host that wants a
//! trace of the setup (each bootstrap subprocess's start and end, the
//! readiness check, the foreground preparation) installs one process-wide
//! sink, and the host decides how a line is stamped and where it goes. With
//! no sink installed (the default) nothing is formatted or written.

use std::sync::{Arc, RwLock};

/// Receives one kernel setup trace line.
pub type KernelSetupTrace = Arc<dyn Fn(&str) + Send + Sync>;

static SINK: RwLock<Option<KernelSetupTrace>> = RwLock::new(None);

/// Install the process-wide kernel setup trace sink (the CLI's `--verbose`
/// installs one that writes timestamped lines to stderr). A later call
/// replaces the earlier sink.
pub fn set_kernel_setup_trace(sink: KernelSetupTrace) {
    *SINK
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sink);
}

/// Hand one line to the installed sink; the line is only built when a sink
/// listens.
pub(crate) fn trace(line: impl FnOnce() -> String) {
    let sink = SINK
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if let Some(sink) = sink {
        sink(&line());
    }
}
