//! The hosted headless client (TS `DaemonAgentConnection` behind a print
//! or json run with `--daemon-hosted`): the daemon owns a RESIDENT session
//! (listed, attachable from another terminal) and this client drives it over
//! the supervisor socket with schema-31 commands only — create (or attach
//! the live worker that already hosts the same session file), attach,
//! stream the session's events, `prompt_and_wait`,
//! `wait_for_headless_completion`, then detach and close. The client never
//! kills or completes the session.
//!
//! Ordering: the supervisor relays a session's events through one FIFO per
//! connection, but a command response travels a separate queue and can
//! overtake events published before it. The completion wait therefore ends
//! with a stream barrier: the worker's current event sequence (read after
//! the run went idle) must have reached the sink, and every `agent_start`
//! seen must have its `agent_end`, before the run counts as finished.
//!
//! Route budget: the supervisor answers `prompt_and_wait` with its route
//! timeout after ten minutes even while the worker still runs the turn
//! (TS forwards it for 24 hours). Each prompt therefore carries its own
//! schema-30 `admissionId` when the daemon advertises
//! `prompt_admission_cancellation` (TS print sends none: its route never
//! times out), and a timed-out prompt reads its admission back with
//! `cancel_prompt_admission` (never `cancelOwned`): only that answer says
//! whether THIS prompt's turn started. Without the capability a timed-out
//! prompt has no evidence and fails.
//!
//! Session policy (fork revision 31): `--offline` and `--no-skills` ride
//! the create config as `offline`/`noSkills` when the daemon advertises
//! `session_policy`, and every open then goes through the supervisor's
//! create (a live worker for the same file is reused there, but only when
//! it runs under the same policy). A daemon without the capability gets
//! neither key and the list-and-attach reuse; asking it for either flag
//! fails instead of running the session without it.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use pa_core::session_engine::tool_selection::ToolSelection;
use pa_types::daemon::{
    DaemonCommand, DaemonResponse, DaemonSessionLifecycle, PromptInput, ToolSelectionFlags,
    SESSION_TOOL_SELECTION_CAPABILITY,
};
use serde_json::{Map, Value};
use tokio::sync::{mpsc, watch};

use crate::daemon_link::{DaemonLink, LinkFrame, ResponseWait};
use crate::session_policy::{SessionPolicy, SESSION_POLICY_CAPABILITY};
use crate::supervisor::SESSION_WORKER_TIMED_OUT;

/// Bound for the session-scoped startup and read commands (create, attach,
/// list, header, messages, the barrier read). Turn-long waits are unbounded
/// on the client: the supervisor bounds each route and the client waits
/// again while the worker is still running.
const REQUEST_BOUND: ResponseWait = ResponseWait::Within(Duration::from_secs(120));
/// The server capability an admitted prompt and its
/// `cancel_prompt_admission` read require (TS
/// `PROMPT_ADMISSION_CANCELLATION_COMMAND`).
const PROMPT_ADMISSION_CANCELLATION: &str = "prompt_admission_cancellation";

/// Everything [`HostedHeadlessSession::open`] needs.
#[derive(Debug, Clone)]
pub struct HostedSessionOptions {
    /// The supervisor socket (already ensured running by the caller).
    pub socket_path: PathBuf,
    /// The create config under the TS `AgentSessionRuntimeConfig` names the
    /// Rust create contract carries (`cwd`, `sessionDir`, `provider`,
    /// `model`, `thinking`, `systemPrompt`, ...).
    pub create_config: Value,
    /// The saved session to continue (resolved by the caller for `-c` and
    /// `--resume`); `None` opens a fresh session.
    pub session_path: Option<PathBuf>,
    /// The invocation runs with telemetry disabled (TS `telemetryDisabled`
    /// on create and attach).
    pub telemetry_disabled: bool,
    /// The session's `--offline`/`--no-skills` policy.
    pub session_policy: SessionPolicy,
}

