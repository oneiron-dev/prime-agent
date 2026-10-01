//! Kernel memory sampling behind the platform wall (the readers of the TS
//! fork's `core/kernel/memory-guard.ts`): one table of the processes this
//! user can see - pid, parent, group, command name - with each process's
//! memory, plus whether the machine is about to run out of memory.
//!
//! Linux reads `/proc` (resident plus swapped bytes); macOS asks the kernel's
//! own Python for libproc's physical footprint (compressed pages included).
//! Other platforms have no reader, so the kernel memory ladder never runs
//! there. The kernel layer interprets the table; nothing here knows about
//! kernels.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;

mod linux;
mod macos;

/// One process in a table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessRow {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    /// The command name (`comm`), never its arguments.
    pub name: String,
}

/// Where a table's per-process sizes come from.
enum ProcessSizes {
    /// Measured while listing (macOS, fixtures).
    Listed(HashMap<i32, u64>),
    /// Read from `/proc/<pid>/status` on first use, once per table.
    #[cfg(target_os = "linux")]
    Procfs(std::sync::Mutex<HashMap<i32, u64>>),
}

/// Every visible process plus the machine's memory pressure, as of one read.
pub(crate) struct ProcessTable {
    pub rows: HashMap<i32, ProcessRow>,
    /// The machine is about to run out of memory.
    pub critical: bool,
    sizes: ProcessSizes,
}

impl ProcessTable {
    /// A table whose sizes were measured with the listing.
    // Linux measures lazily (procfs); there only the guard's fixtures build
    // listed tables.
    #[cfg_attr(all(target_os = "linux", not(test)), allow(dead_code))]
    pub(crate) fn listed(
        rows: impl IntoIterator<Item = (ProcessRow, u64)>,
        critical: bool,
    ) -> Self {
        let mut table_rows = HashMap::new();
        let mut sizes = HashMap::new();
        for (row, bytes) in rows {
            sizes.insert(row.pid, bytes);
            table_rows.insert(row.pid, row);
        }
        Self {
            rows: table_rows,
            critical,
            sizes: ProcessSizes::Listed(sizes),
        }
    }

    /// Memory of one process in bytes; 0 for an unknown or vanished pid.
    pub(crate) fn bytes_of(&self, pid: i32) -> u64 {
        match &self.sizes {
            ProcessSizes::Listed(sizes) => sizes.get(&pid).copied().unwrap_or(0),
            #[cfg(target_os = "linux")]
            ProcessSizes::Procfs(measured) => {
                let mut measured = measured
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                *measured
                    .entry(pid)
                    .or_insert_with(|| linux::read_status_bytes(pid))
            }
        }
    }
}

/// Reads one process table per memory pass.
///
/// Implementations do their OS work off the async worker threads (procfs
/// reads on the blocking pool, a bounded subprocess on macOS) and fail the
/// whole read when the table is unreadable; the guard skips that pass and
/// the next one retries. `python` is the kernel's interpreter, which the
/// macOS reader runs to reach libproc; other readers ignore it.
pub(crate) trait MemoryReader: Send + Sync {
    fn read(&self, python: Option<PathBuf>) -> BoxFuture<'static, anyhow::Result<ProcessTable>>;
}

/// The reader for this platform, or `None` where the ladder does not run.
// Linux and macOS always have one; the `Option` is the other platforms' answer.
#[allow(clippy::unnecessary_wraps)]
pub(crate) fn platform_memory_reader() -> Option<Arc<dyn MemoryReader>> {
    #[cfg(target_os = "linux")]
    {
        Some(Arc::new(linux::ProcfsReader))
    }
    #[cfg(target_os = "macos")]
    {
        Some(Arc::new(macos::FootprintReader))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

/// SIGKILL one stoppable unit under a kernel: its whole process group when
/// the unit owns one, else each measured member. A subtree that shares the
/// kernel's (and host's) group is never signaled through that group.
/// Exited members are expected races, not errors; a member that cannot be
/// signaled (permission) is an error naming it.
#[cfg(unix)]
pub(crate) fn kill_child_unit(pgid: Option<i32>, pids: &[i32]) -> anyhow::Result<()> {
    use nix::errno::Errno;
    use nix::sys::signal::{kill, killpg, Signal};
    use nix::unistd::Pid;

    let mut group_error = None;
    if let Some(pgid) = pgid.filter(|pgid| *pgid > 1) {
        match killpg(Pid::from_raw(pgid), Signal::SIGKILL) {
            Ok(()) => return Ok(()),
            // The group is gone: its measured members may have moved on.
            Err(Errno::ESRCH) => {}
            Err(error) => group_error = Some(format!("group {pgid}: {error}")),
        }
    }
    let mut failures: Vec<String> = Vec::new();
    for &pid in pids.iter().filter(|pid| **pid > 0) {
        match kill(Pid::from_raw(pid), Signal::SIGKILL) {
            Ok(()) | Err(Errno::ESRCH) => {}
            Err(error) => failures.push(format!("pid {pid}: {error}")),
        }
    }
    // Every measured member died by this signal or was already gone.
    if failures.is_empty() {
        return Ok(());
    }
    failures.extend(group_error);
    anyhow::bail!("could not stop the process unit ({})", failures.join(", "))
}

/// No reader runs on this platform, so no unit is ever measured.
#[cfg(not(unix))]
pub(crate) fn kill_child_unit(_pgid: Option<i32>, pids: &[i32]) -> anyhow::Result<()> {
    for &pid in pids {
        let _ = super::process::kill_pid(pid, super::process::Signal::Kill);
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};

    use super::*;

    /// A unit with its own group dies by the group signal; a unit whose
    /// processes already exited is stopped too (nothing is left running).
    #[test]
    fn a_group_unit_is_killed_and_an_exited_one_is_already_stopped() {
        let mut child = std::process::Command::new("tail")
            .args(["-f", "/dev/null"])
            .process_group(0)
            .spawn()
            .expect("spawn a child in its own group");
        let pid = i32::try_from(child.id()).expect("pid fits i32");
        let killed = kill_child_unit(Some(pid), &[pid]).map_err(|error| error.to_string());
        let status = child.wait().expect("reap the child");
        let exited = kill_child_unit(Some(pid), &[pid]).map_err(|error| error.to_string());
        assert_eq!(
            (killed, status.signal(), exited),
            (Ok(()), Some(libc::SIGKILL), Ok(()))
        );
    }
}
