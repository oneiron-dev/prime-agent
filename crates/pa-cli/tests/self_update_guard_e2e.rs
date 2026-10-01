//! The side-by-side self-update guard, end to end over the real binary:
//! with `PRIME_AGENT_DISABLE_SELF_UPDATE=1` every self-update entry — the
//! installer funnel (`update`, `update --force`), the staged native updater
//! (`update --rollback`, `update --archive … --source …`,
//! `package update --rollback`), the detached restart coordinator, and the
//! daemon's `prepare_update_restart` — refuses with the one shared message
//! before any request reaches the release endpoints and before any update
//! state is written. Both release URLs point at a loopback recorder that
//! answers 404, so a request that does get through never yields a script
//! or archive to run; the control shows the recorder sees the funnel's
//! fetch once the guard is off.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use pa_types::daemon::update_flow::{
    update_restarts_dir, UpdateId, UpdateState, UpdateStatus, UpdateStatusCounts,
    UPDATE_STATUS_FORMAT_VERSION,
};
use serde_json::{json, Value};

const REFUSAL: &str = "self-update is disabled for this install (PRIME_AGENT_DISABLE_SELF_UPDATE); install new builds with its own release tooling";

/// A loopback HTTP endpoint that records every request line and answers
/// 404.
struct Recorder {
    base: String,
    requests: Receiver<String>,
}

impl Recorder {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let base = format!("http://{}", listener.local_addr().expect("local address"));
        let (sender, requests) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                // Drain the head before answering: answering first can
                // reset the connection mid-write.
                let mut header = String::new();
                while reader.read_line(&mut header).is_ok_and(|read| read > 2) {
                    header.clear();
                }
                // Recorded before the answer: a child that made a request
                // waited for this answer, so once it exits the channel
                // holds every request it made.
                if sender.send(request_line.trim_end().to_string()).is_err() {
                    return;
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        Self { base, requests }
    }

    /// The requests recorded since the last call.
    fn requests(&self) -> Vec<String> {
        self.requests.try_iter().collect()
    }
}

/// Whether a run carries the guard.
#[derive(Clone, Copy)]
enum SelfUpdate {
    Disabled,
    Allowed,
}

/// A throwaway HOME, TMPDIR, agent dir, and install prefix.
struct Sandbox {
    root: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let sandbox = Self {
            root: tempfile::tempdir().expect("sandbox root"),
        };
        for dir in [sandbox.agent_dir(), sandbox.tmp(), sandbox.prefix()] {
            std::fs::create_dir_all(dir).expect("sandbox dir");
        }
        sandbox
    }

    fn path(&self) -> &Path {
        self.root.path()
    }

    fn home(&self) -> PathBuf {
        self.path().join("home")
    }

    fn agent_dir(&self) -> PathBuf {
        self.home().join(".prime/agent")
    }

    fn tmp(&self) -> PathBuf {
        self.path().join("tmp")
    }

    fn prefix(&self) -> PathBuf {
        self.home().join(".local")
    }

    /// Run the real binary with a cleared environment: PATH, the sandbox
    /// paths, telemetry off, and both release URLs on the recorder.
    fn run(&self, recorder: &Recorder, self_update: SelfUpdate, args: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
        command
            .args(args)
            .current_dir(self.home())
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", self.home())
            .env("TMPDIR", self.tmp())
            .env("PRIME_AGENT_CODING_AGENT_DIR", self.agent_dir())
            .env("PRIME_AGENT_RUST_PREFIX", self.prefix())
            .env(
                "PRIME_AGENT_RUST_INSTALLER_URL",
                format!("{}/install.sh", recorder.base),
            )
            .env(
                "PRIME_AGENT_DOWNLOAD_BASE_URL",
                format!("{}/releases", recorder.base),
            )
            .env("DO_NOT_TRACK", "1")
            .stdin(Stdio::null());
        match self_update {
            SelfUpdate::Disabled => {
                command.env("PRIME_AGENT_DISABLE_SELF_UPDATE", "1");
            }
            SelfUpdate::Allowed => {}
        }
        command.output().expect("run the prime-agent binary")
    }
}

