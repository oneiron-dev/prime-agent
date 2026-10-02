//! The create command's session policy at the worker: an offline session
//! never runs on a worker that was launched online (its supervisor puts
//! `PI_OFFLINE` in the launch env; this process's environment is never
//! switched afterwards). The test process runs without `PI_OFFLINE`, the
//! state of a worker whose launch env missed it.

use std::path::PathBuf;

use super::*;
use crate::worker::WorkerConfig;

#[tokio::test]
async fn an_offline_create_is_refused_by_a_worker_launched_online() {
    assert!(
        !crate::session_policy::process_is_offline(),
        "the test process must run without PI_OFFLINE"
    );
    let dir = tempfile::tempdir().unwrap();
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&session_dir).unwrap();
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "policy-test".into(),
            worker_instance_id: String::new(),
            active_session_id: "policy-offline".into(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: Some(true),
            script: Some(json!({"responses":[]})),
        },
        None,
    );
    let refused = worker
        .dispatch(
            "create",
            &json!({"cwd": "/tmp", "sessionDir": session_dir, "offline": true, "noSkills": true}),
        )
        .await;
    assert_eq!(
        (refused.success, refused.error.as_deref()),
        (
            false,
            Some(
                "Invalid create config: the session is offline, but this worker was not launched with PI_OFFLINE"
            )
        )
    );
    assert_eq!(
        std::fs::read_dir(&session_dir).unwrap().count(),
        0,
        "the refused create wrote no session file"
    );
    // The same worker serves an online create under the same policy keys.
    let created = worker
        .dispatch(
            "create",
            &json!({"cwd": "/tmp", "sessionDir": session_dir, "offline": false, "noSkills": true}),
        )
        .await;
    assert!(created.success, "{created:?}");
    let killed = worker.dispatch("kill", &json!({})).await;
    assert!(killed.success, "{killed:?}");
}
