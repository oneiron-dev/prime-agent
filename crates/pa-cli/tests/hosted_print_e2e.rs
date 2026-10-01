//! `--daemon-hosted` end to end: the real binary, an isolated HOME, its own
//! daemon socket and worker socket dir, and a scripted faux daemon worker
//! (`PRIME_AGENT_HOSTED_DAEMON_SCRIPT`). The print client starts the
//! sandbox daemon itself (the product ensure path); every test shuts its
//! daemon down over the wire when it ends. Synchronization is on observable
//! protocol facts (stdout events, wire responses, a pidfd exit); the waits
//! are failure bounds only.
//!
//! Linux-only (`AF_UNIX` sockets, pidfd), like the daemon e2e verifiers.
#![cfg(target_os = "linux")]
// The narrowing casts sit at OS boundaries (pids, poll timeouts).
#![allow(clippy::cast_possible_wrap, clippy::cast_possible_truncation)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

/// Failure bound for one awaited step.
const STEP_BOUND: Duration = Duration::from_mins(2);

/// Inherited variable families the sandbox never passes on: the product's
/// own configuration (agent dir, sockets, kernel venv/python, package dir,
/// worker role, event logs) and a factory seat's launch overlay.
const SCRUBBED_ENV_PREFIXES: [&str; 4] = ["PRIME_AGENT_", "PI_", "PA_DAEMON_", "W7_CARGO_"];

/// One test's sandbox: HOME, the daemon socket, the worker socket dir, and
/// the faux worker script. Dropping it shuts the sandbox daemon down.
struct Sandbox {
    dir: tempfile::TempDir,
}

impl Sandbox {
    fn new(script: &Value) -> Self {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("home")).unwrap();
        std::fs::write(dir.path().join("script.json"), script.to_string()).unwrap();
        Self { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    fn socket(&self) -> PathBuf {
        self.dir.path().join("d.sock")
    }

    /// The CLI under test, sandboxed: nothing ambient (agent dir, sockets,
    /// kernel paths, provider keys, worker role) leaks in, and the daemon it
    /// starts inherits the same sandbox (offline, short orphan window).
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
        for (name, _) in std::env::vars_os() {
            if name.to_str().is_some_and(|name| {
                SCRUBBED_ENV_PREFIXES
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
            }) {
                command.env_remove(name);
            }
        }
        command
            .arg("--daemon-socket")
            .arg(self.socket())
            .args(args)
            .current_dir(self.home())
            .env("HOME", self.home())
            .env("TMPDIR", self.dir.path())
            .env("PRIME_AGENT_SOCKET_DIR", self.dir.path().join("s"))
            .env(
                "PRIME_AGENT_HOSTED_DAEMON_SCRIPT",
                self.dir.path().join("script.json"),
            )
            .env("PI_OFFLINE", "1")
            .env(
                pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
                "15000",
            )
            .env("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", "90000")
            .stdin(Stdio::null());
        for var in [
            "PRIME_AGENT_CODING_AGENT_DIR",
            "PRIME_AGENT_SESSION_DIR",
            "PRIME_AGENT_CODING_AGENT_SESSION_DIR",
            "PRIME_AGENT_DAEMON_SOCKET",
            "PRIME_AGENT_FAUX_SCRIPT",
            "PRIME_TEAM_ID",
            "RLM_DEPTH",
            pa_daemon::worker::WORKER_ROLE_ENV,
            pa_daemon::worker::WORKER_TOKEN_ENV,
            pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
            pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
            pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
            pa_daemon::worker::WORKER_SOCKET_ENV,
            pa_daemon::worker::WORKER_INSTANCE_ID_ENV,
            pa_daemon::worker::WORKER_SCRIPT_ENV,
        ] {
            command.env_remove(var);
        }
        for provider in pa_ai::models_generated::get_providers() {
            for var in pa_ai::env_api_keys::get_api_key_env_vars(provider).unwrap_or_default() {
                command.env_remove(var);
            }
        }
        command
    }

    fn run(&self, args: &[&str]) -> (String, String, i32) {
        let output = self.command(args).output().expect("binary present");
        (
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
            output.status.code().unwrap_or(-1),
        )
    }

    /// A raw protocol client (the daemon is up: a hosted run started it).
    #[track_caller]
    fn wire(&self) -> Wire {
        Wire::connect(&self.socket())
    }

    /// The resident sessions the daemon lists.
    #[track_caller]
    fn sessions(&self) -> Vec<Value> {
        let response = self.wire().request(&json!({ "type": "list" }));
        response["data"]["sessions"].as_array().cloned().unwrap()
    }
}

