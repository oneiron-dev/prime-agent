//! The interactive open against the real product daemon when the session's
//! worker dies during startup (the macOS regression: a worker socket path
//! past `sun_path` killed every interactive worker at bind while the TUI
//! waited without a word). The CLI's own daemon launch path
//! (`ensure_daemon_running_with` → `prime-agent --mode daemon`) spawns the
//! supervisor, the supervisor spawns the real `prime-agent worker`, and the
//! worker dies preparing its endpoint: the socket dir sits under a regular
//! file (ENOTDIR on every platform; Linux re-anchors an over-long path, so
//! the length itself is not a portable fixture). The headless TUI open must
//! end with the worker's own error — exit status, its `Error:` line, its
//! log — for the CLI to print and exit 1 on, well inside the ten-minute
//! launch budget the daemon runs with here.
#![cfg(unix)]
// The Tier-C/D ruling (fleet-uniform, 2026-09-28), as in the suite's other
// interactive e2es: the interactive run's future is stack-resident by
// design, and the test is one linear scenario (the options literal alone
// is 35 lines); the pid narrows at the kill(2) boundary.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation
)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Shuts the spawned supervisor down on scope exit (a failing test's
/// unwind included); the shutdown response is the sync point. A supervisor
/// that does not answer it is killed by the pid its own hello reported
/// (the one process this test started, through the CLI's launch path).
struct SpawnedDaemon {
    socket: PathBuf,
}

impl Drop for SpawnedDaemon {
    fn drop(&mut self) {
        let Ok(stream) = UnixStream::connect(&self.socket) else {
            return;
        };
        let Ok(mut writer) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        let mut hello = String::new();
        let _ = reader.read_line(&mut hello);
        let supervisor_pid = serde_json::from_str::<serde_json::Value>(hello.trim())
            .ok()
            .and_then(|hello| hello["supervisorPid"].as_i64());
        let command = serde_json::json!({
            "type": "command",
            "id": "test-shutdown",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": { "type": "shutdown" },
        });
        let _ = writeln!(writer, "{command}");
        let _ = reader
            .get_ref()
            .set_read_timeout(Some(Duration::from_secs(5)));
        let mut response = String::new();
        let answered = reader.read_line(&mut response).is_ok_and(|read| read > 0);
        if let (false, Some(pid)) = (answered, supervisor_pid) {
            // SAFETY: kill(2) on the supervisor this test started.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}

/// The run's wall: a hung open fails the test instead of the binary. The
/// open itself answers within moments of the worker's exit.
const OPEN_BOUND: Duration = Duration::from_secs(120);

#[tokio::test]
async fn a_worker_dying_at_startup_ends_the_interactive_open_with_its_error() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    // This binary's only test owns the process env the spawned supervisor
    // (and its workers) inherit: no product or harness variable from the
    // host survives (an inherited restart roster, session dir, daemon
    // socket or internal switch would point the daemon at another
    // install's state), and HOME and TMPDIR are fresh dirs of this sandbox.
    let scrubbed: Vec<std::ffi::OsString> = std::env::vars_os()
        .map(|(name, _)| name)
        .filter(|name| {
            let name = name.to_string_lossy();
            ["PRIME_AGENT_", "PI_", "RLM_", "PA_"]
                .iter()
                .any(|prefix| name.starts_with(prefix))
        })
        .collect();
    for name in scrubbed {
        std::env::remove_var(name);
    }
    for (name, sub_dir) in [("HOME", "home"), ("TMPDIR", "tmp")] {
        let path = dir.path().join(sub_dir);
        std::fs::create_dir_all(&path).expect("sandbox dir");
        std::env::set_var(name, path);
    }
    std::env::set_var("PRIME_AGENT_DISABLE_SELF_UPDATE", "1");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let blocked = dir.path().join("not-a-directory");
    std::fs::write(&blocked, "worker sockets would live under here\n").expect("blocker file");
    let socket = dir.path().join("daemon.sock");
    // The spawned supervisor (and the workers it spawns) inherit this
    // process's env: its own agent dir, worker sockets under the blocker
    // file, no network, a launch budget no answer could come from, and the
    // short supervisor-lost exit so a killed supervisor leaks no worker.
    std::env::set_var("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir);
    std::env::set_var("PRIME_AGENT_SOCKET_DIR", blocked.join("sockets"));
    std::env::set_var("PI_OFFLINE", "1");
    std::env::set_var("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", "600000");
    std::env::set_var(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    pa_cli::ensure_daemon_running_with(
        Path::new(env!("CARGO_BIN_EXE_prime-agent")),
        &socket,
        dir.path(),
    )
    .await
    .expect("the daemon starts");
    let _daemon = SpawnedDaemon {
        socket: socket.clone(),
    };

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [{ "text": "never reached" }] }).to_string(),
    )
    .expect("write script");
    let options = pa_tui::interactive::InteractiveOptions {
        models: None,
        socket_path: socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir),
        script_path: Some(script_path),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
        show_images: true,
        fullscreen_mouse: false,
        initial_message: Some("never sent".to_string()),
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        tree_filter_mode: String::new(),
        branch_summary_skip_prompt: false,
        version: "0.0.0".to_string(),
        onboarding: None,
        telemetry_disabled: Some(true),
        client_auth: None,
        traces: None,
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![pa_tui::interactive::HeadlessStep::WaitMs(100)],
        width: 100,
        height: 30,
    };
    let outcome = tokio::time::timeout(
        OPEN_BOUND,
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan)),
    )
    .await
    .expect("the open answers inside the wall");
    let error = outcome.expect_err("a dead worker ends the run, no agents-view handoff");

    // The worker's own evidence: one launch, one log holding its exit line.
    let logs: Vec<String> = std::fs::read_dir(agent_dir.join("logs"))
        .expect("logs dir")
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with("worker-") && name.ends_with(".stderr.log"))
        .collect();
    assert_eq!(logs.len(), 1, "one launch, one captured log: {logs:?}");
    let log_path = agent_dir.join("logs").join(&logs[0]);
    let worker_id = logs[0]
        .strip_prefix("worker-")
        .and_then(|name| name.strip_suffix(".stderr.log"))
        .expect("worker id in the log name");
    let log = std::fs::read_to_string(&log_path).expect("read the worker log");
    let error_line = log.trim_end();
    assert!(
        error_line.starts_with("Error: ") && !error_line.contains('\n'),
        "the product worker exits on one `Error:` line: {log:?}"
    );
    assert!(pa_tui::daemon_client::is_worker_startup_failure(&error));
    assert_eq!(
        format!("{error:#}"),
        format!(
            "the daemon rejected the create request: session worker {worker_id} exited during startup (exit status: 1): {error_line}\nworker log: {}",
            log_path.display()
        )
    );
}
