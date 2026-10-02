//! Per-worker stderr capture e2e against the real supervisor and worker
//! binaries: a worker's stderr lands in its per-worker log under the
//! daemon's logs dir, a worker that never comes up reports the captured
//! stderr tail in the create failure, and the spawn-time prune bounds the
//! retained logs. The never-ready case is driven by a `TMPDIR` pointing
//! at a plain file: the worker resolves its socket dir under `TMPDIR` and
//! dies at the socket-path preparation with the failure on its
//! (captured) stderr, so the supervisor's probe budget runs out against a
//! dead worker — no test-only fault hook, just the real bind path
//! failing.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Daemon {
    child: Child,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct DaemonBuilder {
    command: Command,
}

impl DaemonBuilder {
    fn new(socket: &Path, agent_dir: &Path) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_pa-daemon"));
        command
            .arg("supervisor")
            .arg("--socket")
            .arg(socket)
            .arg("--agent-dir")
            .arg(agent_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env(
                pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
                "15000",
            );
        DaemonBuilder { command }
    }

    fn env(mut self, key: &str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        self.command.env(key, value);
        self
    }

    // The timeout panic path cannot wait on the child; the test process
    // exits immediately afterwards, reaping it.
    #[allow(clippy::zombie_processes)]
    fn spawn(mut self, socket: &Path) -> Daemon {
        let child = self.command.spawn().expect("spawn pa-daemon supervisor");
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if socket.exists() {
                return Daemon { child };
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("supervisor socket never appeared");
    }
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Self {
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect supervisor: {error}"),
            }
        };
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn send_command(&mut self, id: &str, command: &Value) {
        let mut line = serde_json::to_string(&json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }))
        .expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => {
                    return serde_json::from_str(line.trim()).expect("parse response line");
                }
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
    }
}

/// The active session id a create response answered (the summary's `id`,
/// the same id that names the worker's stderr log).
fn create_session(client: &mut Client, request_id: &str, config: &Value) -> String {
    client.send_command(request_id, &json!({ "type": "create", "config": config }));
    let created = client.read_response(request_id);
    assert_eq!(created["success"], true, "create failed: {created}");
    created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string()
}

fn write_script(dir: &Path, responses: &[&str]) -> PathBuf {
    let script_path = dir.join("engine-script.json");
    let scripted: Vec<Value> = responses
        .iter()
        .map(|text| json!({ "text": text }))
        .collect();
    std::fs::write(&script_path, json!({ "responses": scripted }).to_string())
        .expect("write script");
    script_path
}

/// The worker stderr logs currently in the daemon's logs dir.
fn worker_stderr_logs(agent_dir: &Path) -> Vec<String> {
    std::fs::read_dir(agent_dir.join("logs"))
        .expect("logs dir exists")
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with("worker-") && name.ends_with(".stderr.log"))
        .collect()
}

#[test]
fn worker_stderr_lands_in_the_per_worker_log_and_prunes_retention() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(agent_dir.join("logs")).expect("logs dir");
    // Retention pressure: more leftover logs than the daemon keeps, each
    // older than anything this run writes (backdated mtimes, the
    // session-archive test convention).
    for index in 0..70 {
        let path = agent_dir
            .join("logs")
            .join(format!("worker-old{index:03}.stderr.log"));
        std::fs::write(&path, "leftover from an earlier daemon run\n").expect("leftover log");
        let mtime = filetime::FileTime::from_unix_time(i64::from(index), 0);
        filetime::set_file_mtime(&path, mtime).expect("set mtime");
    }
    // PA_DAEMON_DEBUG makes the real worker narrate its boot on stderr
    // (accepted connection, auth ok): the capture's observable content.
    let _daemon = DaemonBuilder::new(&socket, &agent_dir)
        .env("PA_DAEMON_DEBUG", "1")
        .spawn(&socket);

    let script_path = write_script(dir.path(), &["first scripted"]);
    let create_config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": agent_dir.join("sessions").to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });
    let mut client = Client::connect(&socket);
    let session_id = create_session(&mut client, "c1", &create_config);

    let log_path = agent_dir
        .join("logs")
        .join(format!("worker-{session_id}.stderr.log"));
    let contents =
        std::fs::read_to_string(&log_path).expect("worker stderr log for the created session");
    assert!(
        contents.contains("auth ok"),
        "the worker's stderr output is in its per-worker log: {contents}"
    );

    // The spawn-time prune kept the newest logs only: the aged leftovers
    // collapse to the retention cap, and this run's fresh log rides above
    // it inside the prune-protection window (never a prune target while
    // its launch could still be settling).
    let remaining = worker_stderr_logs(&agent_dir);
    assert!(remaining.len() <= 65, "retention is bounded: {remaining:?}");
    assert!(remaining.contains(&format!("worker-{session_id}.stderr.log")));
    assert!(
        remaining.iter().any(|name| name.starts_with("worker-old")),
        "the retention cap keeps room for the fresh log without wiping recent history"
    );
    assert!(
        !remaining.contains(&"worker-old000.stderr.log".to_string()),
        "the oldest leftover was pruned: {remaining:?}"
    );
}