impl Drop for Sandbox {
    /// The sandbox daemon dies with its test, workers included, before the
    /// sandbox directory goes: a forced `shutdown` over its own socket,
    /// then the supervisor's exit observed through a pidfd (the stop pass
    /// still writes into the sandbox after the connection closes). Best
    /// effort: no daemon, or one already gone, is fine. A failed test
    /// first prints the tail of every daemon and worker log the sandbox
    /// wrote, the evidence a remote run leaves no other way.
    fn drop(&mut self) {
        if std::thread::panicking() {
            let logs = self.home().join(".prime/agent/logs");
            for entry in std::fs::read_dir(&logs).into_iter().flatten().flatten() {
                let Ok(text) = std::fs::read_to_string(entry.path()) else {
                    continue;
                };
                let tail = &text[text.floor_char_boundary(text.len().saturating_sub(16_384))..];
                eprintln!("--- {} ---\n{tail}", entry.path().display());
            }
        }
        let Ok(stream) = UnixStream::connect(self.socket()) else {
            return;
        };
        let _ = stream.set_read_timeout(Some(STEP_BOUND));
        let Ok(mut writer) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        let mut hello = String::new();
        if reader.read_line(&mut hello).is_err() {
            return;
        }
        let supervisor = serde_json::from_str::<Value>(&hello)
            .ok()
            .and_then(|hello| hello["supervisorPid"].as_u64())
            .and_then(|pid| pa_core::platform::process::open_pidfd(pid as u32));
        let shutdown = json!({
            "type": "command",
            "id": "sandbox-shutdown",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": { "type": "shutdown", "force": true },
        });
        if writeln!(writer, "{shutdown}").is_err() {
            return;
        }
        // The supervisor closes the connection once its stop pass starts.
        for line in reader.lines() {
            if line.is_err() {
                break;
            }
        }
        if let Some(pidfd) = supervisor {
            // A pidfd turns readable when its process exits.
            let mut exited = libc::pollfd {
                fd: pidfd,
                events: libc::POLLIN,
                revents: 0,
            };
            unsafe {
                libc::poll(&raw mut exited, 1, STEP_BOUND.as_millis() as i32);
                libc::close(pidfd);
            }
        }
    }
}

/// A JSONL daemon-protocol client over the sandbox socket.
struct Wire {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_id: u64,
}

impl Wire {
    #[track_caller]
    fn connect(socket: &Path) -> Self {
        Self::from_stream(UnixStream::connect(socket).expect("the hosted run started the daemon"))
    }

    #[track_caller]
    fn from_stream(stream: UnixStream) -> Self {
        stream.set_read_timeout(Some(STEP_BOUND)).unwrap();
        let writer = stream.try_clone().unwrap();
        let mut wire = Self {
            reader: BufReader::new(stream),
            writer,
            next_id: 0,
        };
        let hello = wire.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        wire
    }

    fn send(&mut self, command: &Value) -> String {
        self.next_id += 1;
        let id = format!("test-{}", self.next_id);
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        writeln!(self.writer, "{envelope}").unwrap();
        id
    }

    #[track_caller]
    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let read = self
            .reader
            .read_line(&mut line)
            .expect("a daemon line inside the step bound");
        assert!(read > 0, "the daemon closed the connection");
        serde_json::from_str(line.trim()).unwrap()
    }

    #[track_caller]
    fn read_until(&mut self, done: impl Fn(&Value) -> bool) -> Value {
        loop {
            let line = self.read_line();
            if done(&line) {
                return line;
            }
        }
    }

    #[track_caller]
    fn request(&mut self, command: &Value) -> Value {
        let id = self.send(command);
        let response = self.read_until(|line| line["type"] == "response" && line["id"] == id);
        assert_eq!(response["success"], true, "{response}");
        response
    }
}

fn json_lines(stdout: &str) -> Vec<Value> {
    stdout
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .expect("every stdout line is one JSON object")
}

fn types(lines: &[Value]) -> Vec<&str> {
    lines
        .iter()
        .map(|line| line["type"].as_str().unwrap_or_default())
        .collect()
}