/// One run's observable outcome: exit code, stderr, and the requests the
/// recorder saw.
fn outcome(output: &Output, recorder: &Recorder) -> (Option<i32>, String, Vec<String>) {
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        recorder.requests(),
    )
}

fn refused() -> (Option<i32>, String, Vec<String>) {
    (Some(1), format!("Error: {REFUSAL}\n"), Vec::new())
}

#[test]
fn every_cli_self_update_entry_refuses_before_any_request() {
    let sandbox = Sandbox::new();
    let recorder = Recorder::start();
    let archive = sandbox.path().join("payload.tar.gz");
    std::fs::write(&archive, b"not a release archive").expect("write archive");
    let archive = archive.to_string_lossy().into_owned();
    let source = format!("{}/releases", recorder.base);
    let invocations: [&[&str]; 5] = [
        &["update"],
        &["update", "--force"],
        &["update", "--rollback"],
        &["update", "--archive", &archive, "--source", &source],
        &["package", "update", "--rollback"],
    ];
    let observed: Vec<_> = invocations
        .iter()
        .map(|args| {
            let output = sandbox.run(&recorder, SelfUpdate::Disabled, args);
            (args.join(" "), outcome(&output, &recorder))
        })
        .collect();
    let expected: Vec<_> = invocations
        .iter()
        .map(|args| (args.join(" "), refused()))
        .collect();
    assert_eq!(observed, expected);
}

/// The detached coordinator (`update --internal-update-restart-coordinator`)
/// is spawned by the native updater, but its argv is reachable directly: it
/// refuses before adopting a staged status record (the record stays
/// byte-identical) or dialing the daemon.
#[test]
fn the_restart_coordinator_refuses_before_adopting_the_staged_status() {
    let sandbox = Sandbox::new();
    let recorder = Recorder::start();
    let socket = sandbox.path().join("daemon.sock");
    let status_path = update_restarts_dir(&sandbox.agent_dir()).join("staged/status.json");
    std::fs::create_dir_all(status_path.parent().expect("status dir")).expect("status dir");
    let staged = UpdateStatus {
        version: UPDATE_STATUS_FORMAT_VERSION,
        update_id: UpdateId::from("guard-e2e".to_string()),
        socket_path: socket.to_string_lossy().into_owned(),
        state: UpdateState::Staged,
        epoch: 3,
        coordinator: None,
        predecessor: None,
        successor: None,
        counts: UpdateStatusCounts::default(),
        failures: Vec::new(),
        message: None,
        started_at: "2026-10-01T00:00:00.000Z".to_string(),
        updated_at: "2026-10-01T00:00:00.000Z".to_string(),
        heartbeat_at: None,
        rest: serde_json::Map::default(),
    };
    let staged_bytes = serde_json::to_vec_pretty(&staged).expect("serialize status");
    std::fs::write(&status_path, &staged_bytes).expect("write status");

    let output = sandbox.run(
        &recorder,
        SelfUpdate::Disabled,
        &[
            "update",
            "--internal-update-restart-coordinator",
            "--daemon-socket",
            &socket.to_string_lossy(),
            "--internal-update-restart-status",
            &status_path.to_string_lossy(),
        ],
    );
    assert_eq!(
        (
            outcome(&output, &recorder),
            std::fs::read(&status_path).expect("status survives")
        ),
        (refused(), staged_bytes)
    );
}

/// The control: without the guard the same funnel run fetches the
/// installer from the recorder (a 404, so no script is written or run).
#[test]
fn without_the_guard_the_funnel_reaches_the_recorder() {
    let sandbox = Sandbox::new();
    let recorder = Recorder::start();
    let output = sandbox.run(&recorder, SelfUpdate::Allowed, &["update"]);
    let (code, stderr, requests) = outcome(&output, &recorder);
    assert_eq!(
        (code, requests),
        (Some(1), vec!["GET /install.sh HTTP/1.1".to_string()])
    );
    assert!(
        stderr.contains(&format!(
            "could not download the installer from {}/install.sh",
            recorder.base
        )),
        "the funnel reports the failed fetch:\n{stderr}"
    );
}

