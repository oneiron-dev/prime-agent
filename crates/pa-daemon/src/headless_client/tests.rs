//! The hosted headless client against a scripted supervisor socket: the
//! wire order the real supervisor can produce (a response overtaking the
//! events published before it), the route-budget re-wait, the same-file
//! attach, and the detach-only close.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::{HostedHeadlessSession, HostedPrompt, HostedSessionOpened, HostedSessionOptions};

/// One scripted line the fake supervisor writes for a command.
enum Reply {
    /// The command's response (`id`/`command` filled in).
    Ok(Value),
    Fail(&'static str),
    /// A raw frame (a session event, `session_closed`, ...).
    Frame(Value),
    /// Drop the connection (the daemon went away).
    Close,
}

/// The fake supervisor's per-command script: the command type and payload
/// in, the lines to write (in order) out.
type Script = Box<dyn FnMut(&str, &Value) -> Vec<Reply> + Send>;

/// A scripted supervisor on a temp socket: one connection, the hello, then
/// the script's lines per command; records every command type it saw.
struct FakeSupervisor {
    _dir: tempfile::TempDir,
    socket: std::path::PathBuf,
    commands: Arc<Mutex<Vec<String>>>,
}

impl FakeSupervisor {
    fn start(mut script: Script) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("d.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&commands);
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let hello = json!({
                "type": "daemon_hello",
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
            });
            writer
                .write_all(format!("{hello}\n").as_bytes())
                .await
                .unwrap();
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let envelope: Value = serde_json::from_str(&line).unwrap();
                let command = envelope["command"].clone();
                let kind = command["type"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push(kind.clone());
                for reply in script(&kind, &command) {
                    let frame = match reply {
                        Reply::Close => return,
                        Reply::Ok(data) => json!({
                            "type": "response", "id": envelope["id"], "command": kind,
                            "success": true, "data": data,
                        }),
                        Reply::Fail(error) => json!({
                            "type": "response", "id": envelope["id"], "command": kind,
                            "success": false, "error": error,
                        }),
                        Reply::Frame(frame) => frame,
                    };
                    if writer
                        .write_all(format!("{frame}\n").as_bytes())
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
        });
        Self {
            _dir: dir,
            socket,
            commands,
        }
    }

    fn options(&self) -> HostedSessionOptions {
        HostedSessionOptions {
            socket_path: self.socket.clone(),
            create_config: json!({ "cwd": "/work" }),
            session_path: None,
            telemetry_disabled: false,
        }
    }

    fn commands(&self) -> Vec<String> {
        self.commands.lock().unwrap().clone()
    }
}

fn event(sequence: u64, event: &Value) -> Reply {
    Reply::Frame(json!({
        "type": "session_event",
        "activeSessionId": "s1",
        "event": event,
        "meta": { "sequence": sequence },
    }))
}

fn idle_status() -> Value {
    serde_json::to_value(pa_core::autonomous::disabled_autonomous_status()).unwrap()
}

/// The create/attach pair every fresh session opens with.
fn opening(kind: &str) -> Option<Vec<Reply>> {
    match kind {
        "create" => Some(vec![Reply::Ok(
            json!({ "id": "s1", "activeSessionId": "s1", "model": { "id": "faux-1" } }),
        )]),
        "attach" => Some(vec![Reply::Ok(
            json!({ "activeSessionId": "s1", "lastEventSequence": 0 }),
        )]),
        _ => None,
    }
}

fn prompt(text: &str) -> HostedPrompt {
    HostedPrompt {
        message: text.to_string(),
        images: Vec::new(),
    }
}

/// A recording sink.
fn recording() -> (super::HostedEventSink, Arc<Mutex<Vec<Value>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = Arc::clone(&events);
    (
        Arc::new(move |event: &Value| sink_events.lock().unwrap().push(event.clone())),
        events,
    )
}

/// Failure bound for one awaited step (never a readiness wait).
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("the step settles")
}