/// What the daemon reported for the hosted session.
#[derive(Debug, Clone, PartialEq)]
pub struct HostedSessionOpened {
    pub active_session_id: String,
    /// The session's resolved model (`None`: no usable model).
    pub model: Option<Value>,
    /// Why no model resolved, when the daemon said.
    pub model_fallback_message: Option<String>,
}

/// One prompt of the run.
#[derive(Debug, Clone)]
pub struct HostedPrompt {
    pub message: String,
    /// `@file` image attachments (the initial prompt's only).
    pub images: Vec<pa_agent::types::ImageContent>,
}

/// One session event handed to the sink: the inner `session_event.event`
/// object, never the supervisor envelope.
pub type HostedEventSink = Arc<dyn Fn(&Value) + Send + Sync>;

/// The `cancel_prompt_admission` answer for a prompt the route budget
/// left unanswered (TS `cancelled | owned | unknown`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum AdmissionAnswer {
    /// The worker committed the admission: the prompt's turn started.
    Owned,
    /// The prompt was still queued; the cancel withdrew it.
    Cancelled,
    /// Nothing holds the admission: the prompt never reached the worker,
    /// or it settled between the budget and the read.
    Unknown,
}

/// The emitted stream's position, for the completion barrier.
#[derive(Debug, Clone, Default)]
struct StreamProgress {
    /// The highest event sequence the sink has seen (seeded with the
    /// attach cursor).
    sequence: u64,
    runs_started: u64,
    runs_ended: u64,
    /// Why the stream ended, once it did (connection closed, session
    /// closed, daemon closing).
    ended: Option<String>,
}

/// A resident daemon session driven by this headless client.
pub struct HostedHeadlessSession {
    link: Arc<DaemonLink>,
    active_session_id: String,
    progress: watch::Sender<StreamProgress>,
    /// The frames the consumer forwarded, waiting for the sink.
    pending_events: std::sync::Mutex<Option<mpsc::UnboundedReceiver<Value>>>,
}

impl HostedHeadlessSession {
    /// Connect, create the resident session (or find the live worker that
    /// hosts `session_path`), and attach. Events buffer from the attach on
    /// until [`HostedHeadlessSession::start_stream`] installs the sink.
    ///
    /// # Errors
    ///
    /// Returns the daemon's refusal (create/attach failures keep the
    /// daemon's message) or a transport failure.
    pub async fn open(
        options: HostedSessionOptions,
    ) -> anyhow::Result<(Self, HostedSessionOpened)> {
        let link = Arc::new(DaemonLink::connect(&options.socket_path, "headless").await?);
        let (event_tx, event_rx) = mpsc::unbounded_channel::<Value>();
        // The consumer owns the frame order: an event observed before a
        // response is forwarded before that response resolves its caller.
        {
            let link = Arc::clone(&link);
            tokio::spawn(async move {
                let mut frames = link.frames.lock().await;
                while let Some(frame) = frames.recv().await {
                    match frame {
                        LinkFrame::Response(response) => link.resolve(response),
                        LinkFrame::Event(frame) | LinkFrame::Other(frame) => {
                            let _ = event_tx.send(frame);
                        }
                    }
                }
                // The connection ended: no response will ever arrive.
                link.fail_pending();
            });
        }
        let session = Self {
            link,
            active_session_id: String::new(),
            progress: watch::Sender::new(StreamProgress::default()),
            pending_events: std::sync::Mutex::new(Some(event_rx)),
        };
        session.establish(options).await
    }