/// A worker that dies preparing its endpoint fails the create the moment
/// its exit is observed, never after the launch budget: the budget here is
/// ten minutes, so a response inside the client's read window can only be
/// the observed exit. The failure is typed (`worker_startup_failed`, the
/// exit code and the log path as fields) and its message names the exit
/// status, the worker's error line and the log; no resident or descriptor
/// is left behind, and the daemon keeps answering.
#[test]
fn a_worker_dying_at_startup_fails_the_create_with_its_exit_and_stderr() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    // The worker resolves its socket dir under TMPDIR: pointing TMPDIR
    // at a plain file makes the socket dir un-creatable (ENOTDIR, even
    // for root), so the real worker dies at its socket-path preparation
    // with the failure on stderr — the silent death of a worker whose
    // socket cannot bind (on macOS: a path past `sun_path`; Linux
    // re-anchors a long path, so the portable fixture is the ENOTDIR).
    // The supervisor's own endpoints are explicit paths, so it boots
    // untouched.
    let tmpdir_file = dir.path().join("not-a-directory");
    std::fs::write(&tmpdir_file, "the worker's socket dir would live here\n")
        .expect("write tmpdir file");

    // The supervisor reads this override at launch time
    // (`WORKER_CONNECT_TIMEOUT_ENV`, crate-private): a launch budget far
    // past the client's read window, so only the exit can answer.
    let _daemon = DaemonBuilder::new(&socket, &agent_dir)
        .env("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", "600000")
        .env("TMPDIR", &tmpdir_file)
        .spawn(&socket);

    let script_path = write_script(dir.path(), &["never reached"]);
    let create_config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": agent_dir.join("sessions").to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });
    let mut client = Client::connect(&socket);
    client.send_command("c1", &json!({ "type": "create", "config": create_config }));
    let failed = client.read_response("c1");

    // The evidence on disk: one launch, one captured log, the worker's
    // dying error in it.
    let logs = worker_stderr_logs(&agent_dir);
    assert_eq!(logs.len(), 1, "one launch, one captured log: {logs:?}");
    let log_path = agent_dir.join("logs").join(&logs[0]);
    let worker_id = logs[0]
        .strip_prefix("worker-")
        .and_then(|name| name.strip_suffix(".stderr.log"))
        .expect("worker id in the log name")
        .to_string();
    let contents = std::fs::read_to_string(&log_path).expect("read worker stderr log");
    assert!(
        contents.contains("Error:"),
        "the worker's dying error is in its log: {contents}"
    );
    let error_line = contents
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .expect("a last stderr line")
        .to_string();
    assert_eq!(
        failed,
        json!({
            "type": "response",
            "id": "c1",
            "command": "create",
            "success": false,
            "error": format!(
                "session worker {worker_id} exited during startup (exit status: 1): {error_line}\nworker log: {}",
                log_path.display()
            ),
            "errorInfo": {
                "code": "worker_startup_failed",
                "workerId": worker_id,
                "exitCode": 1,
                "logPath": log_path.display().to_string(),
            },
        })
    );

    // Nothing of the failed launch survives: no descriptor for a restart
    // to adopt, no resident in the roster, and the daemon still answers.
    let descriptors: Vec<String> = file_names_under(&agent_dir)
        .into_iter()
        .filter(|name| name == &format!("{worker_id}.json"))
        .collect();
    assert_eq!(descriptors, Vec::<String>::new());
    client.send_command("l1", &json!({ "type": "list" }));
    let listed = client.read_response("l1");
    assert_eq!(
        listed["success"], true,
        "the daemon still answers: {listed}"
    );
    assert_eq!(listed["data"]["sessions"], json!([]), "{listed}");
}

/// Every file name under `root` (recursively); empty when it is missing.
fn file_names_under(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(std::result::Result::ok)
        .flat_map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                file_names_under(&path)
            } else {
                vec![entry.file_name().to_string_lossy().to_string()]
            }
        })
        .collect()
}
