//! Per-OS daemon endpoint naming (TS: `daemon-socket.ts`
//! `defaultDaemonSocketPath` / `daemon-supervisor.ts` `workerSocketPath`).
//!
//! Unix: socket files under `<tmpdir>/prime-agent-<uid>/`. Windows: named
//! pipes in the `\\.\pipe\` namespace (fixed daemon pipe name, hashed worker
//! pipe names) - the TS product's exact split.
//!
//! Oneiron fork: `PRIME_AGENT_SOCKET_DIR` (an absolute path) relocates the
//! whole Unix endpoint namespace for a side-by-side install. Worker sockets
//! always live in the socket dir, not next to a custom
//! `PRIME_AGENT_DAEMON_SOCKET`, so without this a second install's workers
//! would listen inside the TS product's `prime-agent-<uid>/` dir and each
//! side's discovery would see the other's endpoints.

use std::path::{Path, PathBuf};

use crate::paths::hash_key;

/// Fork-only override for the Unix socket dir; unset keeps TS parity.
#[cfg(unix)]
const SOCKET_DIR_ENV: &str = "PRIME_AGENT_SOCKET_DIR";

/// Directory holding daemon socket files (Unix): the supervisor default,
/// every worker endpoint, and the discovery state root's socket dir.
#[cfg(unix)]
#[must_use]
pub fn socket_dir() -> PathBuf {
    resolve_socket_dir(
        std::env::var_os(SOCKET_DIR_ENV),
        std::env::var_os("TMPDIR"),
        current_uid(),
    )
}

/// An absolute override wins; a relative or empty one is ignored (a
/// cwd-relative endpoint namespace would differ per process), leaving the
/// TS default `<tmpdir>/prime-agent-<uid>`.
#[cfg(unix)]
fn resolve_socket_dir(
    override_dir: Option<std::ffi::OsString>,
    tmpdir: Option<std::ffi::OsString>,
    uid: Option<String>,
) -> PathBuf {
    if let Some(dir) = override_dir
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
    {
        return dir;
    }
    let uid = uid.unwrap_or_else(|| "user".to_string());
    let tmp = tmpdir.map_or_else(|| PathBuf::from("/tmp"), PathBuf::from);
    tmp.join(format!("prime-agent-{uid}"))
}

/// The socket-dir half of a discovery state root on Windows. Daemon
/// endpoints are named pipes with no directory, but TS still computes
/// `<tmpdir>/prime-agent-user` there (`getuid` is undefined, so the uid
/// suffix is the literal `user`) so `DaemonStateRoot` keeps one shape, and
/// discovery never sweeps it (the socket-dir scan returns nothing on
/// Windows).
#[cfg(not(unix))]
pub fn socket_dir() -> PathBuf {
    std::env::temp_dir().join("prime-agent-user")
}

/// Read the effective uid without libc: `/proc/self/status` on Linux,
/// HOME-derived uniqueness elsewhere (best-effort, same as today).
#[cfg(unix)]
fn current_uid() -> Option<String> {
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("Uid:") {
                if let Some(first) = rest.split_whitespace().next() {
                    return Some(first.to_string());
                }
            }
        }
    }
    None
}

/// Default supervisor endpoint: `daemon.sock` in the socket dir (Unix) or
/// the fixed daemon pipe name (Windows).
#[cfg(unix)]
#[must_use]
pub fn default_daemon_socket_path() -> PathBuf {
    socket_dir().join("daemon.sock")
}

#[cfg(not(unix))]
pub fn default_daemon_socket_path() -> PathBuf {
    PathBuf::from(r"\\.\pipe\prime-agent-daemon")
}

/// Worker endpoint next to the supervisor's: hashed supervisor key plus the
/// worker id prefix (TS `workerSocketPath`).
#[cfg(unix)]
#[must_use]
pub fn worker_socket_path(supervisor_socket_path: &Path, worker_id: &str) -> PathBuf {
    let key = hash_key(&supervisor_socket_path.to_string_lossy(), 12);
    socket_dir().join(format!(
        "worker-{key}-{}.sock",
        &worker_id[..12.min(worker_id.len())]
    ))
}

#[cfg(not(unix))]
pub fn worker_socket_path(supervisor_socket_path: &Path, worker_id: &str) -> PathBuf {
    let key = hash_key(&supervisor_socket_path.to_string_lossy(), 12);
    PathBuf::from(format!(
        r"\\.\pipe\prime-agent-worker-{key}-{}",
        &worker_id[..12.min(worker_id.len())]
    ))
}

// Socket-filesystem identity is the shared platform contract
// `pa_types::platform::socket_identity` (re-exported through
// `crate::platform`): the same helper serves stale-file cleanup here and
// direct-transport ticket validation in pa-tui/pa-cli clients.

pub use pa_types::daemon::SocketIdentity;
pub use pa_types::platform::socket_identity;
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_socket_names_are_deterministic() {
        let supervisor = Path::new("/tmp/prime-agent-1/daemon.sock");
        let a = worker_socket_path(supervisor, "0123456789abcdef");
        let b = worker_socket_path(supervisor, "fedcba9876543210");
        assert_ne!(a, b);
        // Only the first 12 id characters key the name.
        assert_eq!(a, worker_socket_path(supervisor, "0123456789abffff"));
        #[cfg(unix)]
        assert!(a.starts_with(socket_dir()));
    }

    /// The side-by-side override relocates the endpoint namespace only when
    /// it is an absolute path; anything else keeps the TS default.
    #[cfg(unix)]
    #[test]
    fn socket_dir_override_needs_an_absolute_path() {
        let resolve = |override_dir: Option<&str>| {
            resolve_socket_dir(
                override_dir.map(std::ffi::OsString::from),
                Some("/var/tmp".into()),
                Some("501".to_string()),
            )
        };
        assert_eq!(
            [
                resolve(Some("/tmp/pa-rs-501")),
                resolve(Some("pa-rs-501")),
                resolve(Some("")),
                resolve(None),
            ],
            [
                PathBuf::from("/tmp/pa-rs-501"),
                PathBuf::from("/var/tmp/prime-agent-501"),
                PathBuf::from("/var/tmp/prime-agent-501"),
                PathBuf::from("/var/tmp/prime-agent-501"),
            ]
        );
        assert_eq!(
            resolve_socket_dir(None, None, None),
            PathBuf::from("/tmp/prime-agent-user")
        );
    }

    /// The Windows endpoint names (TS `daemon-socket.ts` /
    /// `daemon-supervisor.ts` win32 arms): the fixed daemon pipe name and
    /// the hashed worker pipe name in the `\\.\pipe\` namespace. Runs
    /// only on the windows-latest job; the cross job compiles it.
    #[test]
    #[cfg(windows)]
    fn windows_endpoints_are_the_ts_pipe_names() {
        assert_eq!(
            default_daemon_socket_path(),
            PathBuf::from(r"\\.\pipe\prime-agent-daemon")
        );
        let supervisor = Path::new(r"\\.\pipe\prime-agent-daemon");
        let a = worker_socket_path(supervisor, "0123456789abcdef");
        let rendered = a.to_string_lossy();
        assert!(
            rendered.starts_with(r"\\.\pipe\prime-agent-worker-"),
            "the worker pipe namespace: {rendered}"
        );
        assert!(
            rendered.ends_with("-0123456789ab"),
            "the 12-char id suffix: {rendered}"
        );
    }
}
