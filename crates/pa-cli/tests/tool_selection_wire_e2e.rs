//! `--no-tools` on the wire: the real binary in an isolated HOME sends its
//! first request through the real `OpenAI` Responses serializer (the `sol`
//! wrapper's route) to a loopback mock that records every body. The
//! standalone print run and the daemon-hosted run both send no tool
//! definitions and the TS no-tools prompt; the hosted selection rides the
//! durable create a respawned worker replays, and a live session launched
//! with other tools is never reused. No network, no Python.
//!
//! Linux-only (`AF_UNIX` sockets, pidfd), like the hosted verifiers.
#![cfg(target_os = "linux")]
// The narrowing casts sit at OS boundaries (pids, poll timeouts).
#![allow(clippy::cast_possible_wrap, clippy::cast_possible_truncation)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// Failure bound for one awaited daemon step.
const STEP_BOUND: Duration = Duration::from_mins(2);

/// Inherited variable families the sandbox never passes on.
const SCRUBBED_ENV_PREFIXES: [&str; 4] = ["PRIME_AGENT_", "PI_", "PA_DAEMON_", "W7_CARGO_"];

/// The mock's one answer.
const REPLY: &str = "probe ok";

/// A loopback `OpenAI` Responses endpoint: records every request body and
/// answers one streamed reply.
struct ResponsesMock {
    bodies: Arc<Mutex<Vec<Value>>>,
    port: u16,
}

impl ResponsesMock {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&bodies);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let recorded = Arc::clone(&recorded);
                std::thread::spawn(move || {
                    let _ = serve(stream, &recorded);
                });
            }
        });
        Self { bodies, port }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn bodies(&self) -> Vec<Value> {
        self.bodies.lock().unwrap().clone()
    }
}

fn serve(mut stream: TcpStream, bodies: &Arc<Mutex<Vec<Value>>>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut content_length = 0usize;
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    if !request_line.contains("/responses") {
        return stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
    }
    bodies
        .lock()
        .unwrap()
        .push(serde_json::from_slice(&body).unwrap_or(Value::Null));
    let payload = responses_stream();
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        )
        .as_bytes(),
    )
}

/// The SSE body of one streamed Responses reply (created .. completed).
fn responses_stream() -> String {
    let item = json!({
        "id": "msg_mock", "type": "message", "status": "completed", "role": "assistant",
        "content": [{ "type": "output_text", "text": REPLY, "annotations": [] }],
    });
    let base =
        json!({ "id": "resp_mock", "object": "response", "created_at": 0, "model": "mock-1" });
    let with = |extra: Value| {
        let mut response = base.clone();
        for (key, value) in extra.as_object().unwrap() {
            response[key] = value.clone();
        }
        response
    };
    let events = [
        (
            "response.created",
            json!({ "response": with(json!({ "status": "in_progress", "output": [] })) }),
        ),
        (
            "response.output_item.added",
            json!({
                "output_index": 0,
                "item": { "id": "msg_mock", "type": "message", "status": "in_progress", "role": "assistant", "content": [] },
            }),
        ),
        (
            "response.content_part.added",
            json!({
                "item_id": "msg_mock", "output_index": 0, "content_index": 0,
                "part": { "type": "output_text", "text": "", "annotations": [] },
            }),
        ),
        (
            "response.output_text.delta",
            json!({
                "item_id": "msg_mock", "output_index": 0, "content_index": 0, "delta": REPLY,
            }),
        ),
        (
            "response.output_text.done",
            json!({
                "item_id": "msg_mock", "output_index": 0, "content_index": 0, "text": REPLY,
            }),
        ),
        (
            "response.output_item.done",
            json!({ "output_index": 0, "item": item }),
        ),
        (
            "response.completed",
            json!({ "response": with(json!({
            "status": "completed",
            "output": [item],
            "usage": {
                "input_tokens": 10, "input_tokens_details": { "cached_tokens": 0 },
                "output_tokens": 2, "output_tokens_details": { "reasoning_tokens": 0 },
                "total_tokens": 12,
            },
        })) }),
        ),
    ];
    let mut payload = String::new();
    for (sequence, (name, mut event)) in events.into_iter().enumerate() {
        event["type"] = json!(name);
        event["sequence_number"] = json!(sequence);
        // Writing into a String cannot fail.
        let _ = write!(payload, "event: {name}\ndata: {event}\n\n");
    }
    payload
}

