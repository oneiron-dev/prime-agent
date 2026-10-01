//! The `--daemon-hosted` print/json run (TS `runPrintModeWithConnection`
//! over a resident `DaemonAgentConnection`): the daemon owns the session —
//! listed, and attachable from another terminal while this process streams
//! it — and this client composes the TS print-mode flow over the pa-daemon
//! hosted session: the header, the event stream (projected by
//! `--json-event-profile`), the prompts, the headless completion, the
//! text-mode result and the autonomous exit contract, then detach and close
//! (never a kill). SIGINT/SIGTERM/SIGHUP detach and exit 130/143/129.
//!
//! Session selection stays client-side: `-c` resolves the newest saved
//! session for this cwd and session dir, `--resume` resolves its selector,
//! and the daemon is asked for that file by path (the supervisor refuses
//! `continueRecent`).

use std::sync::Arc;

use pa_daemon::headless_client::{
    HostedEventSink, HostedHeadlessSession, HostedPrompt, HostedSessionOptions,
};

use crate::headless_autonomous::autonomous_exit_stderr;
use crate::json_output::JsonEventSink;
use crate::mode::{AppMode, RunOptions};

/// Verification seam: a scripted daemon worker for the hosted run — the
/// path of a script file in the `{"engine": "faux", "responses": [...]}`
/// form the daemon e2e harnesses use. The product never sets it.
const HOSTED_DAEMON_SCRIPT_ENV: &str = "PRIME_AGENT_HOSTED_DAEMON_SCRIPT";

/// The per-launch overlay a factory seat sets for the agent's own tool
/// processes (its cargo routing: `W7_CARGO_WORK`, `W7_CARGO_HOSTS`, ...).
/// A daemon worker runs with the daemon's environment, and the create
/// contract carries no launch environment yet, so a hosted run refuses it
/// instead of silently routing the seat's builds elsewhere.
const LAUNCH_OVERLAY_ENV_PREFIX: &str = "W7_CARGO_";

