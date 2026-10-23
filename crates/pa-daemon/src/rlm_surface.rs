//! The RLM child-management surface: the worker arms for
//! `cancel_rlm_child`, `delete_rlm_subagent`, and `set_rlm_max_depth`,
//! plus the fork's `get_subagent_model_status`/`set_subagent_model`.
//! Each handler answers the exact TS wire shape; the behavior lives in
//! the engine seams and the supervisor-backed children registry.

use serde_json::{json, Value};

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

impl Worker {
    /// `cancel_rlm_child`: cancel one live child run by id. The TS wire contract is `{ cancelled:
    /// boolean }` - an unknown or already-settled child id answers `false`, never an error.
    pub(crate) async fn handle_cancel_rlm_child(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("cancel_rlm_child") {
            return response;
        }
        let Some(child_id) = payload.get("childId").and_then(Value::as_str) else {
            return response_failure(
                None,
                "cancel_rlm_child",
                "cancel_rlm_child requires a childId",
                None,
            );
        };
        let cancelled = self.engine.cancel_rlm_child(child_id).await;
        response_success(
            None,
            "cancel_rlm_child",
            Some(json!({ "cancelled": cancelled })),
        )
    }

    /// `delete_rlm_subagent`: delete one inactive child by id. The TS
    /// wire contract is `{ deleted: boolean }`, plus `reason: "running"`
    /// when a live child refused the delete; a teardown failure surfaces as the command failure.
    pub(crate) async fn handle_delete_rlm_subagent(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("delete_rlm_subagent") {
            return response;
        }
        let Some(child_id) = payload.get("childId").and_then(Value::as_str) else {
            return response_failure(
                None,
                "delete_rlm_subagent",
                "delete_rlm_subagent requires a childId",
                None,
            );
        };
        match self.engine.delete_rlm_subagent(child_id).await {
            Ok("deleted") => response_success(
                None,
                "delete_rlm_subagent",
                Some(json!({ "deleted": true })),
            ),
            Ok("running") => response_success(
                None,
                "delete_rlm_subagent",
                Some(json!({ "deleted": false, "reason": "running" })),
            ),
            Ok(_) => response_success(
                None,
                "delete_rlm_subagent",
                Some(json!({ "deleted": false })),
            ),
            Err(error) => response_failure(None, "delete_rlm_subagent", &error.to_string(), None),
        }
    }