/// One test's sandbox: HOME with the mock provider in `models.json`, its
/// own daemon socket and worker socket dir. Dropping it shuts down any
/// daemon a hosted run started.
struct Sandbox {
    dir: tempfile::TempDir,
    mock: ResponsesMock,
}

impl Sandbox {
    fn new() -> Self {
        let dir = tempfile::TempDir::new().unwrap();
        let mock = ResponsesMock::start();
        let agent_dir = dir.path().join("home/.prime/agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::create_dir_all(dir.path().join("home/w")).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            json!({ "providers": { "mock": {
                "baseUrl": mock.url(),
                "api": "openai-responses",
                "apiKey": "mock",
                "models": [{
                    "id": "mock-1", "name": "Mock 1", "reasoning": false, "input": ["text"],
                    "contextWindow": 200_000, "maxTokens": 8192,
                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                }],
            } } })
            .to_string(),
        )
        .unwrap();
        Self { dir, mock }
    }

    fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    fn socket(&self) -> PathBuf {
        self.dir.path().join("d.sock")
    }

    /// The binary under test with nothing ambient leaking in.
    fn run(&self, args: &[&str]) -> (String, String, i32) {
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
        for var in [
            "RLM_DEPTH",
            pa_daemon::worker::WORKER_ROLE_ENV,
            pa_daemon::worker::WORKER_SCRIPT_ENV,
        ] {
            command.env_remove(var);
        }
        let output = command
            .arg("--daemon-socket")
            .arg(self.socket())
            .args(["--provider", "mock", "--model", "mock-1"])
            .args(args)
            .current_dir(self.home().join("w"))
            .env("HOME", self.home())
            .env("TMPDIR", self.dir.path())
            .env("PRIME_AGENT_SOCKET_DIR", self.dir.path().join("s"))
            .env("PI_OFFLINE", "1")
            .env(
                pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
                "15000",
            )
            .env("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", "90000")
            .stdin(Stdio::null())
            .output()
            .expect("binary present");
        (
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
            output.status.code().unwrap_or(-1),
        )
    }

    /// The worker descriptors' durable create commands (what a respawned
    /// worker replays).
    fn durable_creates(&self) -> Vec<Value> {
        let root = self.home().join(".prime/agent/daemon-workers");
        let mut creates = Vec::new();
        for key in std::fs::read_dir(root).unwrap().flatten() {
            for entry in std::fs::read_dir(key.path()).unwrap().flatten() {
                let path = entry.path();
                if !path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
                {
                    continue;
                }
                let descriptor: Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                if let Some(create) = descriptor.get("createCommand") {
                    creates.push(create.clone());
                }
            }
        }
        creates
    }
}