/// A sandboxed daemon, shut down over the wire on drop.
struct SandboxDaemon {
    socket: PathBuf,
}

impl Drop for SandboxDaemon {
    fn drop(&mut self) {
        // Best effort (a failing test unwinds through here): ask the daemon
        // to shut down and read until it closes the connection.
        let Ok(mut wire) = Wire::connect(&self.socket) else {
            return;
        };
        if wire
            .send("teardown", &json!({ "type": "shutdown" }))
            .is_err()
        {
            return;
        }
        while wire.read().is_ok() {}
    }
}

/// A raw JSONL daemon connection (hello consumed).
struct Wire {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Wire {
    fn connect(socket: &Path) -> std::io::Result<Self> {
        let stream = UnixStream::connect(socket)?;
        stream.set_read_timeout(Some(Duration::from_secs(60)))?;
        let mut wire = Self {
            writer: stream.try_clone()?,
            reader: BufReader::new(stream),
        };
        wire.read()?;
        Ok(wire)
    }

    fn send(&mut self, id: &str, command: &Value) -> std::io::Result<()> {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": {
                "name": pa_types::daemon::DAEMON_PROTOCOL_NAME,
                "version": pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            },
            "command": command,
        });
        writeln!(self.writer, "{envelope}")?;
        self.writer.flush()
    }

    fn read(&mut self) -> std::io::Result<Value> {
        let mut line = String::new();
        if self.reader.read_line(&mut line)? == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        serde_json::from_str(&line).map_err(std::io::Error::other)
    }
}

/// The daemon side: `prepare_update_restart` (the coordinator's first
/// daemon RPC) is refused before the transaction starts, so no prepared
/// roster or marker is ever written.
#[tokio::test]
async fn the_daemon_refuses_prepare_update_restart() {
    let sandbox = Sandbox::new();
    // The product launch path spawns its executable with this process's
    // environment; a wrapper hands the daemon the sandbox one, guard set.
    let launcher = sandbox.path().join("prime-agent-sandboxed");
    let quoted = |path: &Path| format!("'{}'", path.display());
    std::fs::write(
        &launcher,
        format!(
            "#!/bin/sh\nexec env -i PATH=\"$PATH\" HOME={home} TMPDIR={tmp} \
             PRIME_AGENT_CODING_AGENT_DIR={agent_dir} PRIME_AGENT_DISABLE_SELF_UPDATE=1 \
             PI_OFFLINE=1 DO_NOT_TRACK=1 {binary} \"$@\"\n",
            home = quoted(&sandbox.home()),
            tmp = quoted(&sandbox.tmp()),
            agent_dir = quoted(&sandbox.agent_dir()),
            binary = quoted(Path::new(env!("CARGO_BIN_EXE_prime-agent"))),
        ),
    )
    .expect("write launcher");
    std::fs::set_permissions(
        &launcher,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .expect("chmod launcher");
    let daemon = SandboxDaemon {
        socket: sandbox.path().join("d.sock"),
    };
    pa_cli::ensure_daemon_running_with(&launcher, &daemon.socket, sandbox.path())
        .await
        .expect("start the sandbox daemon");

    let mut wire = Wire::connect(&daemon.socket).expect("connect the daemon");
    wire.send(
        "prepare",
        &json!({ "type": "prepare_update_restart", "updateId": "guard-e2e" }),
    )
    .expect("send prepare_update_restart");
    let response = loop {
        let line = wire.read().expect("read the response");
        if line.get("id").and_then(Value::as_str) == Some("prepare") {
            break line;
        }
    };
    let update_artifacts: Vec<PathBuf> =
        std::fs::read_dir(update_restarts_dir(&sandbox.agent_dir()))
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
    assert_eq!(
        (response, update_artifacts),
        (
            json!({
                "id": "prepare",
                "type": "response",
                "command": "prepare_update_restart",
                "success": false,
                "error": REFUSAL,
            }),
            Vec::new()
        )
    );
}
