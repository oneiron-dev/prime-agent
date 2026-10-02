//! The launch watch: a worker the supervisor just spawned is raced against
//! every launch stage (the socket probe, connect + auth, the create), so a
//! worker that dies during startup fails the launch the moment its exit is
//! observed, with its exit status, its last stderr line and its log path,
//! instead of after the stage's own budget (the 30s connect deadline, the
//! 10-minute create route) or never. Oneiron fork: the macOS worker whose
//! socket path overflowed `sun_path` died at bind while its interactive
//! client waited without a word.

use std::future::Future;
use std::path::Path;
use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::Child;

use super::{DaemonErrorInfo, Result, Supervisor, TypedCreateRejection};

/// How long a stage failure waits for a still-running worker to exit before
/// the supervisor kills it. A dying worker often breaks the stage first (a
/// refused connect, a dropped auth connection) a moment before its exit is
/// reaped, and the exit diagnosis is the error the client needs, not the
/// transport symptom.
const STARTUP_EXIT_GRACE: Duration = Duration::from_millis(500);

impl Supervisor {
    /// Run one launch stage while watching the worker it launched. The
    /// worker's exit wins over the stage when both are ready (`biased`):
    /// the child is reaped and the launch fails with the typed startup
    /// failure. A stage that fails first gives a dying worker
    /// [`STARTUP_EXIT_GRACE`] to exit (the same startup failure); a worker
    /// still running after it is killed and reaped, and the stage's own
    /// error is returned. No child survives a failed stage, and nothing
    /// here restarts one.
    pub(super) async fn watch_launch_stage<T>(
        &self,
        worker_id: &str,
        child: &mut Child,
        stage: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        let stage_error = tokio::select! {
            biased;
            status = child.wait() => {
                return Err(self.worker_startup_failed(worker_id, child, status.ok()).await);
            }
            result = stage => match result {
                Ok(value) => return Ok(value),
                Err(error) => error,
            },
        };
        if let Ok(status) = tokio::time::timeout(STARTUP_EXIT_GRACE, child.wait()).await {
            return Err(self
                .worker_startup_failed(worker_id, child, status.ok())
                .await);
        }
        let _ = child.kill().await;
        Err(stage_error)
    }

    /// The first create's `worker_exited` telemetry for a worker that died
    /// during startup: the seam (and the `crash` reason) the monitor uses
    /// for a crash, never the stderr. A relaunch's startup death is not
    /// noted here: the monitor loop already counts every failed relaunch.
    pub(super) fn note_startup_exit(&self, error: &anyhow::Error) {
        let startup_exit = error
            .downcast_ref::<TypedCreateRejection>()
            .is_some_and(|rejection| {
                matches!(
                    rejection.error_info,
                    DaemonErrorInfo::WorkerStartupFailed { .. }
                )
            });
        if startup_exit {
            self.note_daemon_event("worker_exited", Some("crash"));
        }
    }

    /// Log a worker that exited during startup (the daemon log line names
    /// the status and the stderr headline) and build the client's typed
    /// failure. A wait that could not report a status still leaves no
    /// child behind.
    async fn worker_startup_failed(
        &self,
        worker_id: &str,
        child: &mut Child,
        status: Option<ExitStatus>,
    ) -> anyhow::Error {
        if status.is_none() {
            let _ = child.kill().await;
        }
        let log_path = crate::worker_stderr::log_path(&self.options.agent_dir, worker_id);
        let failure = startup_failure(worker_id, status, &log_path);
        let headline = failure.message.lines().next().unwrap_or_default();
        self.log_line(&format!("worker launch failed — {headline}"));
        failure.into()
    }
}

/// The typed create rejection for a worker that exited during startup:
/// the message names the worker, its exit status, its last stderr line and
/// its log (the same evidence `errorInfo` carries as fields).
fn startup_failure(
    worker_id: &str,
    status: Option<ExitStatus>,
    log_path: &Path,
) -> TypedCreateRejection {
    let status_text = status.map_or_else(|| "exit status unknown".to_string(), |s| s.to_string());
    let headline = format!("session worker {worker_id} exited during startup ({status_text})");
    let message = match crate::worker_stderr::error_line(log_path) {
        Ok(Some(line)) => format!("{headline}: {line}"),
        Ok(None) => format!("{headline} without writing to stderr"),
        Err(error) => format!("{headline}; its stderr log could not be read: {error:#}"),
    };
    TypedCreateRejection {
        message: format!("{message}\nworker log: {}", log_path.display()),
        error_info: DaemonErrorInfo::WorkerStartupFailed {
            worker_id: worker_id.to_string(),
            exit_code: status.and_then(|status| status.code()),
            signal: status.and_then(exit_signal),
            log_path: Some(log_path.display().to_string()),
        },
    }
}

#[cfg(unix)]
fn exit_signal(status: ExitStatus) -> Option<i32> {
    std::os::unix::process::ExitStatusExt::signal(&status)
}

