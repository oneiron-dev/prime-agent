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
    /// keeps the parent's value) and answer the resulting status. The override persists as a
    /// `subagent_model_state` row in the session file; an unknown model is kept and reported as
    /// `modelKnown: false`.
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
        // The live override and its durable row change together under the core lock, so
        // concurrent setters (and a session replacement's store swap) leave the latest row equal
        // to the live value. The row goes to the worker-owned session file (a cleared override is
        // a row too): a resume, a respawn or an idle wake re-seeds from it. A session without a
        // file keeps the override for this worker only.
        {
            let mut core = self.core.lock().unwrap();
            let row = pa_core::session_engine::helper_model::session_override_row(&layer);
            if let Err(error) = self.engine.set_subagent_model(layer) {
                return response_failure(None, "set_subagent_model", &error.to_string(), None);
            }
            if let Some(store) = core.store.as_mut() {
                if let Err(error) = store.persist_entry("custom", row) {
                    return response_failure(
                        None,
                        "set_subagent_model",
                        &format!(
                            "the helper model applies to this worker but was not saved: {error}"
                        ),
                        None,
                    );
                }
            }
        }
        // The status reads the settings file and the model catalog: off the worker's runtime.
        let engine = std::sync::Arc::clone(&self.engine);
        let status = match tokio::task::spawn_blocking(move || engine.subagent_model_status()).await
        {
            Ok(status) => status,
            Err(error) => {
                return response_failure(
                    None,
                    "set_subagent_model",
                    &format!("helper model status task failed: {error}"),
                    None,
                )
            }
        };
        response_success(None, "set_subagent_model", Some(status))
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

    /// A real-agent worker (the faux engine) over an existing session file, so the durable store
    /// writes straight to it.
    async fn agent_worker_at(root: &std::path::Path, extra: &serde_json::Value) -> Arc<Worker> {
        std::fs::create_dir_all(root).unwrap();
        let file = root.join("session.jsonl");
        if !file.exists() {
            std::fs::write(
                &file,
                json!({
                    "type": "session", "version": 3, "id": "helper-file",
                    "timestamp": "2026-01-01T00:00:00.000Z", "cwd": root.display().to_string(),
                })
                .to_string()
                    + "\n",
            )
            .unwrap();
        }
        let config = crate::worker::WorkerConfig {
            socket_path: root.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "helper-session".to_string(),
            agent_dir: root.join("agent"),
            recovery_journal_path: root.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "engine": "faux", "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let mut create = json!({
            "sessionPath": file.display().to_string(),
            "cwd": root.display().to_string(),
        });
        if let (Some(create), Some(extra)) = (create.as_object_mut(), extra.as_object()) {
            create.extend(extra.clone());
        }
        let created = worker.dispatch("create", &create).await;
        assert!(created.success, "create failed: {created:?}");
        assert!(
            worker.agent_engine.is_some(),
            "the faux script builds the agent engine"
        );
        worker
    }

    /// The rows the session file holds, as the layer each one sets.
    fn override_rows(
        root: &std::path::Path,
    ) -> Vec<pa_core::session_engine::helper_model::HelperDefaults> {
        std::fs::read_to_string(root.join("session.jsonl"))
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|entry| entry["customType"] == "subagent_model_state")
            .map(|entry| {
                pa_core::session_engine::helper_model::HelperDefaults::new(
                    entry["data"]["model"].as_str(),
                    entry["data"]["thinking"].as_str(),
                )
                .unwrap()
            })
            .collect()
    }

    /// `set_subagent_model` writes its row to the worker-owned session file (the row a resume,
    /// respawn or wake re-seeds from); a clear is a row too. The scripted harness engine refuses
    /// and writes nothing.
    #[tokio::test]
    async fn set_subagent_model_persists_its_row_in_the_session_file() {
        use pa_core::session_engine::helper_model::HelperDefaults;
        let root = std::env::temp_dir().join(format!("pa-worker-helper-{}", uuid::Uuid::new_v4()));
        let worker = agent_worker_at(&root, &json!({})).await;
        let set = worker
            .dispatch(
                "set_subagent_model",
                &json!({ "activeSessionId": "helper-session", "model": "parent", "thinking": "max" }),
            )
            .await;
        assert!(set.success, "{set:?}");
        assert_eq!(
            set.data.as_ref().map(|status| status["session"].clone()),
            Some(json!({ "model": "parent", "thinking": "max" }))
        );
        let status = worker
            .dispatch(
                "get_subagent_model_status",
                &json!({ "activeSessionId": "helper-session" }),
            )
            .await;
        assert_eq!(status.data, set.data);
        let cleared = worker
            .dispatch(
                "set_subagent_model",
                &json!({ "activeSessionId": "helper-session" }),
            )
            .await;
        assert!(cleared.success, "{cleared:?}");
        assert_eq!(
            override_rows(&root),
            vec![
                HelperDefaults::new(Some("parent"), Some("max")).unwrap(),
                HelperDefaults::default(),
            ]
        );
        let invalid = worker
            .dispatch(
                "set_subagent_model",
                &json!({ "activeSessionId": "helper-session", "thinking": "loud" }),
            )
            .await;
        assert!(!invalid.success);
        assert_eq!(override_rows(&root).len(), 2);
        // No settings surface, no row.
        let scripted = created_worker().await;
        let refused = scripted
            .dispatch(
                "set_subagent_model",
                &json!({ "activeSessionId": "rlm-session", "model": "parent" }),
            )
            .await;
        assert!(!refused.success);
    }

    /// An RLM child's inherited override (`subagentModel`/`subagentThinking` on its create) is
    /// written once as the file's birth row and seeds the session; a respawn over a file that
    /// already holds a row (a later choice) keeps that row.
    #[tokio::test]
    async fn an_inherited_override_is_written_once_as_the_birth_row() {
        use pa_core::session_engine::helper_model::HelperDefaults;
        let root = std::env::temp_dir().join(format!("pa-worker-birth-{}", uuid::Uuid::new_v4()));
        let inherited = json!({ "subagentModel": "parent", "subagentThinking": "low" });
        let worker = agent_worker_at(&root, &inherited).await;
        let birth = HelperDefaults::new(Some("parent"), Some("low")).unwrap();
        assert_eq!(override_rows(&root), vec![birth.clone()]);
        let status = worker
            .dispatch(
                "get_subagent_model_status",
                &json!({ "activeSessionId": "helper-session" }),
            )
            .await;
        assert_eq!(
            status.data.map(|status| status["session"].clone()),
            Some(json!({ "model": "parent", "thinking": "low" }))
        );
        // A create over a file that already holds a row (a respawn replaying the keys; a copy,
        // since the first worker keeps the file's runtime lease) adds no row.
        let replay = root.join("replay");
        std::fs::create_dir_all(&replay).unwrap();
        std::fs::copy(root.join("session.jsonl"), replay.join("session.jsonl")).unwrap();
        let replayed = agent_worker_at(&replay, &inherited).await;
        assert_eq!(override_rows(&replay), vec![birth]);
        drop((worker, replayed));
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
