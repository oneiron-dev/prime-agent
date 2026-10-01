//! The manager's memory half without a kernel: owed notices, the ready
//! features gate, the out-of-band reply routing, the runtime records.

use serde_json::json;

use super::super::InternalExecuteResult;
use super::*;
use crate::kernel::protocol::Event;
use crate::kernel::shared::KernelManagerOptions;

fn manager() -> ReplKernelManager {
    ReplKernelManager::new(KernelManagerOptions::default())
}

#[test]
fn owed_notices_split_into_the_queued_and_the_current_cells_own() {
    let manager = manager();
    manager
        .inner
        .note_memory("idle child".into(), NoticePlacement::Queued);
    manager
        .inner
        .note_memory("cell trim".into(), NoticePlacement::Current);
    manager
        .inner
        .note_memory("idle trim".into(), NoticePlacement::Queued);
    let mut result = InternalExecuteResult::aborted(Instant::now()).result;
    manager.inner.take_memory_notices(&mut result);
    assert_eq!(
        (result.queued_memory_notices, result.memory_notices),
        (
            Some(vec!["idle child".to_string(), "idle trim".to_string()]),
            Some(vec!["cell trim".to_string()])
        )
    );
    // Consumed once: the next result carries none.
    let mut next = InternalExecuteResult::aborted(Instant::now()).result;
    manager.inner.take_memory_notices(&mut next);
    assert_eq!(
        (next.queued_memory_notices, next.memory_notices),
        (None, None)
    );
}

#[test]
fn optional_requests_are_gated_on_the_ready_features() {
    let manager = manager();
    let notice = Request::MemoryNotice {
        pids: vec![1],
        text: String::new(),
    };
    let report = Request::MemoryReport { count: 30 };
    assert_eq!(
        (
            manager.inner.has_feature(&notice),
            manager.inner.has_feature(&report)
        ),
        (false, false)
    );
    manager.inner.handle_event(Event::Ready {
        protocol: 3,
        features: vec!["memory_notice".into(), "trim_memory".into()],
    });
    assert_eq!(
        (
            manager.inner.has_feature(&notice),
            manager.inner.has_feature(&report)
        ),
        (true, false)
    );
}

#[test]
fn a_done_outside_the_active_execution_hands_its_fields_to_the_waiter() {
    let manager = manager();
    let (tx, mut rx) = oneshot::channel();
    lock(&manager.inner.guarded)
        .pending_done_waiters
        .insert("n1".into(), tx);
    let fields =
        json!({"event": "done", "id": "n1", "status": "ok", "matched": true, "awaited": true});
    manager.inner.handle_event(Event::Done {
        id: "n1".into(),
        fields: fields.clone(),
    });
    assert_eq!(rx.try_recv().ok(), Some(fields));
}

#[test]
fn trim_without_the_runtime_feature_leaves_the_last_step_to_decide() {
    let manager = manager();
    let usage = KernelTreeUsage {
        kernel_pid: 1,
        kernel_bytes: 10,
        total_bytes: 10,
        units: Vec::new(),
    };
    Arc::clone(&manager.inner).trim_memory(5, &usage);
    assert!(lock(&manager.inner.guarded).memory.pending_trim.is_none());
    assert!(manager
        .kernel_stderr()
        .contains("[kernel] memory variable-step unavailable: the kernel runtime has no trim_memory; the last step decides"));
}

#[test]
fn runtime_records_parse_like_the_ts_host() {
    let records = json!([
        {"name": "frames", "bytes": 1024, "type": "ndarray", "shape": [2, 3], "dtype": "uint8"},
        {"name": "clips", "bytes": 10, "type": "list", "length": 4},
        {"name": "untyped", "bytes": 5},
        {"name": "bad shape", "bytes": 5, "type": "x", "shape": [1, "2"]},
        {"name": "no bytes", "type": "int"},
        {"bytes": 3},
        "junk",
    ]);
    let variable = |name: &str, bytes: f64, type_name: &str| SizedVariable {
        name: name.to_string(),
        bytes,
        type_name: type_name.to_string(),
        shape: None,
        dtype: None,
        length: None,
    };
    assert_eq!(
        as_sized_array(Some(&records)),
        vec![
            SizedVariable {
                shape: Some(vec![2, 3]),
                dtype: Some("uint8".into()),
                ..variable("frames", 1024.0, "ndarray")
            },
            SizedVariable {
                length: Some(4),
                ..variable("clips", 10.0, "list")
            },
            variable("untyped", 5.0, "object"),
            variable("bad shape", 5.0, "x"),
        ]
    );
    assert_eq!(
        (
            as_count(Some(&json!(7))),
            as_count(Some(&json!(-1))),
            as_count(Some(&json!("7"))),
            as_count(None)
        ),
        (7, 0, 0, 0)
    );
}