impl Drop for Sandbox {
    /// A daemon a hosted run started dies with its test: a forced
    /// `shutdown` over its own socket, then the supervisor's exit observed
    /// through a pidfd. No daemon is fine.
    fn drop(&mut self) {
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
        for line in reader.lines() {
            if line.is_err() {
                break;
            }
        }
        if let Some(pidfd) = supervisor {
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

/// The TS no-tools prompt (`rlm.js` with `ipython` inactive) for a root
/// session; its bytes are pinned against the TS capture by pa-core's
/// golden corpus.
fn ts_no_tools_prompt(cwd: &str, log: &str) -> String {
    let golden = include_str!("../../pa-core/tests/golden/corpus/no-tools-prompt-ts.txt");
    golden
        .replace(
            "Working directory: /tmp/pb.ysn9o0q3/w",
            &format!("Working directory: {cwd}"),
        )
        .replace(
            "Conversation log: not persisted",
            &format!("Conversation log: {log}"),
        )
}

/// The system message and the tool definitions of one Responses body.
fn system_and_tools(body: &Value) -> (String, Option<Value>) {
    let system = body["input"]
        .as_array()
        .and_then(|input| input.iter().find(|item| item["role"] == "system"))
        .and_then(|item| item["content"].as_str())
        .unwrap_or_default()
        .to_string();
    (system, body.get("tools").cloned())
}

/// The value of the `<label>: ` line of a prompt.
fn prompt_line<'a>(prompt: &'a str, label: &str) -> &'a str {
    prompt
        .lines()
        .find_map(|line| line.strip_prefix(&format!("{label}: ")))
        .unwrap_or_else(|| panic!("no {label} line in {prompt}"))
}

/// Standalone print: every no-tools flag form sends no tool definitions
/// and exactly the TS no-tools prompt (TS size for the same cwd).
#[test]
fn standalone_no_tools_forms_send_the_ts_prompt_and_no_tools() {
    for flags in [
        &["--no-tools"][..],
        &["-nt"],
        &["--no-builtin-tools"],
        &["--tools", ""],
        &["--tools", "read-me-not"],
    ] {
        let sandbox = Sandbox::new();
        let mut args = vec![
            "-p",
            "--no-session",
            "--no-skills",
            "--no-context-files",
            "--no-prompt-templates",
        ];
        args.extend_from_slice(flags);
        args.extend(["--", "Reply with exactly the words: probe ok."]);
        let (stdout, stderr, code) = sandbox.run(&args);
        assert_eq!(
            (stdout.as_str(), code),
            ("probe ok\n", 0),
            "{flags:?}: {stderr}"
        );
        let bodies = sandbox.mock.bodies();
        assert_eq!(bodies.len(), 1, "{flags:?}: one request");
        let (system, tools) = system_and_tools(&bodies[0]);
        let cwd = prompt_line(&system, "Working directory");
        assert!(cwd.ends_with("/w"), "{cwd}");
        let expected = ts_no_tools_prompt(cwd, "not persisted");
        assert_eq!((system.len(), tools), (expected.len(), None), "{flags:?}");
        assert_eq!(system, expected, "{flags:?}");
    }
}

/// Daemon-hosted print: the worker sends no tools and the TS no-tools
/// prompt, the durable create carries the selection a respawned worker
/// replays, a run with other tool flags never reuses the live session, and
/// one with the same flags does.
#[test]
fn hosted_no_tools_reaches_the_worker_and_guards_reuse() {
    let sandbox = Sandbox::new();
    let (stdout, stderr, code) = sandbox.run(&["--daemon-hosted", "--no-tools", "-p", "one"]);
    assert_eq!((stdout.as_str(), code), ("probe ok\n", 0), "{stderr}");
    let bodies = sandbox.mock.bodies();
    assert_eq!(bodies.len(), 1);
    let (system, tools) = system_and_tools(&bodies[0]);
    assert_eq!(tools, None);
    let cwd = prompt_line(&system, "Working directory");
    let log = prompt_line(&system, "Conversation log");
    assert!(
        std::path::Path::new(log)
            .extension()
            .is_some_and(|ext| ext == "jsonl"),
        "{log}"
    );
    assert!(
        system.starts_with(&ts_no_tools_prompt(cwd, log)),
        "the TS no-tools prompt (hosted runs still discover skills): {system}"
    );
    assert!(!system.contains("# prime-agent harness"));
    let creates = sandbox.durable_creates();
    assert_eq!(creates.len(), 1, "{creates:?}");
    assert_eq!(creates[0]["noTools"], json!(true), "{}", creates[0]);

    let (stdout, stderr, code) = sandbox.run(&["--daemon-hosted", "-c", "-p", "two"]);
    assert_eq!((stdout.as_str(), code), ("", 1));
    assert!(
        stderr.contains("the session is already running in the daemon with --no-tools, and this run asks for no tool flags"),
        "{stderr}"
    );
    assert_eq!(
        sandbox.mock.bodies().len(),
        1,
        "the refused run sent nothing"
    );

    let (stdout, stderr, code) = sandbox.run(&["--daemon-hosted", "-c", "-nt", "-p", "three"]);
    assert_eq!((stdout.as_str(), code), ("probe ok\n", 0), "{stderr}");
    let bodies = sandbox.mock.bodies();
    assert_eq!(bodies.len(), 2);
    assert_eq!(system_and_tools(&bodies[1]), (system, None));
}
