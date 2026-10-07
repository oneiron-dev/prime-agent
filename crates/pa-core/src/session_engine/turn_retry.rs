//! Session-owned retry lifecycle for direct prompts and embedding hosts.

use std::future::Future;
use std::sync::{Arc, Mutex};

use pa_agent::abort::{throw_if_aborted, AbortSignal};
use pa_agent::types::{
    AgentEvent, AgentMessage, AssistantMessage, ImageContent, Message, StopReason,
};
use pa_types::session::CustomMessage;

use super::auto_retry::{run_turn_with_auto_retry, AutoRetryEvent, RetryEpisode};
use super::engine::SessionEngine;
use super::provider_adapter::json_round_trip;
use super::provider_retry::ProviderRetryPolicy;
use super::semantic_edges::SemanticEdgeRecorder;
use super::{AgentSession, PromptOptions, TrailingAssistantFilter};

/// A turn's semantic retry lifetime. Dropping the scope clears parking on
/// success, cancellation, callback errors, and abandoned outer futures.
pub struct RetryScope {
    recorder: Option<Arc<SemanticEdgeRecorder>>,
}

impl RetryScope {
    /// Apply the retry event's semantic transition before its host output.
    pub fn observe(&self, event: &AutoRetryEvent) {
        if let Some(recorder) = &self.recorder {
            match event {
                AutoRetryEvent::Start { .. } => recorder.prepare_turn_retry(),
                AutoRetryEvent::End { .. } => recorder.clear_turn_retry(),
            }
        }
    }

    /// A committed assistant generation retires parking even when a
    /// provider restore holds its visible retry-end event until turn end.
    pub fn settle_success(&self) {
        if let Some(recorder) = &self.recorder {
            recorder.clear_turn_retry();
        }
    }
}

impl Drop for RetryScope {
    fn drop(&mut self) {
        self.settle_success();
    }
}

impl AgentSession {
    /// Begin the semantic retry lifetime of one outer model turn. Hosts
    /// keep this scope until every attempt, event, and restore has settled.
    #[must_use]
    pub fn retry_scope(&self) -> RetryScope {
        RetryScope {
            recorder: self.semantic_edges(),
        }
    }
}

/// A session retry event and its already-persisted outcome row. Embeddings
/// project these onto their existing wire/output surfaces only.
pub struct RetryUpdate {
    pub event: AutoRetryEvent,
    pub outcome: Option<CustomMessage>,
}

struct RetrySurface<E> {
    engine: Arc<SessionEngine>,
    scope: RetryScope,
    last_error: Mutex<String>,
    emit: E,
}

impl<E, EF> RetrySurface<E>
where
    E: Fn(RetryUpdate) -> EF,
    EF: Future<Output = anyhow::Result<()>>,
{
    #[tracing::instrument(skip_all)]
    async fn emit(&self, event: AutoRetryEvent) -> anyhow::Result<()> {
        self.scope.observe(&event);
        if let Some(telemetry) = &self.engine.telemetry {
            telemetry.note_auto_retry_event(&event);
        }
        let outcome = match &event {
            AutoRetryEvent::Start { error_message, .. } => {
                self.last_error
                    .lock()
                    .expect("retry error lock")
                    .clone_from(error_message);
                None
            }
            AutoRetryEvent::End {
                success,
                attempt,
                final_error,
                ..
            } => {
                let error = final_error.clone().unwrap_or_else(|| {
                    std::mem::take(&mut *self.last_error.lock().expect("retry error lock"))
                });
                let row = super::messages::create_provider_retry_outcome_message(
                    *success, *attempt, &error,
                );
                self.engine
                    .session
                    .shared_persistence()
                    .lock()
                    .await
                    .append_custom_message(
                        &row.custom_type,
                        row.content.clone(),
                        row.display,
                        row.details.clone(),
                    )?;
                Some(row)
            }
        };
        (self.emit)(RetryUpdate { event, outcome }).await
    }
}

impl SessionEngine {
    /// Admit a direct prompt once, retry from committed history, and persist
    /// retry outcomes in the session owner. The invocation signal cancels
    /// both active requests and idle retry waits; output belongs to `emit`.
    ///
    /// # Errors
    /// Returns admission, attempt, persistence or output callback errors.
    #[tracing::instrument(skip_all)]
    #[allow(clippy::too_many_arguments)]
    pub async fn run_prompt_with_retry<E, EF>(
        self: &Arc<Self>,
        context_window: u64,
        prompt: &str,
        images: &[ImageContent],
        policy: &ProviderRetryPolicy,
        signal: &AbortSignal,
        emit: E,
    ) -> anyhow::Result<AssistantMessage>
    where
        E: Fn(RetryUpdate) -> EF + Send + Sync + 'static,
        EF: Future<Output = anyhow::Result<()>> + Send,
    {
        throw_if_aborted(signal)?;
        let outer_scope = self.session.retry_scope();
        let episode = Arc::new(RetryEpisode::default());
        let surface = Arc::new(RetrySurface {
            engine: Arc::clone(self),
            scope: self.session.retry_scope(),
            last_error: Mutex::new(String::new()),
            emit,
        });
        let subscription = self
            .session
            .agent()
            .subscribe({
                let episode = Arc::clone(&episode);
                let surface = Arc::clone(&surface);
                move |event, _signal| {
                    let episode = Arc::clone(&episode);
                    let surface = Arc::clone(&surface);
                    Box::pin(async move {
                        let succeeded = matches!(&event, AgentEvent::MessageEnd {
                        message: AgentMessage::Standard(Message::Assistant(message)),
                    } if !matches!(message.stop_reason, StopReason::Error | StopReason::Aborted));
                        if succeeded {
                            surface.scope.settle_success();
                            if let Some(end) = episode.settle_success() {
                                surface.emit(end).await?;
                            }
                        }
                        Ok(())
                    })
                }
            })
            .await;
        let first_attempt = std::cell::Cell::new(true);
        let result = run_turn_with_auto_retry(
            policy,
            context_window,
            Some(signal),
            &episode,
            || async {
                // The same invocation owns cancellation across agent runs.
                // An idle agent's abort alone cannot cancel its retry wait.
                throw_if_aborted(signal)?;
                let attempt = async {
                    throw_if_aborted(signal)?;
                    if first_attempt.replace(false) {
                        self.session
                            .prompt_with_images(prompt, images.to_vec(), PromptOptions::default())
                            .await?;
                    } else {
                        self.session
                            .drop_trailing_assistant(TrailingAssistantFilter::ErrorOnly)
                            .await;
                        throw_if_aborted(signal)?;
                        self.session.agent().continue_run().await?;
                    }
                    self.session.agent().wait_for_idle().await;
                    Ok::<(), anyhow::Error>(())
                };
                tokio::pin!(attempt);
                tokio::select! {
                    biased;
                    () = signal.aborted() => {
                        self.session.agent().abort();
                        attempt.await?;
                    }
                    result = &mut attempt => result?,
                }
                self.session
                    .last_assistant_message()
                    .await
                    .and_then(|message| json_round_trip(&message))
                    .ok_or_else(|| anyhow::anyhow!("No response produced."))
            },
            |event| surface.emit(event),
            |delay| async move {
                tokio::select! {
                    biased;
                    () = signal.aborted() => false,
                    () = tokio::time::sleep(delay) => !signal.is_aborted(),
                }
            },
            None,
        )
        .await;
        subscription.unsubscribe().await;
        drop(outer_scope);
        result
    }
}

#[cfg(test)]
mod tests;