/// Run a print/json invocation as a daemon-hosted session.
///
/// # Errors
///
/// Returns the user-facing error for flags the daemon session cannot honor,
/// a session selection failure, or a daemon startup/session failure.
pub(crate) fn run_hosted_print(options: &RunOptions) -> Result<i32, String> {
    // Flags the in-process run honors but the daemon create contract does
    // not carry fail here instead of being silently ignored.
    let config = &options.config;
    let mut unsupported: Vec<String> = [
        (options.session.fork.is_some(), "--fork"),
        (config.no_skills, "--no-skills"),
        (config.no_prompt_templates, "--no-prompt-templates"),
        (config.no_context_files, "--no-context-files"),
        (config.initial_goal.is_some(), "--goal"),
        (options.offline, "--offline"),
    ]
    .into_iter()
    .filter(|(present, _)| *present)
    .map(|(_, flag)| flag.to_string())
    .collect();
    let mut overlay: Vec<String> = std::env::vars_os()
        .filter_map(|(name, _)| name.into_string().ok())
        .filter(|name| name.starts_with(LAUNCH_OVERLAY_ENV_PREFIX))
        .collect();
    overlay.sort();
    if !overlay.is_empty() {
        unsupported.push(format!("the launch environment ({})", overlay.join(", ")));
    }
    if !unsupported.is_empty() {
        return Err(format!(
            "--daemon-hosted cannot be combined with {} yet: the daemon session does not receive {}",
            unsupported.join(", "),
            if unsupported.len() == 1 { "it" } else { "them" }
        ));
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(hosted_print_main(options))
}

async fn hosted_print_main(options: &RunOptions) -> Result<i32, String> {
    crate::print_terminal::track_headless_invocation(options).await;
    let config = &options.config;
    // The daemon resolves no path against this process's cwd: the session
    // dir and a path-like `--resume` selector go out absolute (TS
    // `SessionManager.setSessionFile` resolves the file it is handed).
    let absolute = |path: std::path::PathBuf| {
        std::path::absolute(&path).map_err(|error| format!("{}: {error}", path.display()))
    };
    let session_dir = absolute(
        options
            .session
            .session_dir
            .clone()
            .unwrap_or_else(|| config.agent_dir.join("sessions")),
    )?;
    let session_path = match &options.session.resume {
        Some(selector) => Some(absolute(crate::print_runtime::resolve_resume_selector(
            selector,
            &config.cwd,
            &session_dir,
        )?)?),
        None if options.session.continue_recent => {
            pa_core::session::discovery::find_most_recent_session_for_cwd(&session_dir, &config.cwd)
        }
        None => None,
    };
    // A resumed session runs in its stored cwd unless `--cwd` overrides it.
    let cwd = match &session_path {
        Some(path) => crate::print_runtime::resumed_session_cwd(
            path,
            &config.cwd,
            options
                .session
                .cwd_from_flag
                .then_some(config.cwd.as_path()),
        )?,
        None => config.cwd.clone(),
    };
    // The session flags, plus the session dir the client resolved `-c`
    // and `--resume` against (the session lands where the next `-c`
    // looks) and the `--models` scope the daemon resolves per create.
    let mut create_config = config.daemon_create_config(&cwd);
    create_config["sessionDir"] = serde_json::json!(session_dir.display().to_string());
    if let Some(models) = &config.models {
        create_config["models"] = serde_json::json!(models);
    }
    if let Some(script) = std::env::var_os(HOSTED_DAEMON_SCRIPT_ENV) {
        create_config["script"] = serde_json::json!(script.to_string_lossy());
    }

    // Flag > PRIME_AGENT_DAEMON_SOCKET > default, like every daemon client.
    let socket_path = crate::config::resolve_daemon_socket_path(options.daemon_socket.as_deref());
    crate::interactive_mode::ensure_daemon_running(&socket_path, &cwd)
        .await
        .map_err(|error| format!("{error:#}"))?;
    let (session, opened) = HostedHeadlessSession::open(HostedSessionOptions {
        socket_path,
        create_config,
        session_path,
        telemetry_disabled: config.telemetry_disabled,
    })
    .await
    .map_err(|error| format!("{error:#}"))?;
    let session = Arc::new(session);
    if opened.model.is_none() {
        // TS: the summary carries no model -> the fallback message (or the
        // no-models text), exit 1, the session left to the daemon.
        eprintln!(
            "{}",
            opened.model_fallback_message.as_deref().unwrap_or(
                "No models available. Check your installation or add models to models.json."
            )
        );
        session.close().await;
        return Ok(1);
    }

    let run = run_print_flow(&session, options);
    let exit_code = tokio::select! {
        exit_code = run => exit_code,
        exit_code = termination_signal() => exit_code,
    };
    // Detach + close (TS `dispose`): the resident session keeps running.
    session.close().await;
    Ok(exit_code)
}

/// The TS print-mode body over the hosted session. A thrown step prints its
/// message to stderr and exits 1 (TS print-mode's catch).
async fn run_print_flow(session: &HostedHeadlessSession, options: &RunOptions) -> i32 {
    let json_mode = options.app_mode == AppMode::Json;
    let run = async {
        let sink: HostedEventSink = if json_mode {
            let output = JsonEventSink::stdout(options.json_event_profile);
            if let Some(header) = session.session_header().await? {
                output.header(header);
            }
            Arc::new(move |event| output.wire_event(event))
        } else {
            Arc::new(|_| {})
        };
        session.start_stream(sink);
        let images = options.initial_images.clone();
        let prompts = options
            .initial_message
            .iter()
            .map(|message| HostedPrompt {
                message: message.clone(),
                images: images.clone(),
            })
            .chain(options.messages.iter().map(|message| HostedPrompt {
                message: message.clone(),
                images: Vec::new(),
            }));
        for prompt in prompts {
            session.prompt(prompt).await?;
        }
        let status = session.wait_for_completion().await?;
        let mut exit_code = 0;
        if !json_mode {
            exit_code =
                crate::print_terminal::write_text_terminal_result(&session.messages().await?);
        }
        if let Some(stderr) = autonomous_exit_stderr(&status, pa_core::autonomous::now_millis()) {
            eprintln!("{stderr}");
            exit_code = 1;
        }
        anyhow::Ok(exit_code)
    };
    match run.await {
        Ok(exit_code) => exit_code,
        Err(error) => {
            eprintln!("{error:#}");
            1
        }
    }
}

/// The first termination signal's exit code (TS print-mode: SIGINT 130,
/// SIGTERM 143, SIGHUP 129). Pends forever where the signals cannot be
/// installed.
#[cfg(unix)]
async fn termination_signal() -> i32 {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut interrupt), Ok(mut terminate), Ok(mut hangup)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
        signal(SignalKind::hangup()),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = interrupt.recv() => 130,
        _ = terminate.recv() => 143,
        _ = hangup.recv() => 129,
    }
}

/// Ctrl+C's exit code (TS print-mode installs no SIGHUP handler on
/// Windows). Pends forever where the handler cannot be installed.
#[cfg(not(unix))]
async fn termination_signal() -> i32 {
    match tokio::signal::ctrl_c().await {
        Ok(()) => 130,
        Err(_) => std::future::pending().await,
    }
}
