//! The bootstrap's child processes (moved with their concern): every `uv`
//! step and every interpreter probe runs as a tokio child that the
//! bootstrap future owns. Nothing waits on a child from a runtime thread,
//! so a host that shuts its runtime down after the answer never waits for
//! a bootstrap step: dropping the future (a cancelled prewarm, a bounded
//! runtime shutdown) kills the child (`kill_on_drop`), and a fired
//! [`ChildCancel::On`] signal kills and reaps it before the step fails.

use std::process::{ExitStatus, Stdio};
use std::time::Instant;

use anyhow::{anyhow, Context};

use crate::kernel::bootstrap::setup_trace::trace;
use crate::kernel::cancellation::AbortSignal;

/// The error a cancelled bootstrap step fails with.
pub(crate) const KERNEL_SETUP_CANCELLED: &str = "Kernel environment setup cancelled";

/// The longest command line a trace line shows (the readiness probe's
/// inline program runs to kilobytes).
const TRACE_COMMAND_CHARS: usize = 160;

/// Where a bootstrap child's stdout and stderr go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChildOutput {
    /// The host's own streams (the `uv` steps report their progress there).
    Inherit,
    /// Discarded (the quiet interpreter probes).
    Discard,
}

/// What a bootstrap child races besides its own exit.
#[derive(Debug, Clone, Copy)]
pub(crate) enum ChildCancel<'a> {
    /// Run to completion; dropping the future still kills the child.
    Never,
    /// Kill and reap the child once the signal fires.
    On(&'a AbortSignal),
}

impl<'a> ChildCancel<'a> {
    /// [`Self::On`] the signal when there is one, else [`Self::Never`].
    pub(crate) fn from_signal(signal: Option<&'a AbortSignal>) -> Self {
        signal.map_or(Self::Never, Self::On)
    }

    pub(crate) async fn fired(self) {
        match self {
            Self::Never => std::future::pending::<()>().await,
            Self::On(signal) => signal.cancelled().await,
        }
    }

    fn is_fired(self) -> bool {
        match self {
            Self::Never => false,
            Self::On(signal) => signal.is_aborted(),
        }
    }
}

/// `program arg …`, cut to [`TRACE_COMMAND_CHARS`] for a trace line.
fn trace_command(command: &str, args: &[&str]) -> String {
    let program = std::path::Path::new(command).file_name().map_or_else(
        || command.to_string(),
        |name| name.to_string_lossy().to_string(),
    );
    let line = std::iter::once(program.as_str())
        .chain(args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    if line.chars().count() > TRACE_COMMAND_CHARS {
        let cut: String = line.chars().take(TRACE_COMMAND_CHARS).collect();
        format!("{cut}…")
    } else {
        line
    }
}

/// Run `command args` to completion as an owned child and return its exit
/// status (a non-zero status is the caller's verdict, not an error).
///
/// # Errors
///
/// Returns an error when the child cannot be spawned or waited on, and
/// [`KERNEL_SETUP_CANCELLED`] when `cancel` fires first: the child is
/// killed and reaped before the error returns.
pub(crate) async fn run_owned(
    command: &str,
    args: &[&str],
    output: ChildOutput,
    cancel: ChildCancel<'_>,
) -> anyhow::Result<ExitStatus> {
    if cancel.is_fired() {
        return Err(anyhow!(KERNEL_SETUP_CANCELLED));
    }
    let mut child = tokio::process::Command::new(command);
    child.args(args).stdin(Stdio::null()).kill_on_drop(true);
    if output == ChildOutput::Discard {
        child.stdout(Stdio::null()).stderr(Stdio::null());
    }
    // Hidden window on Windows (TS `spawnHidden`).
    crate::platform::process::set_no_window(child.as_std_mut());
    let started = Instant::now();
    let shown = trace_command(command, args);
    let mut child = child
        .spawn()
        .with_context(|| format!("failed to spawn {command}"))?;
    let pid = child.id().unwrap_or_default();
    trace(|| format!("bootstrap subprocess start (pid {pid}): {shown}"));
    tokio::select! {
        status = child.wait() => {
            let status = status.with_context(|| format!("failed to wait for {command}"))?;
            trace(|| {
                format!(
                    "bootstrap subprocess end (pid {pid}, {status}, {} ms): {shown}",
                    started.elapsed().as_millis()
                )
            });
            Ok(status)
        }
        () = cancel.fired() => {
            // Kill, then wait: the wait reaps the child, so nothing of a
            // cancelled step survives the error.
            let _ = child.kill().await;
            trace(|| {
                format!(
                    "bootstrap subprocess killed (pid {pid}, {} ms): {shown}",
                    started.elapsed().as_millis()
                )
            });
            Err(anyhow!(KERNEL_SETUP_CANCELLED))
        }
    }
}

#[cfg(all(test, unix))]
mod tests;