    async fn establish(
        mut self,
        options: HostedSessionOptions,
    ) -> anyhow::Result<(Self, HostedSessionOpened)> {
        // A daemon without `session_tool_selection` ignores the keys and
        // would run every tool: refuse instead of falling back.
        let requested = ToolSelectionFlags::from_create_config(&options.create_config)?;
        if let Some(refusal) = requested.unsupported_by_daemon(
            self.link
                .server_capabilities
                .iter()
                .any(|capability| capability == SESSION_TOOL_SELECTION_CAPABILITY),
        ) {
            anyhow::bail!("{refusal}");
        }
        let policy_supported = self
            .link
            .server_capabilities
            .iter()
            .any(|capability| capability == SESSION_POLICY_CAPABILITY);
        let mut create_config = options.create_config.clone();
        if policy_supported {
            if let Some(config) = create_config.as_object_mut() {
                options.session_policy.write_into(config);
            }
        } else if !options.session_policy.is_default() {
            anyhow::bail!(
                "The running daemon cannot apply {} to a hosted session (it does not advertise {SESSION_POLICY_CAPABILITY}); stop it so a current one starts, or run without --daemon-hosted",
                options.session_policy.flags()
            );
        }
        // With the policy capability every open is a create: the
        // supervisor reuses a live worker for the same file only when its
        // policy matches. Without it, the live row is attached directly.
        let live = match &options.session_path {
            Some(path) if !policy_supported => self.live_session_for_file(path).await?,
            Some(_) | None => None,
        };
        // Reusing a live session never changes its tools: it belongs to
        // the client that launched it, so a different selection is refused.
        if let Some(summary) = &live {
            let running = summary
                .get("toolSelection")
                .map(|value| serde_json::from_value::<ToolSelectionFlags>(value.clone()))
                .transpose()?
                .unwrap_or_default();
            if ToolSelection::from_flags(&running) != ToolSelection::from_flags(&requested) {
                anyhow::bail!(
                    "the session is already running in the daemon with {}, and this run asks for {}; a live session keeps the tools it was launched with. Run with the same tool flags, or resume it after it stops",
                    running.describe(),
                    requested.describe()
                );
            }
        }
        let summary = if let Some(summary) = live {
            summary
        } else {
            let create = DaemonCommand::Create {
                id: None,
                session_path: options
                    .session_path
                    .as_ref()
                    .map(|path| path.display().to_string()),
                continue_recent: None,
                no_session: None,
                name: None,
                config: Some(create_config),
                telemetry_disabled: options.telemetry_disabled.then_some(true),
                runtime_metadata: None,
                lifecycle: Some(DaemonSessionLifecycle::Resident),
                env: None,
                launch_env: None,
                rest: Map::default(),
            };
            success_data(self.link.request(create, REQUEST_BOUND).await?)?
        };
        let active_session_id = summary
            .get("activeSessionId")
            .or_else(|| summary.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("Daemon returned an invalid create response"))?;
        let attach = DaemonCommand::Attach {
            id: None,
            active_session_id: active_session_id.clone(),
            client_id: None,
            capabilities: None,
            resume_cursor: None,
            telemetry_disabled: options.telemetry_disabled.then_some(true),
            recovery_config: None,
            env: None,
            launch_env: None,
            rest: Map::default(),
        };
        let attached = success_data(self.link.request(attach, REQUEST_BOUND).await?)?;
        let baseline = attached
            .get("lastEventSequence")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        self.progress
            .send_modify(|progress| progress.sequence = progress.sequence.max(baseline));
        self.active_session_id.clone_from(&active_session_id);
        let opened = HostedSessionOpened {
            active_session_id,
            model: summary
                .get("model")
                .filter(|model| !model.is_null())
                .cloned(),
            model_fallback_message: summary
                .get("modelFallbackMessage")
                .and_then(Value::as_str)
                .map(str::to_string),
        };
        Ok((self, opened))
    }

