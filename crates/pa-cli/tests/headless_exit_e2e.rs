//! The headless exit follows the answer, on the real binary and the real
//! provider path (an isolated HOME, a loopback OpenAI-compatible mock the
//! test answers, fake `uv`/python programs gated on FIFOs the test holds,
//! no network):
//!
//! - a print run whose kernel probe child is still blocked exits once its
//!   answer is written, and the blocked child dies with it (the runtime's
//!   shutdown no longer waits for kernel setup work);
//! - a fresh home's kernel environment setup finishes before the first
//!   provider call, never after the answer.
//!
//! Ordering is observed, never timed: the mock answers only once the fake
//! program announced itself, and reads what the fakes did at the moment the
//! request arrives; the test opens a gate only on a line the binary
//! printed. Each wait has a generous failure bound so a regression fails
//! instead of hanging.
#![cfg(unix)]

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// Inherited variable families the sandbox never passes on.
const SCRUBBED_ENV_PREFIXES: [&str; 4] = ["PRIME_AGENT_", "PI_", "PA_DAEMON_", "W7_CARGO_"];
/// Failure bound for one observed step (never a readiness wait).
const STEP_BOUND: Duration = Duration::from_secs(120);
const MOCK_REPLY: &str = "mock answer";

/// What the mock does when a completion request arrives, before it
/// answers.
type OnRequest = Box<dyn FnMut() + Send>;

/// A loopback OpenAI-compatible chat-completions endpoint: every POST runs
/// the hook, then streams [`MOCK_REPLY`] and closes.
struct MockProvider {
    port: u16,
}

impl MockProvider {
    fn start(mut on_request: OnRequest) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the mock");
        let port = listener.local_addr().expect("mock address").port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                if read_request(&stream).is_some_and(|line| line.starts_with("POST ")) {
                    on_request();
                    answer(stream);
                }
            }
        });
        Self { port }
    }
}

/// Read one HTTP request (headers, then a Content-Length or chunked body);
/// returns its request line.
fn read_request(stream: &TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let mut length = 0usize;
    let mut chunked = false;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let lower = header.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            length = value.trim().parse().ok()?;
        }
        if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
            chunked = true;
        }
    }
    if chunked {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).ok()?;
            let size = usize::from_str_radix(size.trim().split(';').next()?, 16).ok()?;
            let mut chunk = vec![0; size + 2];
            reader.read_exact(&mut chunk).ok()?;
            if size == 0 {
                break;
            }
        }
    } else {
        let mut body = vec![0; length];
        reader.read_exact(&mut body).ok()?;
    }
    Some(request_line)
}

