//! The helper-model override's durable entry: the `subagent_model_state` custom row a resumed or
//! woken session re-seeds its override from (the `rlm_max_depth_state` pattern).
use pa_core::session_engine::helper_model::{
    session_override_row_data, HelperDefaults, SUBAGENT_MODEL_STATE_CUSTOM_TYPE,
};

use super::AgentSessionEngine;

impl AgentSessionEngine {
    /// Write the durable `subagent_model_state` entry: straight into the built session's
    /// persistence handle, or parked for the build. Blocks on the engine runtime when the session
    /// is built, so a worker command calls it from a blocking thread.
    pub(super) fn persist_subagent_override(&self, layer: &HelperDefaults) {
        let handles = self.goal_runtime.lock().expect("goal runtime lock").clone();
        match handles {
            Some(handles) => {
                let mut manager = self
                    .runtime
                    .block_on(async { handles.session.lock().await });
                if let Err(error) = manager.append_custom_entry(
                    SUBAGENT_MODEL_STATE_CUSTOM_TYPE,
                    Some(session_override_row_data(layer)),
                ) {
                    eprintln!("pa-daemon: failed to persist subagent_model_state: {error:#}");
                }
            }
            None => self.park_subagent_override(layer),
        }
    }

    /// Park the durable entry until the session builds (a create seeds its override before the
    /// first build).
    pub(super) fn park_subagent_override(&self, layer: &HelperDefaults) {
        *self
            .pending_subagent_override
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(layer.clone());
    }

    /// Flush a parked `subagent_model_state` entry once the session built.
    pub(super) fn flush_pending_subagent_override(
        &self,
        manager: &mut pa_core::session::manager::SessionManager,
    ) {
        let pending = self
            .pending_subagent_override
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(layer) = pending {
            if let Err(error) = manager.append_custom_entry(
                SUBAGENT_MODEL_STATE_CUSTOM_TYPE,
                Some(session_override_row_data(&layer)),
            ) {
                eprintln!("pa-daemon: failed to flush pending subagent_model_state: {error:#}");
            }
        }
    }
}