    /// The live worker summary hosting `path` (TS
    /// `findActiveDaemonSessionSummaryForSessionFile`): an attachable row
    /// whose session file is the same file and whose worker is not failed.
    async fn live_session_for_file(&self, path: &std::path::Path) -> anyhow::Result<Option<Value>> {
        let list = DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: Map::default(),
        };
        let data = success_data(self.link.request(list, REQUEST_BOUND).await?)?;
        let target = crate::lease::canonical_session_path(path);
        Ok(data
            .get("sessions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|row| {
                row.get("activeSessionId").and_then(Value::as_str).is_some()
                    && row.get("workerState").and_then(Value::as_str) != Some("failed")
                    && row
                        .get("sessionFile")
                        .and_then(Value::as_str)
                        .is_some_and(|file| {
                            crate::lease::canonical_session_path(std::path::Path::new(file))
                                == target
                        })
            })
            .cloned())
    }

    /// The persisted session header line (`get_session_header`).
    ///
    /// # Errors
    ///
    /// Returns the daemon's refusal or a transport failure.
    pub async fn session_header(&self) -> anyhow::Result<Option<Value>> {
        let command = DaemonCommand::GetSessionHeader {
            id: None,
            active_session_id: self.active_session_id.clone(),
            rest: Map::default(),
        };
        let data = success_data(self.link.request(command, REQUEST_BOUND).await?)?;
        Ok(data
            .get("header")
            .filter(|header| !header.is_null())
            .cloned())
    }

    /// Start handing the session's events to `sink`, in wire order, the
    /// buffered ones first. Only the first call installs a sink.
    ///
    /// # Panics
    ///
    /// Panics if the event-buffer lock is poisoned.
    pub fn start_stream(&self, sink: HostedEventSink) {
        let Some(mut events) = self.pending_events.lock().unwrap().take() else {
            return;
        };
        let progress = self.progress.clone();
        let active_session_id = self.active_session_id.clone();
        tokio::spawn(async move {
            while let Some(frame) = events.recv().await {
                let ended = stream_frame(&frame, &active_session_id, &sink, &progress);
                if ended {
                    break;
                }
            }
            progress.send_modify(|progress| {
                progress
                    .ended
                    .get_or_insert_with(|| "the daemon connection closed".to_string());
            });
        });
    }

    /// Run one prompt to its settled turn (`prompt_and_wait`). When the
    /// supervisor's route budget answers first, the prompt's own admission
    /// decides: `owned` means its turn started (the worker commits an
    /// admission when the turn starts, before a `/skill:` command expands
    /// or a session command such as `/compact` runs, so every submission
    /// is covered and another client's prompt never is), and the client
    /// waits for the session to go idle; a prompt still queued is
    /// withdrawn by the same read and never runs.
    ///
    /// # Errors
    ///
    /// Returns the prompt's rejection (the worker's admission or settle
    /// error), the route budget's timeout for a prompt that was withdrawn
    /// while queued, that nothing holds any more, or whose daemon cannot
    /// read admissions back (it may never have reached the worker, so the
    /// run fails rather than report it), or a transport failure. A turn
    /// confirmed past the budget reports the session's idle state, not its
    /// own settle error.
    pub async fn prompt(&self, prompt: HostedPrompt) -> anyhow::Result<()> {
        let images = (!prompt.images.is_empty())
            .then(|| serde_json::to_value(&prompt.images))
            .transpose()?;
        // TS `DaemonAgentConnection`'s admission id shape, behind the same
        // capability TS requires for an admitted prompt.
        let admission_id = self
            .link
            .server_capabilities
            .iter()
            .any(|capability| capability == PROMPT_ADMISSION_CANCELLATION)
            .then(|| format!("prompt-admission:{}", uuid::Uuid::new_v4()));
        let command = DaemonCommand::PromptAndWait {
            id: None,
            active_session_id: self.active_session_id.clone(),
            message: prompt.message,
            input: PromptInput {
                content: None,
                images,
                streaming_behavior: None,
                queue_if_busy: None,
                expand_prompt_templates: None,
                source: None,
                agent_message_id: None,
                custom_message: None,
                queue_key: None,
                prefix_messages: None,
                admission_id: admission_id.clone(),
                rlm_notice_nonce: None,
            },
            rest: Map::default(),
        };
        let response = self
            .link
            .request(command, ResponseWait::UntilAnswered)
            .await?;
        if !is_route_timeout(&response) {
            return success_data(response).map(|_| ());
        }
        let answer = match admission_id {
            Some(admission_id) => {
                let read = DaemonCommand::CancelPromptAdmission {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    admission_id,
                    // A running turn must keep running.
                    cancel_owned: None,
                    rest: Map::default(),
                };
                let data = success_data(self.link.request(read, REQUEST_BOUND).await?)?;
                serde_json::from_value(data.get("status").cloned().unwrap_or_default()).map_err(
                    |error| anyhow::anyhow!("unreadable prompt admission status: {error}"),
                )?
            }
            // A daemon without admission cancellation holds no evidence.
            None => AdmissionAnswer::Unknown,
        };
        match answer {
            AdmissionAnswer::Owned => {
                self.idle_status().await?;
                Ok(())
            }
            AdmissionAnswer::Cancelled => anyhow::bail!(
                "{SESSION_WORKER_TIMED_OUT} while the prompt was still queued; it was withdrawn and did not run"
            ),
            AdmissionAnswer::Unknown => anyhow::bail!(
                "{SESSION_WORKER_TIMED_OUT} before the prompt was seen to start; it may not have run"
            ),
        }
    }

    /// Wait for the run to settle (`wait_for_headless_completion`) and for
    /// every event it emitted to reach the sink; answers the autonomous
    /// accounting.
    ///
    /// # Errors
    ///
    /// Returns the daemon's refusal or a transport failure.
    ///
    /// # Panics
    ///
    /// Panics if the event-buffer lock is poisoned.
    pub async fn wait_for_completion(
        &self,
    ) -> anyhow::Result<pa_core::autonomous::AgentAutonomousStatus> {
        let status = self.idle_status().await?;
        if self.pending_events.lock().unwrap().is_none() {
            self.drain_stream().await?;
        }
        Ok(status)
    }

    /// The idle wait, re-issued while the supervisor's route budget runs
    /// out on a still-running session.
    async fn idle_status(&self) -> anyhow::Result<pa_core::autonomous::AgentAutonomousStatus> {
        loop {
            let command = DaemonCommand::WaitForHeadlessCompletion {
                id: None,
                active_session_id: self.active_session_id.clone(),
                wait_for_rlm_quiescence: None,
                rest: Map::default(),
            };
            let response = self
                .link
                .request(command, ResponseWait::UntilAnswered)
                .await?;
            if is_route_timeout(&response) {
                continue;
            }
            let data = success_data(response)?;
            return Ok(serde_json::from_value(data)?);
        }
    }

    /// The stream barrier: the worker's current event sequence (read now,
    /// after the run went idle) has reached the sink, and every started
    /// agent run has its `agent_end`. A stream that ends first (the
    /// connection, the session, or the daemon closed) fails the run: the
    /// sink missed events the worker produced.
    async fn drain_stream(&self) -> anyhow::Result<()> {
        let command = DaemonCommand::GetRlmChildren {
            id: None,
            active_session_id: self.active_session_id.clone(),
            rest: Map::default(),
        };
        let data = success_data(self.link.request(command, REQUEST_BOUND).await?)?;
        let target = data
            .get("eventSequence")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let drained = |progress: &StreamProgress| {
            progress.sequence >= target && progress.runs_ended >= progress.runs_started
        };
        let mut progress = self.progress.subscribe();
        let settled = progress
            .wait_for(|progress| drained(progress) || progress.ended.is_some())
            .await?;
        if drained(&settled) {
            return Ok(());
        }
        let reason = settled.ended.clone().unwrap_or_default();
        anyhow::bail!("the run's event stream ended before its last event: {reason}")
    }

    /// The session's messages (`get_messages`), for the text-mode result.
    /// The daemon's session view rejoins a `custom_message` entry with the
    /// entry's ISO timestamp; the message form (TS `createCustomMessage`)
    /// carries epoch milliseconds, so custom rows convert before decoding
    /// and keep the terminal rows they carry (command results, compaction
    /// outcomes).
    ///
    /// # Errors
    ///
    /// Returns the daemon's refusal, a transport failure, or a row the
    /// session types cannot read (never silently dropped: a missing row
    /// could change the run's output or exit code).
    pub async fn messages(&self) -> anyhow::Result<Vec<pa_types::session::AgentMessage>> {
        let command = DaemonCommand::GetMessages {
            id: None,
            active_session_id: self.active_session_id.clone(),
            rest: Map::default(),
        };
        let data = success_data(self.link.request(command, REQUEST_BOUND).await?)?;
        data.get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|message| {
                let mut message = message.clone();
                if message.get("role").and_then(Value::as_str) == Some("custom") {
                    if let Some(millis) = message
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .and_then(crate::util::iso_to_unix_ms)
                    {
                        message["timestamp"] = Value::from(millis);
                    }
                }
                serde_json::from_value(message)
                    .map_err(|error| anyhow::anyhow!("unreadable session message: {error}"))
            })
            .collect()
    }

    /// Leave the session running: detach, waiting at most `detach_bound`
    /// for the answer (the caller's exit budget: an exit must not hang on
    /// a daemon that stopped answering), then close the connection, which
    /// detaches anyway. Never kills or completes the resident session.
    pub async fn close(&self, detach_bound: Duration) {
        let detach = DaemonCommand::Detach {
            id: None,
            active_session_id: Some(self.active_session_id.clone()),
            rest: Map::default(),
        };
        let _ = self
            .link
            .request(detach, ResponseWait::Within(detach_bound))
            .await;
        self.link.close();
    }
}

