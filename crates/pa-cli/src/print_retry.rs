//! In-process print cancellation and output composition over pa-core retries.

use std::sync::Arc;

use pa_agent::abort::{AbortController, AbortSignal};
use pa_agent::types::{AssistantMessage, ImageContent};
use pa_core::session_engine::auto_retry::{AutoRetryEvent, RetryStartReason};
use pa_core::session_engine::engine::SessionEngine;
use pa_core::session_engine::provider_retry::ProviderRetryPolicy;
use pa_core::session_engine::turn_retry::RetryUpdate;
use pa_types::ai::Model;

fn print_retry_update(update: RetryUpdate, json_mode: bool) {
    if !json_mode {
        return;
    }
    let wire = match update.event {
        AutoRetryEvent::Start {
            attempt,
            max_attempts,
            delay_ms,
            error_message,
            reason,
        } => {
            let mut wire = serde_json::json!({
                "type": "auto_retry_start", "attempt": attempt,
                "maxAttempts": max_attempts, "delayMs": delay_ms, "errorMessage": error_message,
            });
            match reason {
                RetryStartReason::Quick => {}
                RetryStartReason::ConnectionReset => {
                    wire["reason"] = "connection_reset".into();
                }
                RetryStartReason::Backup { backup_model } => {
                    wire["reason"] = "backup".into();
                    wire["backupModel"] = backup_model.into();
                }
            }
            wire
        }
        AutoRetryEvent::End {
            success,
            attempt,
            final_error,
            restored_model,
        } => {
            let mut wire = serde_json::json!({"type": "auto_retry_end", "success": success, "attempt": attempt});
            if let Some(error) = final_error {
                wire["finalError"] = error.into();
            }
            if let Some(model) = restored_model {
                wire["restoredModel"] = model.into();
            }
            wire
        }
    };
    println!("{wire}");
    if let Some(row) = update.outcome {
        println!(
            "{}",
            serde_json::json!({"type": "message_start", "message": row})
        );
        println!(
            "{}",
            serde_json::json!({"type": "message_end", "message": row})
        );
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_prompt_with_signal<E, EF>(
    engine: &Arc<SessionEngine>,
    model: &Model,
    prompt: &str,
    images: &[ImageContent],
    policy: &ProviderRetryPolicy,
    signal: &AbortSignal,
    emit: E,
) -> anyhow::Result<AssistantMessage>
where
    E: Fn(RetryUpdate) -> EF + Send + Sync + 'static,
    EF: std::future::Future<Output = anyhow::Result<()>> + Send,
{
    engine
        .run_prompt_with_retry(model.context_window, prompt, images, policy, signal, emit)
        .await
}

pub(super) async fn run_prompt(
    engine: &Arc<SessionEngine>,
    model: &Model,
    prompt: &str,
    images: &[ImageContent],
    policy: &ProviderRetryPolicy,
    json_mode: bool,
) -> anyhow::Result<()> {
    let controller = AbortController::new();
    let signal = controller.signal();
    let run = run_prompt_with_signal(
        engine,
        model,
        prompt,
        images,
        policy,
        &signal,
        move |update| {
            print_retry_update(update, json_mode);
            std::future::ready(Ok(()))
        },
    );
    tokio::pin!(run);
    let message = tokio::select! {
        result = &mut run => result?,
        interrupted = tokio::signal::ctrl_c() => {
            interrupted?;
            controller.abort();
            run.await?
        }
    };
    if message.stop_reason == pa_agent::types::StopReason::Aborted {
        return Err(pa_agent::abort::aborted_error());
    }
    Ok(())
}

#[cfg(test)]
#[path = "print_retry_tests.rs"]
mod tests;
