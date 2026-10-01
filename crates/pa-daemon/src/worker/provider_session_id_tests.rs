//! The provider session id across the worker's session swaps: every
//! built core engine's provider requests carry the worker-owned
//! session's durable id (the store header's), never the engine's
//! in-memory manager id — at create, after a fork, and after a switch
//! back onto an existing file. TS anchor: `sdk.ts` passes
//! `sessionManager.getSessionId()` into the Agent, and every replacement
//! rebuilds the runtime over the moved-to session manager.
use super::*;

/// The faux provider registration is process-global: the lock must span
/// the awaited turns that consume its queue.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn provider_requests_carry_the_worker_owned_session_id() {
    let _faux = crate::agent_engine::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let sessions_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let config = WorkerConfig {
        socket_path: dir.path().join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "provider-id-session".to_string(),
        agent_dir: dir.path().join("agent"),
        recovery_journal_path: dir.path().join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "engine": "faux", "responses": [{ "text": "unused" }] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    let engine = Arc::clone(
        worker
            .agent_engine
            .as_ref()
            .expect("faux script drives the real engine"),
    );
    // Resolve (and so register) the script's faux provider up front, then
    // replace the `faux` api with a provider that records each request's
    // session id: every later resolution reuses the cached model, so the
    // session's turns stream through the recorder.
    engine.resolve_model().expect("faux model");
    let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = {
        let seen = Arc::clone(&seen);
        pa_ai::faux::FauxResponseStep::Factory(Arc::new(move |_, options, _, _| {
            seen.lock()
                .unwrap()
                .push(options.and_then(|options| options.session_id.clone()));
            Ok(pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ))
        }))
    };
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            api: Some("faux".to_string()),
            provider: Some("faux".to_string()),
            ..Default::default()
        });
    registration.set_responses(vec![recorder]);
    registration.set_repeat_last_response(true);

    let store_identity = || {
        let core = worker.core.lock().unwrap();
        let store = core.store.as_ref().expect("session store");
        (store.session_id().to_string(), store.path.clone())
    };
    let prompt = |message: &'static str| {
        let worker = Arc::clone(&worker);
        async move {
            let prompted = worker
                .dispatch(
                    "prompt_and_wait",
                    &json!({ "activeSessionId": "provider-id-session", "message": message }),
                )
                .await;
            assert!(prompted.success, "prompt failed: {prompted:?}");
        }
    };

    // A created session: the provider sees the new session file's id.
    let created = worker
        .dispatch(
            "create",
            &json!({
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
            }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let (created_id, created_path) = store_identity();
    assert_eq!(
        pa_core::session::manager::read_session_header(&created_path).map(|header| header.id),
        Some(created_id.clone())
    );
    prompt("hello").await;
    let manager_id = {
        let guard = engine.session.lock().await;
        guard
            .as_deref()
            .expect("the turn built the session")
            .session
            .session_id()
            .await
    };
    assert_ne!(manager_id, created_id);
    assert_eq!(*seen.lock().unwrap(), vec![Some(created_id.clone())]);

    // A fork moves onto a new file: the rebuilt session carries its id.
    let user_entry_id = {
        let core = worker.core.lock().unwrap();
        let store = core.store.as_ref().expect("session store");
        store
            .entries()
            .iter()
            .find(|entry| crate::session_tree::user_entry_text(entry).is_some())
            .expect("the prompt's user entry")
            .id
            .clone()
    };
    let forked = worker
        .dispatch(
            "fork",
            &json!({ "activeSessionId": "provider-id-session", "entryId": user_entry_id }),
        )
        .await;
    assert!(forked.success, "fork failed: {forked:?}");
    let (forked_id, forked_path) = store_identity();
    assert_ne!(forked_path, created_path);
    prompt("forked").await;

    // A switch back onto the created file reads its id off the file.
    let switched = worker
        .dispatch(
            "switch_session",
            &json!({
                "activeSessionId": "provider-id-session",
                "sessionPath": created_path.to_string_lossy(),
            }),
        )
        .await;
    assert!(switched.success, "switch failed: {switched:?}");
    prompt("switched").await;
    assert_eq!(
        *seen.lock().unwrap(),
        vec![Some(created_id.clone()), Some(forked_id), Some(created_id)]
    );

    registration.unregister();
    // The worker (and its engine's private runtime) must drop off the
    // async context.
    drop(engine);
    tokio::task::spawn_blocking(move || drop(worker))
        .await
        .expect("worker drop join");
}