    /// `set_rlm_max_depth`: set the session's recursion bound, optionally persisting it as the
    /// global settings default. The response is the TS `SetRlmMaxDepthResult` wire object.
    pub(crate) async fn handle_set_rlm_max_depth(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_rlm_max_depth") {
            return response;
        }
        let Some(max_depth) = payload.get("maxDepth").and_then(Value::as_u64) else {
            return response_failure(
                None,
                "set_rlm_max_depth",
                "RLM max depth must be a non-negative integer.",
                None,
            );
        };
        let global = payload.get("global").and_then(Value::as_bool) == Some(true);
        // The engine call blocks on the engine runtime (the durable
        // `rlm_max_depth_state` write takes the engine session lock), so it
        // runs on a blocking thread — a direct call would `block_on` from
        // inside the worker's runtime and die.
        let engine = std::sync::Arc::clone(&self.engine);
        let result =
            tokio::task::spawn_blocking(move || engine.set_rlm_max_depth(max_depth, global))
                .await
                .unwrap_or_else(|error| Err(anyhow::anyhow!("RLM max depth task failed: {error}")));
        match result {
            Ok(result) => response_success(None, "set_rlm_max_depth", Some(result)),
            Err(error) => response_failure(None, "set_rlm_max_depth", &error.to_string(), None),
        }
    }

    /// `get_subagent_model_status` (fork-only): the helper model and thinking level this
    /// session's spawns resolve to when the call names none, with the layer each came from.
    pub(crate) async fn handle_get_subagent_model_status(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_subagent_model_status") {
            return response;
        }
        // The status reads the settings file and the model catalog: off the worker's runtime.
        let engine = std::sync::Arc::clone(&self.engine);
        match tokio::task::spawn_blocking(move || engine.subagent_model_status()).await {
            Ok(status) => response_success(None, "get_subagent_model_status", Some(status)),
            Err(error) => response_failure(
                None,
                "get_subagent_model_status",
                &format!("helper model status task failed: {error}"),
                None,
            ),
        }
    }

    /// `set_subagent_model` (fork-only): replace this session's helper-model override with
    /// `{ model, thinking }` (an absent or null field leaves it to the settings file; `parent`
    /// keeps the parent's value) and answer the resulting status. The override persists in the
    /// session file; an unknown model is kept and reported as `modelKnown: false`.
    pub(crate) async fn handle_set_subagent_model(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_subagent_model") {
            return response;
        }
        let field = |key: &str| payload.get(key).and_then(Value::as_str);
        let layer = match pa_core::session_engine::helper_model::HelperDefaults::new(
            field("model"),
            field("thinking"),
        ) {
            Ok(layer) => layer,
            Err(error) => return response_failure(None, "set_subagent_model", &error, None),
        };
        // The durable entry write blocks on the engine runtime: a blocking thread, as
        // `set_rlm_max_depth`.
        let engine = std::sync::Arc::clone(&self.engine);
        let result = tokio::task::spawn_blocking(move || engine.set_subagent_model(layer))
            .await
            .unwrap_or_else(|error| Err(anyhow::anyhow!("helper model task failed: {error}")));
        match result {
            Ok(status) => response_success(None, "set_subagent_model", Some(status)),
            Err(error) => response_failure(None, "set_subagent_model", &error.to_string(), None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    async fn created_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-rlm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "rlm-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "rlm-surface" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    #[tokio::test]
    async fn cancel_rlm_child_answers_the_ts_cancelled_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "cancel_rlm_child",
                &json!({ "activeSessionId": "rlm-session", "childId": "ghost-child" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(response.data, Some(json!({ "cancelled": false })));
    }

    #[tokio::test]
    async fn delete_rlm_subagent_answers_the_ts_not_found_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "delete_rlm_subagent",
                &json!({ "activeSessionId": "rlm-session", "childId": "ghost-child" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(response.data, Some(json!({ "deleted": false })));
    }

    #[tokio::test]
    async fn set_rlm_max_depth_answers_the_ts_result_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "set_rlm_max_depth",
                &json!({ "activeSessionId": "rlm-session", "maxDepth": 3 }),
            )
            .await;
        assert!(response.success);
        assert_eq!(
            response.data,
            Some(json!({ "maxDepth": 3, "source": "chat", "globalSaved": false }))
        );

        let status = worker
            .dispatch(
                "get_rlm_max_depth_status",
                &json!({ "activeSessionId": "rlm-session" }),
            )
            .await;
        assert!(status.success);

        // The scripted harness engine owns no settings surface, so a
        // `global: true` request answers `globalSaved: false` (the real
        // agent engine writes the settings default and answers `true`).
        let response = worker
            .dispatch(
                "set_rlm_max_depth",
                &json!({ "activeSessionId": "rlm-session", "maxDepth": 4, "global": true }),
            )
            .await;
        assert!(response.success);
        assert_eq!(
            response.data,
            Some(json!({ "maxDepth": 4, "source": "chat", "globalSaved": false }))
        );
    }

    #[tokio::test]
    async fn missing_required_fields_fail() {
        let worker = created_worker().await;
        for command_type in ["cancel_rlm_child", "delete_rlm_subagent"] {
            let response = worker
                .dispatch(command_type, &json!({ "activeSessionId": "s" }))
                .await;
            assert!(
                !response.success,
                "{command_type} must fail without childId"
            );
        }
        let response = worker
            .dispatch("set_rlm_max_depth", &json!({ "activeSessionId": "s" }))
            .await;
        assert!(!response.success);
        assert_eq!(
            response.error.as_deref(),
            Some("RLM max depth must be a non-negative integer.")
        );
    }
}