#[cfg(not(unix))]
fn exit_signal(_status: ExitStatus) -> Option<i32> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::supervisor::SupervisorOptions;
    use std::os::unix::process::ExitStatusExt;
    use std::sync::Arc;

    fn supervisor(dir: &Path) -> Arc<Supervisor> {
        let agent_dir = dir.join("agent");
        std::fs::create_dir_all(agent_dir.join("logs")).expect("logs dir");
        Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.join("daemon.sock"),
                agent_dir,
            })
            .expect("supervisor"),
        )
    }

    /// A stand-in worker: `sh -c <script>` with its stderr in the worker's
    /// own log, as the supervisor spawns the real one.
    fn spawn_worker(supervisor: &Supervisor, worker_id: &str, script: &str) -> Child {
        let log = crate::worker_stderr::log_path(&supervisor.options.agent_dir, worker_id);
        let stderr = crate::worker_stderr::open_for_spawn(&log).expect("worker log");
        tokio::process::Command::new("sh")
            .args(["-c", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::from(stderr))
            .spawn()
            .expect("spawn stand-in worker")
    }

    fn rejection(error: &anyhow::Error) -> (String, DaemonErrorInfo) {
        let rejection = error
            .downcast_ref::<TypedCreateRejection>()
            .expect("a typed startup failure");
        (rejection.message.clone(), rejection.error_info.clone())
    }

    fn expected(
        supervisor: &Supervisor,
        worker_id: &str,
        detail: &str,
        code: i32,
    ) -> (String, DaemonErrorInfo) {
        let log = crate::worker_stderr::log_path(&supervisor.options.agent_dir, worker_id);
        (
            format!(
                "session worker {worker_id} exited during startup (exit status: {code}){detail}\nworker log: {}",
                log.display()
            ),
            DaemonErrorInfo::WorkerStartupFailed {
                worker_id: worker_id.to_string(),
                exit_code: Some(code),
                signal: None,
                log_path: Some(log.display().to_string()),
            },
        )
    }

    /// The worker dies while the stage still waits (the probe of a socket
    /// that will never bind): the exit fails the launch at once, with the
    /// status, the last stderr line and the log.
    #[tokio::test]
    async fn an_exit_during_a_pending_stage_fails_the_launch_with_the_worker_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let supervisor = supervisor(dir.path());
        let mut child = spawn_worker(
            &supervisor,
            "aaaaaaaaaaaa",
            "echo booting >&2; echo 'Error: bind worker socket /s/w.sock: path must be shorter than SUN_LEN' >&2; exit 3",
        );
        let error = supervisor
            .watch_launch_stage(
                "aaaaaaaaaaaa",
                &mut child,
                std::future::pending::<Result<()>>(),
            )
            .await
            .expect_err("the worker exited");
        assert_eq!(
            rejection(&error),
            expected(
                &supervisor,
                "aaaaaaaaaaaa",
                ": Error: bind worker socket /s/w.sock: path must be shorter than SUN_LEN",
                3
            )
        );
        assert!(
            matches!(child.try_wait(), Ok(Some(_))),
            "the child is reaped"
        );
    }

    /// A worker that dies silently still gets its status and log named.
    #[tokio::test]
    async fn a_silent_exit_names_the_status_and_the_log() {
        let dir = tempfile::tempdir().expect("temp dir");
        let supervisor = supervisor(dir.path());
        let mut child = spawn_worker(&supervisor, "bbbbbbbbbbbb", "exit 1");
        let error = supervisor
            .watch_launch_stage(
                "bbbbbbbbbbbb",
                &mut child,
                std::future::pending::<Result<()>>(),
            )
            .await
            .expect_err("the worker exited");
        assert_eq!(
            rejection(&error),
            expected(&supervisor, "bbbbbbbbbbbb", " without writing to stderr", 1)
        );
    }

    /// A stage that breaks because its worker is dying (the connect a dead
    /// socket refuses) reports the exit, not the transport symptom.
    #[tokio::test]
    async fn a_stage_failing_as_the_worker_dies_reports_the_exit() {
        let dir = tempfile::tempdir().expect("temp dir");
        let supervisor = supervisor(dir.path());
        let mut child = spawn_worker(
            &supervisor,
            "cccccccccccc",
            "echo 'Error: worker auth' >&2; exit 2",
        );
        let error = supervisor
            .watch_launch_stage("cccccccccccc", &mut child, async {
                Err::<(), _>(anyhow::anyhow!("connect worker socket refused"))
            })
            .await
            .expect_err("the stage failed");
        assert_eq!(
            rejection(&error),
            expected(&supervisor, "cccccccccccc", ": Error: worker auth", 2)
        );
    }

    /// A live worker: the stage's own outcome passes through. A success
    /// leaves the child running; a failure kills it after the grace and
    /// keeps the stage's error (paused time runs the grace out at once).
    #[tokio::test(start_paused = true)]
    async fn a_live_worker_lets_the_stage_outcome_through() {
        let dir = tempfile::tempdir().expect("temp dir");
        let supervisor = supervisor(dir.path());
        // `cat` on a held-open stdin pipe: alive until killed.
        let mut child = spawn_worker(&supervisor, "dddddddddddd", "exec cat");
        let value = supervisor
            .watch_launch_stage("dddddddddddd", &mut child, async { Ok(7) })
            .await
            .expect("the stage finished first");
        assert_eq!((value, child.try_wait().expect("try_wait")), (7, None));
        let error = supervisor
            .watch_launch_stage("dddddddddddd", &mut child, async {
                Err::<(), _>(anyhow::anyhow!("worker authentication failed: bad token"))
            })
            .await
            .expect_err("the stage failed");
        assert_eq!(
            format!("{error:#}"),
            "worker authentication failed: bad token"
        );
        let status = child
            .try_wait()
            .expect("try_wait")
            .expect("killed and reaped");
        assert_eq!(status.signal(), Some(9));
    }
}