/// The text of the user rows a session file holds.
fn user_texts(session_file: &str) -> Vec<String> {
    std::fs::read_to_string(session_file)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| entry["type"] == "message" && entry["message"]["role"] == "user")
        .map(|entry| {
            entry["message"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

/// A hosted json run streams the TS print-mode surface (the header, then
/// the session's events through its final `agent_end`) and leaves the
/// session resident in the daemon after the client detached.
#[test]
fn hosted_json_run_streams_the_session_and_leaves_it_resident() {
    let sandbox = Sandbox::new(&json!({ "engine": "faux", "responses": ["HOSTED-ANSWER"] }));
    let (stdout, stderr, code) =
        sandbox.run(&["--mode", "json", "--daemon-hosted", "-p", "hello hosted"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let lines = json_lines(&stdout);
    let header = &lines[0];
    assert_eq!(header["type"], "session");
    assert_eq!(header["cwd"], json!(sandbox.home().display().to_string()));
    assert_eq!(header.get("jsonEventProfile"), None);
    let types = types(&lines);
    assert_eq!(
        types.iter().filter(|kind| **kind == "agent_start").count(),
        types.iter().filter(|kind| **kind == "agent_end").count(),
        "every run streamed its agent_end: {types:?}"
    );
    assert!(types.contains(&"message_update"), "{types:?}");
    let answer = lines
        .iter()
        .rev()
        .find(|line| line["type"] == "message_end" && line["message"]["role"] == "assistant")
        .expect("the assistant answer streamed");
    assert_eq!(answer["message"]["content"][0]["text"], "HOSTED-ANSWER");
    // Resident: still listed, its worker up, after the client left.
    let sessions = sandbox.sessions();
    let row = sessions
        .iter()
        .find(|row| row["sessionId"] == header["id"])
        .expect("the hosted session stays listed");
    assert_eq!(row["workerState"], "ready");
    assert_eq!(
        user_texts(row["sessionFile"].as_str().unwrap()),
        ["hello hosted"]
    );
}

/// `-c` resolves the newest saved session for this cwd on the client and
/// `--resume <file>` names it; both reach the SAME live worker (its faux
/// script answers in order, so a fresh worker would answer "FIRST" again).
#[test]
fn continue_and_resume_reuse_the_live_worker() {
    let sandbox = Sandbox::new(&json!({
        "engine": "faux",
        "responses": ["FIRST", "SECOND", "THIRD"],
    }));
    let (stdout, stderr, code) = sandbox.run(&["--daemon-hosted", "-p", "one"]);
    assert_eq!((stdout.as_str(), code), ("FIRST\n", 0), "stderr: {stderr}");
    let sessions = sandbox.sessions();
    assert_eq!(sessions.len(), 1);
    let first = sessions[0].clone();
    let (stdout, stderr, code) = sandbox.run(&["--daemon-hosted", "-c", "-p", "two"]);
    assert_eq!((stdout.as_str(), code), ("SECOND\n", 0), "stderr: {stderr}");
    let session_file = first["sessionFile"].as_str().unwrap().to_string();
    let (stdout, stderr, code) =
        sandbox.run(&["--daemon-hosted", "--resume", &session_file, "-p", "three"]);
    assert_eq!((stdout.as_str(), code), ("THIRD\n", 0), "stderr: {stderr}");
    let sessions = sandbox.sessions();
    assert_eq!(sessions.len(), 1, "{sessions:?}");
    for key in ["activeSessionId", "workerPid", "sessionFile"] {
        assert_eq!(sessions[0][key], first[key], "{key}");
    }
    assert_eq!(user_texts(&session_file), ["one", "two", "three"]);
}

/// While a hosted run streams, another client can attach to the same
/// resident session; a signal ends the print client (143) by detaching —
/// the turn keeps running for the daemon — and the reduced profile streams
/// no progressive snapshots.
#[test]
fn second_client_attaches_and_a_signal_only_detaches() {
    // The turn holds in flight until aborted (no timer releases it), so the
    // attach and the signal land mid-run.
    let sandbox = Sandbox::new(&json!({
        "engine": "faux",
        "responses": [{ "text": "held", "holdUntilAborted": true }],
    }));
    let mut child = sandbox
        .command(&[
            "--mode",
            "json",
            "--json-event-profile",
            "factory-completed",
            "--daemon-hosted",
            "-p",
            "slow turn",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let (line_tx, line_rx) = mpsc::channel::<Value>();
    let stdout = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line_tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                return;
            }
        }
    });
    let header = line_rx.recv_timeout(STEP_BOUND).unwrap();
    assert_eq!(header["type"], "session");
    assert_eq!(header["jsonEventProfile"], "factory-completed");
    loop {
        let line = line_rx.recv_timeout(STEP_BOUND).unwrap();
        assert_ne!(line["type"], "message_update");
        if line["type"] == "agent_start" {
            break;
        }
    }
    let row = sandbox
        .sessions()
        .into_iter()
        .find(|row| row["sessionId"] == header["id"])
        .unwrap();
    assert_eq!(row["isStreaming"], true);
    let active_session_id = row["activeSessionId"].clone();
    let mut observer = sandbox.wire();
    observer.request(&json!({ "type": "attach", "activeSessionId": active_session_id }));

    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(143));
    let row = sandbox
        .sessions()
        .into_iter()
        .find(|row| row["sessionId"] == header["id"])
        .expect("the session outlives its print client");
    assert_eq!(
        row["isStreaming"], true,
        "the client exit did not stop the turn"
    );

    // The observer still owns a live attachment: its abort ends the turn
    // and it receives the run's agent_end.
    observer.send(&json!({ "type": "abort", "activeSessionId": active_session_id }));
    observer
        .read_until(|line| line["type"] == "session_event" && line["event"]["type"] == "agent_end");
}

/// Flags the daemon session cannot receive fail before any daemon starts;
/// the rpc/acp transports refuse the flag instead of ignoring it.
#[test]
fn hosted_refuses_what_it_cannot_honor() {
    let sandbox = Sandbox::new(&json!({ "engine": "faux", "responses": [] }));
    for (args, expected) in [
        (
            ["--daemon-hosted", "--no-skills", "-p", "x"].as_slice(),
            "Error: --daemon-hosted cannot be combined with --no-skills yet: the daemon session does not receive it\n",
        ),
        (
            ["--daemon-hosted", "--offline", "--goal", "g", "-p", "x"].as_slice(),
            "Error: --daemon-hosted cannot be combined with --goal, --offline yet: the daemon session does not receive them\n",
        ),
        (
            ["--daemon-hosted", "--no-session", "-p", "x"].as_slice(),
            "Error: --daemon-hosted cannot be combined with --no-session\n",
        ),
        (
            ["--mode", "rpc", "--daemon-hosted"].as_slice(),
            "Error: --daemon-hosted is not supported in rpc mode yet\n",
        ),
    ] {
        let (stdout, stderr, code) = sandbox.run(args);
        assert_eq!((stdout.as_str(), stderr.as_str(), code), ("", expected, 1));
    }
    // A factory seat's cargo overlay cannot reach a daemon worker.
    let output = sandbox
        .command(&["--daemon-hosted", "-p", "x"])
        .env("W7_CARGO_WORK", sandbox.home())
        .output()
        .expect("binary present");
    assert_eq!(
        (
            String::from_utf8_lossy(&output.stdout).as_ref(),
            String::from_utf8_lossy(&output.stderr).as_ref(),
            output.status.code(),
        ),
        (
            "",
            "Error: --daemon-hosted cannot be combined with the launch environment (W7_CARGO_WORK) yet: the daemon session does not receive it\n",
            Some(1),
        )
    );
    assert!(!sandbox.socket().exists(), "no daemon was started");
}

/// One hosted run's stream with its per-run identity masked (the session
/// id wherever it appears, wall-clock stamps, the usage estimate), so two
/// runs compare whole.
fn normalized_run(lines: Vec<Value>) -> Vec<Value> {
    fn walk(value: &mut Value, session_id: &str) {
        match value {
            Value::Object(map) => {
                for (key, child) in map.iter_mut() {
                    match key.as_str() {
                        "timestamp" => *child = json!("<timestamp>"),
                        // The faux usage estimate sizes the run's own
                        // system prompt, which carries per-run identity.
                        "usage" => *child = json!("<usage>"),
                        _ => walk(child, session_id),
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, session_id);
                }
            }
            Value::String(text) => {
                if text.contains(session_id) {
                    *text = text.replace(session_id, "<session-id>");
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }
    let session_id = lines[0]["id"].as_str().expect("the header id").to_string();
    lines
        .into_iter()
        .map(|mut line| {
            walk(&mut line, &session_id);
            line
        })
        .collect()
}

/// The two json profiles over hosted sessions: the reduced stream is the
/// full stream minus exactly the progressive `message_update` and
/// `tool_execution_update` events, and only its header carries the marker.
#[test]
fn hosted_profiles_differ_by_exactly_the_progressive_snapshots() {
    let sandbox = Sandbox::new(&json!({
        "engine": "faux",
        "responses": ["a hosted answer streamed in several deltas"],
    }));
    let run = |profile: &str| {
        let (stdout, stderr, code) = sandbox.run(&[
            "--mode",
            "json",
            "--json-event-profile",
            profile,
            "--daemon-hosted",
            "-p",
            "hi",
        ]);
        assert_eq!(code, 0, "stderr: {stderr}");
        normalized_run(json_lines(&stdout))
    };
    let all = run("all");
    let reduced = run("factory-completed");
    assert!(
        types(&all).contains(&"message_update"),
        "the full stream carries the progressive snapshots: {:?}",
        types(&all)
    );
    let mut expected_header = all[0].clone();
    expected_header["jsonEventProfile"] = json!("factory-completed");
    assert_eq!(reduced[0], expected_header);
    assert_eq!(all[0].get("jsonEventProfile"), None);
    let expected: Vec<Value> = all[1..]
        .iter()
        .filter(|line| {
            !matches!(
                line["type"].as_str(),
                Some("message_update" | "tool_execution_update")
            )
        })
        .cloned()
        .collect();
    assert_eq!(reduced[1..].to_vec(), expected);
}

/// `-c` resolves on the client against the exact cwd and `--session-dir`:
/// with a newer session for another cwd in the same dir, it continues this
/// cwd's session, and every session lands in that dir.
#[test]
fn continue_picks_this_cwds_session_in_the_session_dir() {
    let sandbox = Sandbox::new(&json!({ "engine": "faux", "responses": ["ONE", "TWO"] }));
    let sessions = sandbox.home().join("seat-sessions");
    let project = |name: &str| {
        let dir = sandbox.home().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir.display().to_string()
    };
    let (project_a, project_b) = (project("project-a"), project("project-b"));
    let run = |cwd: &str, extra: &[&str], prompt: &str| {
        let mut args = vec![
            "--daemon-hosted",
            "--cwd",
            cwd,
            "--session-dir",
            sessions.to_str().unwrap(),
        ];
        args.extend_from_slice(extra);
        args.extend(["-p", prompt]);
        let (_, stderr, code) = sandbox.run(&args);
        assert_eq!(code, 0, "stderr: {stderr}");
    };
    run(&project_a, &[], "a one");
    run(&project_b, &[], "b one");
    run(&project_a, &["-c"], "a two");
    // The session files (the dir also holds daemon bookkeeping, such as
    // the RLM spawn ledger): each with its header cwd and user rows.
    let mut saved: Vec<(String, Vec<String>)> = std::fs::read_dir(&sessions)
        .unwrap()
        .filter_map(|entry| {
            let file = entry.unwrap().path().display().to_string();
            let first_line = std::fs::read_to_string(&file)
                .ok()?
                .lines()
                .next()
                .map(str::to_string)?;
            let header: Value = serde_json::from_str(&first_line).ok()?;
            (header["type"] == "session").then(|| {
                (
                    header["cwd"].as_str().unwrap().to_string(),
                    user_texts(&file),
                )
            })
        })
        .collect();
    saved.sort();
    assert_eq!(
        saved,
        [
            (project_a, vec!["a one".to_string(), "a two".to_string()]),
            (project_b, vec!["b one".to_string()]),
        ]
    );
}

/// A path-like `--resume` selector relative to this process's directory
/// reaches the saved file when the session's stored cwd is elsewhere: the
/// daemon receives the absolute path (a relative one would resolve against
/// the worker's cwd and miss the file).
#[test]
fn a_relative_resume_path_reaches_the_saved_session() {
    let sandbox = Sandbox::new(&json!({ "engine": "faux", "responses": ["HOSTED"] }));
    let project = sandbox.home().join("project");
    std::fs::create_dir_all(&project).unwrap();
    // An in-process run saves the session; no daemon worker hosts it.
    let output = sandbox
        .command(&["--cwd", project.to_str().unwrap(), "-p", "one"])
        .env(
            "PRIME_AGENT_FAUX_SCRIPT",
            json!({ "responses": ["SAVED"] }).to_string(),
        )
        .output()
        .expect("binary present");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "SAVED\n",
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let saved: Vec<PathBuf> = std::fs::read_dir(sandbox.home().join(".prime/agent/sessions"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(saved.len(), 1, "{saved:?}");
    let relative = saved[0].strip_prefix(sandbox.home()).unwrap();
    let (stdout, stderr, code) = sandbox.run(&[
        "--daemon-hosted",
        "--resume",
        relative.to_str().unwrap(),
        "-p",
        "two",
    ]);
    assert_eq!((stdout.as_str(), code), ("HOSTED\n", 0), "stderr: {stderr}");
    assert_eq!(user_texts(saved[0].to_str().unwrap()), ["one", "two"]);
}
