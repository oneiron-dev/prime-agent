//! The headless run's terminal surfaces shared by the in-process print path
//! and the `--daemon-hosted` path: the text-mode terminal result (TS
//! print-mode's text arm) and the `agent headless invoked` adoption event.

use crate::json_output::JsonEventProfile;
use crate::mode::{AppMode, HeadlessHosting, RunOptions};

/// The text-mode terminal result (TS print-mode's text arm over
/// `selectHeadlessTerminalResult`): the primary message prints (an error
/// primary to stderr with exit 1, a settled answer to stdout), then the
/// trailing compaction-outcome disclosures go to stderr. A run with no
/// terminal message — e.g. an overflow turn dropped by the compact-and-retry
/// recovery whose outcome row is the only surface — prints nothing and
/// leaves the exit code to the outcome rows. Returns the exit code.
pub(crate) fn write_text_terminal_result(messages: &[pa_types::session::AgentMessage]) -> i32 {
    let result = pa_core::session_engine::headless::select_headless_terminal_result(messages);
    let mut exit_code = 0;
    if let Some(primary) = result.primary {
        if let Some(stderr) = primary.stderr_text(&mut exit_code) {
            eprintln!("{stderr}");
        }
        if exit_code == 0 {
            if let Some(text) = primary.stdout_text() {
                println!("{text}");
            }
        }
    }
    for outcome in result.compaction_outcomes {
        eprintln!("{}", outcome.content);
        if outcome.outcome == "failed" {
            exit_code = 1;
        }
    }
    exit_code
}

/// `agent headless invoked` (the headless flags' adoption event): tracked
/// once per print/json run on a one-shot client, unless telemetry is off.
/// Primitives only — the output mode and the two fork flags.
pub(crate) async fn track_headless_invocation(options: &RunOptions) {
    if options.config.telemetry_disabled {
        return;
    }
    let settings =
        pa_core::settings::SettingsManager::create(&options.config.cwd, &options.config.agent_dir);
    let client =
        pa_core::session_engine::telemetry::build_client(&settings, &options.config.agent_dir);
    pa_telemetry::AgentHeadlessInvoked {
        mode: match options.app_mode {
            AppMode::Json => pa_telemetry::HeadlessMode::Json,
            AppMode::Print
            | AppMode::Interactive
            | AppMode::Rpc
            | AppMode::Acp
            | AppMode::Daemon => pa_telemetry::HeadlessMode::Text,
        },
        daemon_hosted: match options.headless_hosting {
            HeadlessHosting::InProcess => false,
            HeadlessHosting::Daemon => true,
        },
        json_event_profile: match options.json_event_profile {
            JsonEventProfile::All => pa_telemetry::HeadlessJsonEventProfile::All,
            JsonEventProfile::FactoryCompleted => {
                pa_telemetry::HeadlessJsonEventProfile::FactoryCompleted
            }
        },
    }
    .track(&client);
    let _ = client.shutdown().await;
}
