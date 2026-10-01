//! Byte-level parity of every message builder with the TS fork.
//!
//! `ts_parity.json` is the TS authority's own output: the fork's
//! `packages/coding-agent/src/core/kernel/memory-guard.ts` at bf4d2c6ca (its
//! two host-only imports stubbed) run under bun over the inputs rebuilt
//! below, in the same order. A Rust builder that drifts by a byte fails here.

use super::*;

#[derive(serde::Deserialize)]
struct Fixture {
    #[serde(rename = "formatGb")]
    format_gb: Vec<(f64, String)>,
    warning: Vec<String>,
    child: Vec<String>,
    trim: Vec<String>,
    kill: Vec<String>,
    place: Vec<String>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("ts_parity.json")).expect("TS parity fixture parses")
}

fn variable(name: &str, bytes: f64, type_name: &str) -> SizedVariable {
    SizedVariable {
        name: name.to_string(),
        bytes,
        type_name: type_name.to_string(),
        shape: None,
        dtype: None,
        length: None,
    }
}

fn frames() -> SizedVariable {
    SizedVariable {
        shape: Some(vec![200, 1080, 1920, 3]),
        dtype: Some("float64".to_string()),
        ..variable("frames", 9.95 * GIB, "ndarray")
    }
}

fn clips() -> SizedVariable {
    SizedVariable {
        length: Some(200),
        ..variable("clips", 3.1 * GIB, "list")
    }
}

fn line() -> KernelCellLine {
    KernelCellLine {
        lineno: 4,
        source: "frames = np.stack([load(v) for v in videos])".to_string(),
    }
}

#[test]
fn gb_numbers_round_like_js_to_fixed() {
    let fixture = fixture();
    let formatted: Vec<(f64, String)> = fixture
        .format_gb
        .iter()
        .map(|(bytes, _)| (*bytes, format_gb(*bytes)))
        .collect();
    assert_eq!(formatted, fixture.format_gb);
}

#[test]
fn warning_messages_match_the_ts_fork() {
    let small = [
        SizedVariable {
            shape: Some(vec![5_242_880]),
            dtype: Some("uint8".to_string()),
            ..variable("v", 5.0 * 1024.0 * 1024.0, "ndarray")
        },
        variable("n", 28.0, "int"),
        variable("z", 0.0, "NoneType"),
        variable("s", 1536.0, "str"),
        variable("m", 1.5 * 1024.0 * 1024.0, "bytes"),
        SizedVariable {
            length: Some(0),
            ..variable("e", 64.0, "list")
        },
    ];
    let messages = vec![
        memory_warning_message(10.0 * GIB, 16.0 * GIB, &[frames(), clips()]),
        memory_warning_message(9.6 * GIB, 16.0 * GIB, &[]),
        memory_warning_message(0.3 * GIB, 0.5 * GIB, &small),
    ];
    assert_eq!(messages, fixture().warning);
}

/// An empty frame reports an empty dtype; TS `describeType` treats it as
/// absent (`v.dtype ? ... : v.type`), so no stray space appears.
#[test]
fn an_empty_dtype_reads_as_no_dtype() {
    let empty_frame = SizedVariable {
        shape: Some(vec![0, 0]),
        dtype: Some(String::new()),
        ..variable("df", 128.0, "DataFrame")
    };
    assert_eq!(
        describe_variables(&[empty_frame]),
        "df (1 KB, DataFrame, shape (0, 0))"
    );
}

