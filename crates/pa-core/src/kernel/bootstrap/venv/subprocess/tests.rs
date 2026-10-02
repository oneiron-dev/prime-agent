//! The owned bootstrap child against fake programs gated on FIFOs the test
//! holds: a cancelled step is killed and reaped before it fails, a dropped
//! step's child is killed, and a bootstrap cancelled mid-install leaves no
//! venv a later readiness check accepts.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use super::{run_owned, ChildCancel, ChildOutput, KERNEL_SETUP_CANCELLED};
use crate::kernel::bootstrap::EnsureKernelPythonOptions;
use crate::kernel::cancellation::AbortSignal;

/// Failure bound for one awaited step (never a readiness wait).
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("the step settles")
}

/// A FIFO at `path` (`mkfifo(1)`: no new dependency for a fixture).
fn fifo(path: &Path) {
    let status = std::process::Command::new("mkfifo")
        .arg(path)
        .status()
        .expect("run mkfifo");
    assert!(status.success(), "mkfifo {}", path.display());
}

fn executable(path: &Path, script: &str) {
    std::fs::write(path, script).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// The gate a fake program blocks on: it opens `alive` for writing (the
/// test's read end learns its pid, and later its death as EOF), then
/// blocks opening `gate`, which the test never opens.
struct Gate {
    dir: tempfile::TempDir,
}

impl Gate {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        fifo(&dir.path().join("alive"));
        fifo(&dir.path().join("gate"));
        Self { dir }
    }

    fn path(&self, name: &str) -> std::path::PathBuf {
        self.dir.path().join(name)
    }

    /// The shell lines a gated fake program runs.
    fn block_lines(&self) -> String {
        format!(
            "exec 3>'{}'\necho $$ >&3\nread _ < '{}'\n",
            self.path("alive").display(),
            self.path("gate").display()
        )
    }

    /// The gated program started: its pid, and the alive pipe's read end
    /// (opened off the runtime: a FIFO open blocks until the writer comes).
    async fn started(&self) -> (u32, BufReader<File>) {
        let alive = self.path("alive");
        tokio::task::spawn_blocking(move || {
            let mut reader = BufReader::new(File::open(alive).expect("open the alive pipe"));
            let mut line = String::new();
            reader.read_line(&mut line).expect("read the gated pid");
            (line.trim().parse().expect("a pid line"), reader)
        })
        .await
        .unwrap()
    }
}

/// The alive pipe reached EOF: the gated program is gone.
async fn exited(mut alive: BufReader<File>) {
    tokio::task::spawn_blocking(move || {
        let mut rest = String::new();
        alive
            .read_to_string(&mut rest)
            .expect("read the alive pipe");
    })
    .await
    .unwrap();
}

/// A fired cancellation kills the running step and waits for it: the step
/// fails only once its child is reaped, zombie included.
#[tokio::test]
async fn a_cancelled_step_is_killed_and_reaped() {
    let gate = Gate::new();
    let program = gate.path("step");
    executable(&program, &format!("#!/bin/sh\n{}", gate.block_lines()));
    let signal = AbortSignal::new();
    let step = tokio::spawn({
        let signal = signal.clone();
        async move {
            run_owned(
                &program.to_string_lossy(),
                &[],
                ChildOutput::Discard,
                ChildCancel::On(&signal),
            )
            .await
        }
    });
    let (pid, alive) = bounded(gate.started()).await;
    signal.abort();
    let error = bounded(step).await.unwrap().unwrap_err();
    assert_eq!(error.to_string(), KERNEL_SETUP_CANCELLED);
    assert!(
        !crate::platform::process::pid_exists(pid),
        "the cancelled step's child {pid} was reaped"
    );
    bounded(exited(alive)).await;
}

/// Dropping a running step (a cancelled prewarm, a bounded runtime
/// shutdown) kills its child: no bootstrap subprocess outlives its owner.
#[tokio::test]
async fn a_dropped_step_kills_its_child() {
    let gate = Gate::new();
    let program = gate.path("step");
    executable(&program, &format!("#!/bin/sh\n{}", gate.block_lines()));
    let step = tokio::spawn(async move {
        run_owned(
            &program.to_string_lossy(),
            &[],
            ChildOutput::Discard,
            ChildCancel::Never,
        )
        .await
    });
    let (_pid, alive) = bounded(gate.started()).await;
    step.abort();
    assert!(bounded(step).await.unwrap_err().is_cancelled());
    bounded(exited(alive)).await;
}

/// A bootstrap cancelled while `uv` installs the runtime fails with the
/// cancellation, reaps the install, and leaves a venv the readiness check
/// refuses: the venv's interpreter passes every probe, so only the missing
/// version record (written last) keeps a later run from treating the
/// half-built venv as ready.
#[tokio::test]
async fn a_cancelled_bootstrap_leaves_no_venv_a_readiness_check_accepts() {
    let gate = Gate::new();
    let passing_python = gate.path("python-ok");
    executable(&passing_python, "#!/bin/sh\nexit 0\n");
    let uv = gate.path("uv");
    executable(
        &uv,
        &format!(
            "#!/bin/sh\ncase \"$1\" in\nvenv) mkdir -p \"$2/bin\" && cp '{}' \"$2/bin/python\" ;;\npip)\n{}\n;;\nesac\nexit 0\n",
            passing_python.display(),
            gate.block_lines()
        ),
    );
    let venv = gate.path("venv");
    let signal = AbortSignal::new();
    let build = tokio::spawn({
        let venv = venv.clone();
        let options = EnsureKernelPythonOptions {
            cancel: Some(signal.clone()),
            ..Default::default()
        };
        async move { super::super::bootstrap_venv(&uv.to_string_lossy(), &venv, &[], &options).await }
    });
    let (pid, alive) = bounded(gate.started()).await;
    signal.abort();
    let error = bounded(build).await.unwrap().unwrap_err();
    assert_eq!(error.to_string(), KERNEL_SETUP_CANCELLED);
    assert!(
        !crate::platform::process::pid_exists(pid),
        "the cancelled install {pid} was reaped"
    );
    bounded(exited(alive)).await;
    let python = super::super::kernel_venv_python(&venv);
    assert!(python.is_file(), "the venv step ran before the install");
    assert!(
        !super::super::kernel_ready(
            &python.to_string_lossy(),
            &venv,
            &super::super::resolve_runtime_identity(),
            &[],
            ChildCancel::Never,
        )
        .await,
        "a cancelled bootstrap's venv is not ready"
    );
}