/// Hand one forwarded frame to the sink and advance the stream position.
/// Returns `true` when the frame ends the stream.
fn stream_frame(
    frame: &Value,
    active_session_id: &str,
    sink: &HostedEventSink,
    progress: &watch::Sender<StreamProgress>,
) -> bool {
    let frame_type = frame.get("type").and_then(Value::as_str);
    let ours = frame.get("activeSessionId").and_then(Value::as_str) == Some(active_session_id);
    let sequence = frame
        .get("meta")
        .and_then(|meta| meta.get("sequence"))
        .and_then(Value::as_u64);
    match frame_type {
        Some("session_event") if ours => {
            let event = frame.get("event").unwrap_or(&Value::Null);
            sink(event);
            let event_type = event.get("type").and_then(Value::as_str);
            progress.send_modify(|progress| {
                if let Some(sequence) = sequence {
                    progress.sequence = progress.sequence.max(sequence);
                }
                match event_type {
                    Some("agent_start") => progress.runs_started += 1,
                    Some("agent_end") => progress.runs_ended += 1,
                    _ => {}
                }
            });
            false
        }
        Some("session_closed") if ours => {
            let reason = frame
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("closed");
            progress.send_modify(|progress| {
                progress.ended = Some(format!("the session was closed ({reason})"));
            });
            true
        }
        Some("daemon_closing") => {
            progress.send_modify(|progress| {
                progress.ended = Some("the daemon is shutting down".to_string());
            });
            true
        }
        _ => false,
    }
}

/// A route answered by the supervisor's budget, not by the worker.
fn is_route_timeout(response: &DaemonResponse) -> bool {
    !response.success && response.error.as_deref() == Some(SESSION_WORKER_TIMED_OUT)
}

/// A successful response's data (`Null` when it carries none), or its
/// error as the failure.
fn success_data(response: DaemonResponse) -> anyhow::Result<Value> {
    if response.success {
        Ok(response.data.unwrap_or(Value::Null))
    } else {
        Err(anyhow::anyhow!(response.error.unwrap_or_else(|| format!(
            "daemon {} failed",
            response.command
        ))))
    }
}

// The scripted supervisor listens on a Unix socket.
#[cfg(all(test, unix))]
mod tests;