/// The prompt response precedes the turn's events and the completion
/// response precedes the final `agent_end` (the supervisor's response
/// queue overtaking its event queue): the completion still returns only
/// once every event up to the worker's sequence reached the sink.
#[tokio::test]
async fn completion_waits_for_the_events_its_responses_overtook() {
    let agent_start = json!({ "type": "agent_start" });
    let message_end = json!({ "type": "message_end", "message": { "role": "assistant" } });
    let agent_end = json!({ "type": "agent_end", "messages": [] });
    let compaction_end = json!({ "type": "compaction_end", "reason": "threshold" });
    let script_events = (
        agent_start.clone(),
        message_end.clone(),
        agent_end.clone(),
        compaction_end.clone(),
    );
    let fake = FakeSupervisor::start(Box::new(move |kind, _| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        let (start, message, end, compaction) = &script_events;
        match kind {
            "prompt_and_wait" => vec![Reply::Ok(Value::Null), event(1, start), event(2, message)],
            "wait_for_headless_completion" => vec![Reply::Ok(idle_status())],
            "get_rlm_children" => vec![
                Reply::Ok(json!({ "children": [], "eventSequence": 4 })),
                event(3, end),
                event(4, compaction),
            ],
            "detach" => vec![Reply::Ok(Value::Null)],
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, opened) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    assert_eq!(
        opened,
        HostedSessionOpened {
            active_session_id: "s1".to_string(),
            model: Some(json!({ "id": "faux-1" })),
            model_fallback_message: None,
        }
    );
    let (sink, events) = recording();
    session.start_stream(sink);
    bounded(session.prompt(prompt("hi"))).await.unwrap();
    let status = bounded(session.wait_for_completion()).await.unwrap();
    assert_eq!(status, pa_core::autonomous::disabled_autonomous_status());
    assert_eq!(
        *events.lock().unwrap(),
        vec![agent_start, message_end, agent_end, compaction_end]
    );
    bounded(session.close()).await;
    assert_eq!(
        fake.commands(),
        [
            "create",
            "attach",
            "prompt_and_wait",
            "wait_for_headless_completion",
            "get_rlm_children",
            "detach",
        ]
    );
}

/// A user `message_start` with `text` (the event a prompt's admission
/// streams).
fn user_message_start(sequence: u64, text: &str) -> Reply {
    event(
        sequence,
        &json!({
            "type": "message_start",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
        }),
    )
}

/// A turn longer than the supervisor's route budget answers the prompt
/// with the route timeout after the prompt's user message started; the
/// client waits for the session to go idle (re-issuing the idle wait while
/// the budget keeps running out) instead of failing the prompt.
#[tokio::test]
async fn a_turn_past_the_route_budget_waits_for_idle() {
    let mut idle_waits = 0;
    let fake = FakeSupervisor::start(Box::new(move |kind, _| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        match kind {
            "prompt_and_wait" => vec![
                event(1, &json!({ "type": "agent_start" })),
                user_message_start(2, "long turn"),
                Reply::Fail("Session worker timed out"),
            ],
            "wait_for_headless_completion" => {
                idle_waits += 1;
                if idle_waits == 1 {
                    vec![Reply::Fail("Session worker timed out")]
                } else {
                    vec![Reply::Ok(idle_status())]
                }
            }
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    bounded(session.prompt(prompt("long turn"))).await.unwrap();
    assert_eq!(
        fake.commands(),
        [
            "create",
            "attach",
            "prompt_and_wait",
            "wait_for_headless_completion",
            "wait_for_headless_completion",
        ]
    );
}

/// The route budget also answers a prompt that never reached the worker:
/// with no run started after the prompt was sent, the timeout fails the
/// prompt instead of waiting for an idle session that never ran it.
#[tokio::test]
async fn an_unconfirmed_prompt_past_the_route_budget_fails() {
    let fake = FakeSupervisor::start(Box::new(|kind, _| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        match kind {
            "prompt_and_wait" => vec![Reply::Fail("Session worker timed out")],
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    let error = bounded(session.prompt(prompt("lost"))).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "Session worker timed out before the prompt was seen to start; it may not have run"
    );
    assert_eq!(fake.commands(), ["create", "attach", "prompt_and_wait"]);
}

/// Another prompt's run starting meanwhile (another client of the resident
/// session) does not confirm this prompt: the timeout still fails it.
#[tokio::test]
async fn another_prompts_run_does_not_confirm_a_timed_out_prompt() {
    let fake = FakeSupervisor::start(Box::new(|kind, _| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        match kind {
            "prompt_and_wait" => vec![
                event(1, &json!({ "type": "agent_start" })),
                user_message_start(2, "another client's prompt"),
                Reply::Fail("Session worker timed out"),
            ],
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    let error = bounded(session.prompt(prompt("mine"))).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "Session worker timed out before the prompt was seen to start; it may not have run"
    );
    assert_eq!(fake.commands(), ["create", "attach", "prompt_and_wait"]);
}

/// A prompt the worker rejects fails with the worker's message.
#[tokio::test]
async fn a_rejected_prompt_surfaces_the_daemon_error() {
    let fake = FakeSupervisor::start(Box::new(|kind, _| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        match kind {
            "prompt_and_wait" => vec![Reply::Fail("Prompt cannot be empty")],
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    let error = bounded(session.prompt(prompt(""))).await.unwrap_err();
    assert_eq!(error.to_string(), "Prompt cannot be empty");
}

/// Same-file resume attaches the live worker that hosts the file (TS
/// `findActiveDaemonSessionSummaryForSessionFile`) instead of creating;
/// a failed worker's row is not reused.
#[tokio::test]
async fn same_file_resume_attaches_the_live_worker() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("session.jsonl");
    std::fs::write(&file, "{}\n").unwrap();
    let rows = json!({ "sessions": [
        { "id": "dead", "activeSessionId": "dead", "sessionFile": file, "workerState": "failed" },
        { "id": "other", "activeSessionId": "other", "sessionFile": "/elsewhere.jsonl", "workerState": "ready" },
        { "id": "live-1", "activeSessionId": "live-1", "sessionFile": file, "workerState": "ready",
          "model": { "id": "faux-1" } },
    ]});
    let fake = FakeSupervisor::start(Box::new(move |kind, command| match kind {
        "list" => vec![Reply::Ok(rows.clone())],
        "attach" => {
            assert_eq!(command["activeSessionId"], "live-1");
            vec![Reply::Ok(json!({ "lastEventSequence": 12 }))]
        }
        other => panic!("unexpected command {other}"),
    }));
    let options = HostedSessionOptions {
        session_path: Some(file.clone()),
        ..fake.options()
    };
    let (_session, opened) = bounded(HostedHeadlessSession::open(options)).await.unwrap();
    assert_eq!(opened.active_session_id, "live-1");
    assert_eq!(fake.commands(), ["list", "attach"]);
}

/// A session closed under the client before the run's last event reached
/// the sink fails the completion (the stream is truncated) instead of
/// waiting for a sequence that will never arrive.
#[tokio::test]
async fn a_session_closed_before_its_last_event_fails_the_completion() {
    let fake = FakeSupervisor::start(Box::new(|kind, _| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        match kind {
            "wait_for_headless_completion" => vec![Reply::Ok(idle_status())],
            "get_rlm_children" => vec![
                Reply::Ok(json!({ "children": [], "eventSequence": 9 })),
                Reply::Frame(json!({
                    "type": "session_closed", "activeSessionId": "s1", "reason": "killed",
                })),
            ],
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    let (sink, events) = recording();
    session.start_stream(sink);
    let error = bounded(session.wait_for_completion()).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "the run's event stream ended before its last event: the session was closed (killed)"
    );
    assert!(events.lock().unwrap().is_empty());
}

/// The daemon going away before the run's last event reached the sink (its
/// shutdown broadcast, or the connection's EOF) fails the completion too.
#[tokio::test]
async fn a_daemon_gone_before_the_last_event_fails_the_completion() {
    for (ending, reason) in [
        (
            Reply::Frame(json!({ "type": "daemon_closing" })),
            "the daemon is shutting down",
        ),
        (Reply::Close, "the daemon connection closed"),
    ] {
        let mut ending = Some(ending);
        let fake = FakeSupervisor::start(Box::new(move |kind, _| {
            if let Some(replies) = opening(kind) {
                return replies;
            }
            match kind {
                "wait_for_headless_completion" => vec![Reply::Ok(idle_status())],
                "get_rlm_children" => vec![
                    Reply::Ok(json!({ "children": [], "eventSequence": 9 })),
                    ending.take().expect("one barrier read"),
                ],
                other => panic!("unexpected command {other}"),
            }
        }));
        let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
            .await
            .unwrap();
        let (sink, _events) = recording();
        session.start_stream(sink);
        let error = bounded(session.wait_for_completion()).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("the run's event stream ended before its last event: {reason}")
        );
    }
}

/// A stream that ends after the run's last event reached the sink still
/// completes: nothing was lost.
#[tokio::test]
async fn a_stream_closed_after_its_last_event_completes() {
    let agent_end = json!({ "type": "agent_end", "messages": [] });
    let last = agent_end.clone();
    let fake = FakeSupervisor::start(Box::new(move |kind, _| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        match kind {
            "wait_for_headless_completion" => vec![Reply::Ok(idle_status())],
            "get_rlm_children" => vec![
                Reply::Ok(json!({ "children": [], "eventSequence": 2 })),
                event(1, &json!({ "type": "agent_start" })),
                event(2, &last),
                Reply::Close,
            ],
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    let (sink, events) = recording();
    session.start_stream(sink);
    bounded(session.wait_for_completion()).await.unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        vec![json!({ "type": "agent_start" }), agent_end]
    );
}

/// Leaving detaches and closes the connection; a resident session is never
/// killed or completed by its print client.
#[tokio::test]
async fn close_detaches_and_never_stops_the_session() {
    let fake = FakeSupervisor::start(Box::new(|kind, command| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        match kind {
            "detach" => {
                assert_eq!(command["activeSessionId"], "s1");
                vec![Reply::Ok(Value::Null)]
            }
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    bounded(session.close()).await;
    assert_eq!(fake.commands(), ["create", "attach", "detach"]);
}

/// A request issued after the daemon connection ended fails at once instead
/// of waiting forever for an answer that cannot arrive (the prompt and
/// completion waits are unbounded on the client).
#[tokio::test]
async fn a_request_after_the_connection_ended_fails_instead_of_hanging() {
    let fake = FakeSupervisor::start(Box::new(|kind, _| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        match kind {
            "prompt_and_wait" => vec![Reply::Ok(Value::Null), Reply::Close],
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    let (sink, _events) = recording();
    session.start_stream(sink);
    bounded(session.prompt(prompt("one"))).await.unwrap();
    // The stream end is observed only after the link failed its waiters.
    let mut progress = session.progress.subscribe();
    bounded(progress.wait_for(|progress| progress.ended.is_some()))
        .await
        .unwrap();
    let error = bounded(session.prompt(prompt("two"))).await.unwrap_err();
    assert_eq!(error.to_string(), "the daemon connection is closed");
}

/// The text-mode read converts the daemon's custom rows (rejoined with
/// the entry's ISO timestamp) to the message form's epoch milliseconds, so
/// the terminal rows they carry reach the selection.
#[tokio::test]
async fn messages_read_custom_rows_with_iso_timestamps() {
    let answer = json!({
        "role": "assistant",
        "content": [{ "type": "text", "text": "SAVED" }],
        "api": "faux", "provider": "faux", "model": "faux-1",
        "usage": {
            "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
        },
        "stopReason": "stop",
        "timestamp": 1_790_856_422_484_u64,
    });
    let outcome = |timestamp: Value| {
        json!({
            "role": "custom",
            "customType": "compaction_outcome",
            "content": "Compaction failed",
            "display": true,
            "details": { "outcome": "failed" },
            "timestamp": timestamp,
        })
    };
    let rows = json!({ "messages": [answer.clone(), outcome(json!("2026-10-01T12:07:02.484Z"))] });
    let fake = FakeSupervisor::start(Box::new(move |kind, _| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        match kind {
            "get_messages" => vec![Reply::Ok(rows.clone())],
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    let messages = bounded(session.messages()).await.unwrap();
    let expected: Vec<pa_types::session::AgentMessage> =
        serde_json::from_value(json!([answer, outcome(json!(1_790_856_422_484_u64))])).unwrap();
    assert_eq!(messages, expected);
}

/// A row the session types cannot read fails the read instead of being
/// dropped (a missing terminal row would change the output or exit code).
#[tokio::test]
async fn messages_refuse_an_unreadable_row() {
    let fake = FakeSupervisor::start(Box::new(|kind, _| {
        if let Some(replies) = opening(kind) {
            return replies;
        }
        match kind {
            "get_messages" => vec![Reply::Ok(json!({ "messages": [{ "role": "user" }] }))],
            other => panic!("unexpected command {other}"),
        }
    }));
    let (session, _) = bounded(HostedHeadlessSession::open(fake.options()))
        .await
        .unwrap();
    let error = bounded(session.messages()).await.unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("unreadable session message: "),
        "{error}"
    );
}
