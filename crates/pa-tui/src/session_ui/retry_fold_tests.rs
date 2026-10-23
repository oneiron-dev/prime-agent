//! Real live event fold: tool-first frames may precede the assistant text row.
use super::*;
use crate::daemon_client::DaemonClient;
use crate::interactive::{InteractiveOptions, SessionSelection};
use crate::session_ui::ActivityUpdates;
use crate::theme::{ColorMode, Theme};
use serde_json::json;
use std::collections::HashSet;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

#[tokio::test]
async fn tool_first_text_later_retry_supersedes_only_the_failed_generation() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("d.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let hello = json!({"type": "daemon_hello", "protocol": {"name": "prime-agent.daemon", "version": 7},
            "serverCapabilities": ["attach_snapshot", "event_sequence"]});
        writer
            .write_all(format!("{hello}\n").as_bytes())
            .await
            .unwrap();
        let mut lines = tokio::io::BufReader::new(reader).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            if line.is_empty() {
                continue;
            }
            let envelope: Value = serde_json::from_str(&line).unwrap();
            let kind = envelope["command"]["type"].as_str().unwrap();
            let data = if kind == "attach" {
                json!({"activeSessionId": "live", "snapshot": {"state": {"sessionId": "saved"}, "messages": []}})
            } else {
                json!({})
            };
            let response = json!({"type": "response", "id": envelope["id"], "command": kind, "success": true, "data": data});
            if writer
                .write_all(format!("{response}\n").as_bytes())
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let (mut client, _events) = DaemonClient::connect(&socket).await.unwrap();
    let options = InteractiveOptions {
        models: None,
        tool_selection: pa_types::daemon::ToolSelectionFlags::default(),
        socket_path: PathBuf::from("/tmp/unused.sock"),
        cwd: dir.path().to_path_buf(),
        session_dir: None,
        script_path: None,
        model_selection: crate::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: SessionSelection::Attach("live".to_string()),
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
        keybindings: crate::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    };
    let mut ui = SessionUi::open(
        client.clone(),
        &options,
        mpsc::unbounded_channel().0,
        mpsc::unbounded_channel().0,
        mpsc::unbounded_channel().0,
        mpsc::unbounded_channel().0,
        mpsc::unbounded_channel().0,
        mpsc::unbounded_channel().0,
        mpsc::unbounded_channel().0,
        mpsc::unbounded_channel().0,
        mpsc::unbounded_channel().0,
        ActivityUpdates {
            heartbeats: mpsc::unbounded_channel().0,
            bash: mpsc::unbounded_channel().0,
            factory: mpsc::unbounded_channel().0,
            commands: mpsc::unbounded_channel().0,
        },
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
    ui.rebuild_view(&mut view, &crate::session_ui::RebuildKind::Rebind);
    let mut sequence = 0;
    let mut fold = |event, view: &mut AgentView| {
        sequence += 1;
        ui.apply_client_event(
            DaemonClientEvent::SessionEvent {
                active_session_id: "live".to_string(),
                event,
                meta_sequence: sequence,
            },
            view,
        );
    };
    let committed = json!({"role": "assistant", "content": [{"type": "toolCall", "id": "once", "name": "ipython", "arguments": {"code": "committed"}}], "stopReason": "toolUse"});
    fold(json!({"type": "agent_start"}), &mut view);
    fold(
        json!({"type": "message_start", "message": {"role": "user", "content": "hello"}}),
        &mut view,
    );
    fold(
        json!({"type": "message_start", "message": {"role": "assistant", "content": []}, "assistantMessageEvent": {"type": "start"}}),
        &mut view,
    );
    fold(
        json!({"type": "message_update", "message": committed}),
        &mut view,
    );
    fold(
        json!({"type": "message_end", "message": committed}),
        &mut view,
    );
    fold(
        json!({"type": "tool_execution_start", "toolCallId": "once", "toolName": "ipython", "args": {"code": "committed"}}),
        &mut view,
    );
    fold(
        json!({"type": "tool_execution_end", "toolCallId": "once", "result": {"content": [{"type": "text", "text": "real result"}]}, "isError": false}),
        &mut view,
    );
    let committed_rows = view.chat.clone();
    let cut = json!({"type": "toolCall", "id": "cut", "name": "ipython", "arguments": {"code": "must not execute"}});
    fold(
        json!({"type": "message_start", "message": {"role": "assistant", "content": []}, "assistantMessageEvent": {"type": "start"}}),
        &mut view,
    );
    fold(
        json!({"type": "message_update", "message": {"role": "assistant", "content": [cut]}}),
        &mut view,
    );
    let failed = json!({"role": "assistant", "content": [cut, {"type": "text", "text": "failed partial"}], "stopReason": "error", "errorMessage": "socket closed"});
    fold(
        json!({"type": "message_update", "message": failed}),
        &mut view,
    );
    fold(json!({"type": "message_end", "message": failed}), &mut view);
    assert!(
        matches!(view.chat.get(committed_rows.len()), Some(ChatEntry::Tool(card)) if card.id == "cut" && card.aborted && !card.started)
    );
    assert!(
        matches!(view.chat.last(), Some(ChatEntry::Assistant(message)) if message.has_tool_calls && message.error.is_none())
    );
    fold(
        json!({"type": "auto_retry_start", "attempt": 1, "maxAttempts": 3, "delayMs": 2000, "errorMessage": "socket closed"}),
        &mut view,
    );
    assert_eq!(view.chat, committed_rows);
    // Late tool dispatch cannot revive the superseded card.
    fold(
        json!({"type": "tool_execution_start", "toolCallId": "cut", "toolName": "ipython", "args": {}}),
        &mut view,
    );
    assert_eq!(view.chat, committed_rows);
    let recovered = json!({"role": "assistant", "content": [{"type": "text", "text": "recovered"}], "stopReason": "stop"});
    fold(
        json!({"type": "message_start", "message": {"role": "assistant", "content": []}, "assistantMessageEvent": {"type": "start"}}),
        &mut view,
    );
    fold(
        json!({"type": "message_update", "message": recovered}),
        &mut view,
    );
    fold(
        json!({"type": "message_end", "message": recovered}),
        &mut view,
    );
    fold(
        json!({"type": "auto_retry_end", "success": true, "attempt": 1}),
        &mut view,
    );
    let texts = view
        .chat
        .iter()
        .filter_map(|entry| match entry {
            ChatEntry::Assistant(message) => Some(message.blocks.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![vec![MessageBlock::Text("recovered".to_string())]]
    );
    assert!(view.chat.iter().any(|entry| matches!(entry, ChatEntry::Tool(card) if card.id == "once" && card.started && card.result.is_some())));
    drop(ui);
    client.hard_close();
    server.await.unwrap();
}
