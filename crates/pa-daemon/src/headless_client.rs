//! The hosted headless client (TS `DaemonAgentConnection` behind a print
//! or json run with `--daemon-hosted`): the daemon owns a RESIDENT session
//! (listed, attachable from another terminal) and this client drives it over
//! the supervisor socket with schema-30 commands only — create (or attach
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

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use pa_types::daemon::{DaemonCommand, DaemonResponse, DaemonSessionLifecycle, PromptInput};
use serde_json::{Map, Value};
use tokio::sync::{mpsc, watch};

use crate::daemon_link::{DaemonLink, LinkFrame, ResponseWait};
use crate::supervisor::SESSION_WORKER_TIMED_OUT;

/// Bound for the session-scoped startup and read commands (create, attach,
/// list, header, messages, the barrier read). Turn-long waits are unbounded
/// on the client: the supervisor bounds each route and the client waits
/// again while the worker is still running.
const REQUEST_BOUND: ResponseWait = ResponseWait::Within(Duration::from_secs(120));
/// Bound for the detach on the way out: an exit must not hang on a daemon
/// that stopped answering (closing the socket detaches anyway).
const DETACH_BOUND: ResponseWait = ResponseWait::Within(Duration::from_secs(5));

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
    /// `agent_start` frames received, counted by the frame consumer in
    /// wire order, so a response sees every run start that preceded it.
    runs_started_on_wire: Arc<AtomicU64>,
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
        let runs_started_on_wire = Arc::new(AtomicU64::new(0));
        // The consumer owns the frame order: an event observed before a
        // response is forwarded (and counted) before that response
        // resolves its caller.
        {
            let link = Arc::clone(&link);
            let runs_started_on_wire = Arc::clone(&runs_started_on_wire);
            tokio::spawn(async move {
                let mut frames = link.frames.lock().await;
                while let Some(frame) = frames.recv().await {
                    match frame {
                        LinkFrame::Response(response) => link.resolve(response),
                        LinkFrame::Event(frame) => {
                            let event_type = frame
                                .get("event")
                                .and_then(|event| event.get("type"))
                                .and_then(Value::as_str);
                            if event_type == Some("agent_start") {
                                runs_started_on_wire.fetch_add(1, Ordering::SeqCst);
                            }
                            let _ = event_tx.send(frame);
                        }
                        LinkFrame::Other(frame) => {
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
            runs_started_on_wire,
            pending_events: std::sync::Mutex::new(Some(event_rx)),
        };
        session.establish(options).await
    }

    async fn establish(
        mut self,
        options: HostedSessionOptions,
    ) -> anyhow::Result<(Self, HostedSessionOpened)> {
        let live = match &options.session_path {
            Some(path) => self.live_session_for_file(path).await?,
            None => None,
        };
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
                config: Some(options.create_config.clone()),
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

    /// Run one prompt to its settled turn (`prompt_and_wait`). A turn that
    /// outlives the supervisor's route budget is still running: when an
    /// agent run started on the wire after the prompt was sent, the client
    /// waits for the session to go idle instead of failing it.
    ///
    /// # Errors
    ///
    /// Returns the prompt's rejection (the worker's admission or settle
    /// error), the route budget's timeout when no run started after the
    /// prompt (the same failure answers a prompt that never reached the
    /// worker, so nothing proves it ran), or a transport failure.
    pub async fn prompt(&self, prompt: HostedPrompt) -> anyhow::Result<()> {
        let images = (!prompt.images.is_empty())
            .then(|| serde_json::to_value(&prompt.images))
            .transpose()?;
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
                admission_id: None,
                rlm_notice_nonce: None,
            },
            rest: Map::default(),
        };
        let runs_before = self.runs_started_on_wire.load(Ordering::SeqCst);
        let response = self
            .link
            .request(command, ResponseWait::UntilAnswered)
            .await?;
        if is_route_timeout(&response) {
            if self.runs_started_on_wire.load(Ordering::SeqCst) == runs_before {
                anyhow::bail!(
                    "{SESSION_WORKER_TIMED_OUT} before the prompt was seen to start; it may not have run"
                );
            }
            self.idle_status().await?;
            return Ok(());
        }
        success_data(response).map(|_| ())
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
    /// Each message decodes on its own: a row the session types do not
    /// model (an in-process run's harness digest carries an ISO timestamp)
    /// is skipped, like the in-process terminal selection drops what its
    /// round trip cannot carry, instead of failing the whole read.
    ///
    /// # Errors
    ///
    /// Returns the daemon's refusal or a transport failure.
    pub async fn messages(&self) -> anyhow::Result<Vec<pa_types::session::AgentMessage>> {
        let command = DaemonCommand::GetMessages {
            id: None,
            active_session_id: self.active_session_id.clone(),
            rest: Map::default(),
        };
        let data = success_data(self.link.request(command, REQUEST_BOUND).await?)?;
        Ok(data
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|message| serde_json::from_value(message.clone()).ok())
            .collect())
    }

    /// Leave the session running: detach (bounded), then close the
    /// connection. Never kills or completes the resident session.
    pub async fn close(&self) {
        let detach = DaemonCommand::Detach {
            id: None,
            active_session_id: Some(self.active_session_id.clone()),
            rest: Map::default(),
        };
        let _ = self.link.request(detach, DETACH_BOUND).await;
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