#[test]
fn child_messages_match_the_ts_fork() {
    let child = |name: &'static str, pid: i32, gb: f64| StoppedChild {
        name,
        pid,
        bytes: gb * GIB,
    };
    let messages = vec![
        memory_child_message(&ChildStepContext {
            child: child("python3", 7, 16.02),
            total_bytes: 16.1 * GIB,
            after_bytes: 0.08 * GIB,
            limit_bytes: 16.0 * GIB,
            machine: false,
        }),
        memory_child_message(&ChildStepContext {
            child: child("sort", 9, 9.0),
            total_bytes: 16.0001 * GIB,
            after_bytes: 7.0001 * GIB,
            limit_bytes: 16.0 * GIB,
            machine: false,
        }),
        memory_child_message(&ChildStepContext {
            child: child("sort", 9, 2.0),
            total_bytes: 3.0 * GIB,
            after_bytes: GIB,
            limit_bytes: 16.0 * GIB,
            machine: true,
        }),
        memory_child_message(&ChildStepContext {
            child: child("x", 11, 16.0004),
            total_bytes: 16.0004 * GIB,
            after_bytes: 0.0,
            limit_bytes: 16.0 * GIB,
            machine: false,
        }),
    ];
    assert_eq!(messages, fixture().child);
}

#[test]
fn trim_messages_match_the_ts_fork() {
    let dropped = [frames(), clips()];
    let line = line();
    let trim = |dropped: &[SizedVariable],
                cell_stopped: bool,
                line: Option<&KernelCellLine>,
                after: Option<f64>| {
        memory_trim_message(&TrimStepContext {
            total_bytes: 17.2 * GIB,
            after_bytes: after,
            limit_bytes: 16.0 * GIB,
            dropped,
            cell_stopped,
            line,
        })
    };
    let after = Some(1.2 * GIB);
    let messages = vec![
        trim(&dropped, true, Some(&line), after),
        trim(&dropped, true, None, after),
        trim(&dropped, false, None, after),
        trim(&[], false, None, after),
        trim(&[], true, Some(&line), None),
        memory_trim_message(&TrimStepContext {
            total_bytes: 16.001 * GIB,
            after_bytes: None,
            limit_bytes: 16.0 * GIB,
            dropped: &[frames()],
            cell_stopped: false,
            line: None,
        }),
    ];
    assert_eq!(messages, fixture().trim);
}

#[test]
fn kill_messages_match_the_ts_fork() {
    let line = line();
    let frames_and_n = [frames(), variable("n", 28.0, "int")];
    let only_clips = [clips()];
    let only_frames = [frames()];
    let kill = |total_gb: f64,
                cause: KernelEndCause,
                cell_running: bool,
                line: Option<&KernelCellLine>,
                held: Option<HeldVariables<'_>>| {
        memory_kill_message(&KillStepContext {
            total_bytes: total_gb * GIB,
            limit_bytes: 16.0 * GIB,
            cause,
            cell_running,
            line,
            held,
        })
    };
    let messages = vec![
        kill(
            17.2,
            KernelEndCause::Grace,
            true,
            Some(&line),
            Some(HeldVariables {
                names: &frames_and_n,
                more: 2,
                stale_seconds: None,
            }),
        ),
        kill(17.2, KernelEndCause::Hard, true, None, None),
        kill(
            3.0,
            KernelEndCause::Machine,
            false,
            Some(&line),
            Some(HeldVariables {
                names: &only_clips,
                more: 0,
                stale_seconds: Some(12),
            }),
        ),
        kill(
            17.2,
            KernelEndCause::Machine,
            true,
            Some(&line),
            Some(HeldVariables {
                names: &[],
                more: 0,
                stale_seconds: None,
            }),
        ),
        kill(
            17.2,
            KernelEndCause::Grace,
            false,
            Some(&line),
            Some(HeldVariables {
                names: &only_frames,
                more: 0,
                stale_seconds: Some(0),
            }),
        ),
        kill(24.0001, KernelEndCause::Hard, false, None, None),
    ];
    assert_eq!(messages, fixture().kill);
}

#[test]
fn notices_from_idle_actions_open_the_result_and_the_cells_own_close_it() {
    let strings = |items: &[&str]| items.iter().map(ToString::to_string).collect::<Vec<_>>();
    let placed = vec![
        place_memory_notices("out", &strings(&["idle"]), &strings(&["own"])),
        place_memory_notices("", &strings(&["idle"]), &[]),
        place_memory_notices("out", &[], &[]),
        place_memory_notices("", &[], &[]),
        place_memory_notices("out", &strings(&["a", ""]), &strings(&["b", "c"])),
    ];
    assert_eq!(placed, fixture().place);
}
