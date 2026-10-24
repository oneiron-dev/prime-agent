//! Launch overrides still reach a daemon that supports helper defaults but not helper lists.
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};
use serde_json::{json, Value};

fn options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        tool_selection: pa_types::daemon::ToolSelectionFlags::default(),
        models: None,
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: SessionSelection::New,
        restore_dock_focus: false,
        initial_message: None,
        show_images: true,
        fullscreen_mouse: true,
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        tree_filter_mode: String::new(),
        branch_summary_skip_prompt: false,
        version: "0.0.0".to_string(),
        onboarding: None,
        telemetry_disabled: None,
        client_auth: None,
        traces: None,
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    }
}

#[test]
fn helper_launch_override_survives_an_old_daemon_with_a_settings_list() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("tui.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let hello = json!({
            "type": "daemon_hello",
            "protocol": {"name": "prime-agent.daemon", "version": 7},
            "serverCapabilities": ["subagent_model"],
            "clientId": "mock",
        });
        writeln!(writer, "{hello}").unwrap();
        let mut overrides = Vec::new();
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap() != 0 {
            if line.trim().is_empty() {
                line.clear();
                continue;
            }
            let envelope: Value = serde_json::from_str(line.trim()).unwrap();
            line.clear();
            let command = &envelope["command"];
            let kind = command["type"].as_str().unwrap();
            let data = match kind {
                "create" => json!({"activeSessionId": "s1", "sessionId": "saved"}),
                "attach" => json!({
                    "activeSessionId": "s1",
                    "snapshot": {"state": {"sessionId": "saved"}, "messages": []},
                }),
                "set_subagent_model" => {
                    overrides.push(command.clone());
                    json!({"model": command["model"], "modelSource": "session", "thinking": command["thinking"], "thinkingSource": "session"})
                }
                _ => json!({}),
            };
            let response = json!({"type": "response", "id": envelope["id"], "command": kind, "success": true, "data": data});
            if writeln!(writer, "{response}").is_err() {
                break;
            }
        }
        overrides
    });
    std::fs::write(
        dir.path().join("settings.json"),
        json!({"subagentModels": ["test-provider/listed"]}).to_string(),
    )
    .unwrap();
    let mut options = options(socket);
    options.client_settings = Some(super::CliClientSettings::new(
        dir.path().to_path_buf(),
        dir.path().to_path_buf(),
    ));
    options.model_selection.subagent_model = Some("test-provider/chosen".to_string());
    options.model_selection.subagent_thinking = Some("max".to_string());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let outcome = runtime
        .block_on(run_interactive(
            options,
            UiMode::Headless(HeadlessPlan {
                steps: Vec::new(),
                width: 160,
                height: 40,
            }),
        ))
        .unwrap();
    let overrides = server.join().unwrap();
    assert_eq!(
        overrides,
        vec![json!({
            "type": "set_subagent_model", "activeSessionId": "s1",
            "model": "test-provider/chosen", "thinking": "max",
        })]
    );
    assert!(outcome
        .frames
        .join("\n")
        .contains("does not enforce subagentModels"));
}