/// Stream the fixed reply as chat-completion chunks, then close.
fn answer(mut stream: TcpStream) {
    let chunk = |delta: &Value, finish: &Value| {
        json!({ "id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": 0,
                "model": "mock-1",
                "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] })
    };
    let frames = [
        chunk(&json!({ "role": "assistant", "content": "" }), &Value::Null),
        chunk(&json!({ "content": MOCK_REPLY }), &Value::Null),
        chunk(&json!({}), &json!("stop")),
        json!({ "id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": 0,
                "model": "mock-1", "choices": [],
                "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 } }),
    ];
    let body: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .chain(std::iter::once("data: [DONE]\n\n".to_string()))
        .collect();
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n{body}"
        )
        .as_bytes(),
    );
}

struct Sandbox {
    root: tempfile::TempDir,
}

impl Sandbox {
    fn new(mock: &MockProvider) -> Self {
        let root = tempfile::tempdir().expect("sandbox root");
        for dir in ["home/.prime/agent", "work", "bin"] {
            std::fs::create_dir_all(root.path().join(dir)).expect("sandbox dir");
        }
        let agent_dir = root.path().join("home/.prime/agent");
        let models = json!({ "providers": { "mock": {
            "baseUrl": format!("http://127.0.0.1:{}/v1", mock.port),
            "api": "openai-completions",
            "apiKey": "mock",
            "models": [{ "id": "mock-1", "name": "Mock 1", "reasoning": false,
                "input": ["text"], "contextWindow": 200_000, "maxTokens": 8192,
                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }],
        } } });
        std::fs::write(agent_dir.join("models.json"), models.to_string()).expect("models.json");
        let settings = json!({ "onboardingShown": true, "telemetry": { "enabled": false, "noticeShown": true } });
        std::fs::write(agent_dir.join("settings.json"), settings.to_string())
            .expect("settings.json");
        Self { root }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    fn fifo(&self, name: &str) -> PathBuf {
        let path = self.path(name);
        let status = Command::new("mkfifo")
            .arg(&path)
            .status()
            .expect("run mkfifo");
        assert!(status.success(), "mkfifo {}", path.display());
        path
    }

    fn executable(&self, name: &str, script: &str) -> PathBuf {
        let path = self.path(name);
        std::fs::write(&path, script).expect("write fake program");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("make fake program executable");
        path
    }

    /// The binary in json print mode against the mock (plus `flags`), with
    /// the product env scrubbed, the sandbox HOME and telemetry off.
    fn command(&self, flags: &[&str]) -> Command {
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
            .args([
                "-p",
                "--mode",
                "json",
                "--no-session",
                "--provider",
                "mock",
                "--model",
                "mock-1",
            ])
            .args(flags)
            .args(["--", "say hi"])
            .env("HOME", self.path("home"))
            .env("TMPDIR", self.path("home"))
            .env("PRIME_AGENT_TELEMETRY", "0")
            .env("PI_SKIP_VERSION_CHECK", "1")
            .env_remove("RLM_DEPTH")
            .current_dir(self.path("work"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}

/// Read every line of `stream` on a thread, forwarding each one.
fn forward_lines(stream: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

/// Every JSON line the run wrote, read to the stream's end.
fn json_events(lines: &mpsc::Receiver<String>) -> Vec<Value> {
    let mut events = Vec::new();
    loop {
        match lines.recv_timeout(STEP_BOUND) {
            Ok(line) => {
                events.push(serde_json::from_str(&line).expect("one JSON object per line"));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return events,
            Err(mpsc::RecvTimeoutError::Timeout) => panic!("stdout never reached its end"),
        }
    }
}

/// The run's final answer text (the last assistant `message_end`).
fn answer_text(events: &[Value]) -> Option<String> {
    events
        .iter()
        .rev()
        .find(|event| event["type"] == "message_end" && event["message"]["role"] == "assistant")
        .map(|event| {
            event["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| part["text"].as_str())
                .collect()
        })
}

/// Open the FIFO at `gate` for writing and send one line: unblocks the
/// fake program reading it (the open waits for that reader).
fn release(gate: &Path) {
    let _ = File::options()
        .write(true)
        .open(gate)
        .and_then(|mut gate| gate.write_all(b"go\n"));
}

/// A print run whose kernel readiness probe never returns (the probe child
/// blocks on a gate the test never opens) still exits right after its
/// answer, and the probe child is killed with it. The mock answers only
/// after the probe child announced itself, so the probe is provably
/// running while the answer is written.
#[test]
fn print_exits_while_the_kernel_probe_child_is_blocked() {
    let (pid_tx, pid_rx) = mpsc::channel::<String>();
    let probe_pid: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let mock = MockProvider::start(Box::new({
        let probe_pid = Arc::clone(&probe_pid);
        move || {
            let pid = pid_rx
                .recv_timeout(STEP_BOUND)
                .expect("the probe child announces itself");
            *probe_pid.lock().unwrap() = Some(pid);
        }
    }));
    let sandbox = Sandbox::new(&mock);
    let alive = sandbox.fifo("alive");
    let gate = sandbox.fifo("gate");
    // The caller-owned kernel interpreter: its first probe announces
    // itself and then blocks forever.
    let python = sandbox.executable(
        "python",
        &format!(
            "#!/bin/sh\nexec 3>'{}'\necho $$ >&3\nread _ < '{}'\n",
            alive.display(),
            gate.display()
        ),
    );
    let mut child = sandbox
        .command(&[])
        .env("PRIME_AGENT_KERNEL_PYTHON", &python)
        .spawn()
        .expect("spawn the binary");
    // The probe child's lifetime: its pid, then EOF once it is gone.
    let (gone_tx, gone_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(File::open(alive).expect("open the alive pipe"));
        let mut pid = String::new();
        reader.read_line(&mut pid).expect("read the probe pid");
        let _ = pid_tx.send(pid.trim().to_string());
        let mut rest = String::new();
        let _ = reader.read_to_string(&mut rest);
        let _ = gone_tx.send(());
    });
    let stdout = forward_lines(child.stdout.take().expect("stdout"));
    let stderr = forward_lines(child.stderr.take().expect("stderr"));
    let (exit_tx, exit_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = exit_tx.send(child.wait());
        child
    });
    let Ok(status) = exit_rx.recv_timeout(STEP_BOUND) else {
        // Release the probe so the lingering binary can finish, then fail.
        release(&gate);
        panic!(
            "the binary did not exit after its answer; stderr: {:?}",
            stderr.try_iter().collect::<Vec<_>>()
        );
    };
    let status = status.expect("wait for the binary");
    let events = json_events(&stdout);
    let stderr: Vec<String> = stderr.try_iter().collect();
    assert!(status.success(), "stderr: {stderr:?}");
    assert!(
        probe_pid.lock().unwrap().is_some(),
        "the answer waited for the running probe"
    );
    assert_eq!(answer_text(&events).as_deref(), Some(MOCK_REPLY));
    // The gate was never opened: only a kill ends the probe child.
    assert_eq!(
        gone_rx.recv_timeout(STEP_BOUND),
        Ok(()),
        "the blocked probe child died with the run"
    );
}

/// On a fresh home the kernel environment (`uv python install`, `uv venv`,
/// the runtime install) is set up before the first provider call. The
/// runtime install blocks on a gate the test opens only once the binary
/// reports its foreground preparation (`--verbose`); the mock reads the uv
/// log when the request arrives. Setup left to the background would still
/// be blocked then, and the mock releases it so such a run still ends.
#[test]
fn fresh_home_kernel_setup_finishes_before_the_first_provider_call() {
    let seen_at_request: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
    let paths: Arc<Mutex<Option<(PathBuf, PathBuf)>>> = Arc::new(Mutex::new(None));
    let mock = MockProvider::start(Box::new({
        let seen_at_request = Arc::clone(&seen_at_request);
        let paths = Arc::clone(&paths);
        move || {
            let (log, gate) = paths.lock().unwrap().clone().expect("sandbox paths");
            let finished = std::fs::read_to_string(&log)
                .unwrap_or_default()
                .lines()
                .any(|line| line.starts_with("end pip install"));
            seen_at_request.lock().unwrap().push(finished);
            if !finished {
                release(&gate);
            }
        }
    }));
    let sandbox = Sandbox::new(&mock);
    let gate = sandbox.fifo("gate");
    let log = sandbox.path("uv.log");
    *paths.lock().unwrap() = Some((log.clone(), gate.clone()));
    let python = sandbox.executable("python-ok", "#!/bin/sh\nexit 0\n");
    sandbox.executable(
        "bin/uv",
        &format!(
            "#!/bin/sh\necho \"begin $*\" >> '{log}'\ncase \"$1\" in\nvenv) mkdir -p \"$2/bin\" && cp '{python}' \"$2/bin/python\" ;;\npip) case \"$*\" in *--editable*) ;; *) read _ < '{gate}' ;; esac ;;\nesac\necho \"end $*\" >> '{log}'\nexit 0\n",
            log = log.display(),
            python = python.display(),
            gate = gate.display()
        ),
    );
    let path = format!(
        "{}:{}",
        sandbox.path("bin").display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut child = sandbox
        .command(&["--verbose"])
        .env("PATH", path)
        .env("PRIME_AGENT_KERNEL_VENV", sandbox.path("venv"))
        .spawn()
        .expect("spawn the binary");
    let stdout = forward_lines(child.stdout.take().expect("stdout"));
    let stderr_stream = child.stderr.take().expect("stderr");
    // Open the gate once the binary reports its foreground preparation.
    let (stderr_tx, stderr_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut released = false;
        for line in BufReader::new(stderr_stream).lines() {
            let Ok(line) = line else { break };
            if !released && line.contains("kernel environment preparation start") {
                released = true;
                release(&gate);
            }
            let _ = stderr_tx.send(line);
        }
    });
    let (exit_tx, exit_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = exit_tx.send(child.wait());
        child
    });
    let Ok(status) = exit_rx.recv_timeout(STEP_BOUND) else {
        panic!(
            "the run did not end; stderr: {:?}; uv log: {:?}",
            stderr_rx.try_iter().collect::<Vec<_>>(),
            std::fs::read_to_string(&log)
        );
    };
    let status = status.expect("wait for the binary");
    let events = json_events(&stdout);
    let stderr: Vec<String> = stderr_rx.try_iter().collect();
    assert!(status.success(), "stderr: {stderr:?}");
    assert_eq!(answer_text(&events).as_deref(), Some(MOCK_REPLY));
    assert_eq!(
        *seen_at_request.lock().unwrap(),
        [true],
        "the runtime install had finished when the provider was called; stderr: {stderr:?}"
    );
    let steps: Vec<String> = std::fs::read_to_string(&log)
        .expect("the uv log")
        .lines()
        .filter_map(|line| line.strip_prefix("end "))
        .map(|line| line.split(' ').take(2).collect::<Vec<_>>().join(" "))
        .collect();
    assert_eq!(
        steps.get(..3),
        Some(
            &[
                "python install".to_string(),
                format!("venv {}", sandbox.path("venv").display()),
                "pip install".to_string(),
            ][..]
        ),
        "the fresh setup's steps, in order"
    );
}
