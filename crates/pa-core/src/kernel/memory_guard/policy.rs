//! The ladder's pure decision: one kernel tree's measurement, its limit, and
//! its ladder state in; the steps to take out (TS `decideMemorySteps`).

use std::time::Instant;

use super::tree::{ChildUnit, KernelTreeUsage};
use super::{MEMORY_HARD_LIMIT_FACTOR, MEMORY_TRIM_GRACE, MEMORY_WARN_FRACTION};

/// Why the last step ended a kernel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KernelEndCause {
    /// Over the limit 10 s after the variable step began (or its trim finished).
    Grace,
    /// Past 1.5x the limit.
    Hard,
    /// The machine backstop picked this tree.
    Machine,
}

impl KernelEndCause {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Grace => "grace",
            Self::Hard => "hard",
            Self::Machine => "machine",
        }
    }
}

/// Whether this tree is the machine backstop's victim this pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MachinePressure {
    /// The tree only answers to its own limit.
    Normal,
    /// The machine is nearly out of memory and this is the largest enabled tree.
    BackstopVictim,
}

/// Per-kernel ladder state across passes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LadderState {
    /// A warning may fire on the next crossing of the warn line.
    pub warn_armed: bool,
    /// When the variable step began (or its trim finished): the grace clock
    /// for the last step.
    pub trim_at: Option<Instant>,
}

impl Default for LadderState {
    fn default() -> Self {
        Self {
            warn_armed: true,
            trim_at: None,
        }
    }
}

/// One step of the ladder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MemoryStep {
    /// Owe the model a warning with the next cell's result.
    Warn,
    /// SIGKILL this child unit.
    Child(ChildUnit),
    /// Stop the cell and delete the largest variables until this many bytes are freed.
    Trim { target_bytes: u64 },
    /// End the kernel.
    Kill(KernelEndCause),
}

/// Smallest unit first: a child that holds more than the kernel itself is
/// stopped alone; otherwise the cell is stopped and the big variables go;
/// the whole tree ends only past the hard limit or when the trim did not
/// help. The warning line is inclusive; the limit and hard limit are strict.
pub(crate) fn decide_memory_steps(
    usage: &KernelTreeUsage,
    limit_bytes: f64,
    state: &mut LadderState,
    now: Instant,
    pressure: MachinePressure,
) -> Vec<MemoryStep> {
    let mut steps = Vec::new();
    let total = usage.total_bytes as f64;
    let child = usage.units.first();
    let child_holds_most = child.filter(|unit| unit.bytes > usage.kernel_bytes);
    match pressure {
        MachinePressure::BackstopVictim => steps.push(match child_holds_most {
            Some(unit) => MemoryStep::Child(unit.clone()),
            None => MemoryStep::Kill(KernelEndCause::Machine),
        }),
        MachinePressure::Normal if total > limit_bytes => {
            if let Some(unit) = child_holds_most {
                steps.push(MemoryStep::Child(unit.clone()));
            } else if total > limit_bytes * MEMORY_HARD_LIMIT_FACTOR {
                steps.push(MemoryStep::Kill(KernelEndCause::Hard));
            } else if let Some(trim_at) = state.trim_at {
                if now.saturating_duration_since(trim_at) >= MEMORY_TRIM_GRACE {
                    steps.push(MemoryStep::Kill(KernelEndCause::Grace));
                }
            } else {
                state.trim_at = Some(now);
                let target =
                    (usage.kernel_bytes as f64 - limit_bytes * MEMORY_WARN_FRACTION).max(0.0);
                steps.push(MemoryStep::Trim {
                    target_bytes: target.ceil() as u64,
                });
            }
        }
        MachinePressure::Normal => state.trim_at = None,
    }
    if total >= limit_bytes * MEMORY_WARN_FRACTION {
        if state.warn_armed && steps.is_empty() {
            steps.push(MemoryStep::Warn);
        }
        state.warn_armed = false;
    } else {
        state.warn_armed = true;
    }
    steps
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const LIMIT: f64 = 1000.0;

    fn tree(kernel_bytes: u64, child_bytes: u64) -> KernelTreeUsage {
        KernelTreeUsage {
            kernel_pid: 1,
            kernel_bytes,
            total_bytes: kernel_bytes + child_bytes,
            units: if child_bytes > 0 {
                vec![child(child_bytes)]
            } else {
                Vec::new()
            },
        }
    }

    fn child(bytes: u64) -> ChildUnit {
        ChildUnit {
            pgid: Some(2),
            pids: vec![2],
            bytes,
            pid: 2,
            name: "python3".to_string(),
        }
    }

    /// The TS fork's ladder walk (`kernel-memory-guard.test.ts`), one
    /// shared state across the passes, millisecond clock offsets.
    #[test]
    fn walks_the_ladder_warn_once_per_crossing_child_first_trim_then_end() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut state = LadderState::default();
        let mut decide = |usage: KernelTreeUsage, ms: u64, pressure: MachinePressure| {
            decide_memory_steps(&usage, LIMIT, &mut state, at(ms), pressure)
        };
        let normal = MachinePressure::Normal;
        let walk = vec![
            decide(tree(599, 0), 0, normal),
            decide(tree(600, 0), 0, normal),
            decide(tree(700, 0), 0, normal),
            decide(tree(500, 0), 0, normal),
            decide(tree(650, 0), 0, normal),
            decide(tree(300, 900), 0, normal),
            decide(tree(1100, 0), 1000, normal),
            decide(tree(1100, 0), 10_999, normal),
            decide(tree(1100, 0), 11_000, normal),
            decide(tree(900, 0), 11_000, normal),
            decide(tree(1100, 0), 12_000, normal),
            decide(tree(1600, 0), 12_000, normal),
            decide(tree(400, 1200), 12_000, normal),
            decide(tree(300, 0), 12_000, MachinePressure::BackstopVictim),
            decide(tree(100, 200), 12_000, MachinePressure::BackstopVictim),
        ];
        assert_eq!(
            walk,
            vec![
                vec![],
                vec![MemoryStep::Warn],
                vec![],
                vec![],
                vec![MemoryStep::Warn],
                vec![MemoryStep::Child(child(900))],
                vec![MemoryStep::Trim { target_bytes: 500 }],
                vec![],
                vec![MemoryStep::Kill(KernelEndCause::Grace)],
                vec![],
                vec![MemoryStep::Trim { target_bytes: 500 }],
                vec![MemoryStep::Kill(KernelEndCause::Hard)],
                vec![MemoryStep::Child(child(1200))],
                vec![MemoryStep::Kill(KernelEndCause::Machine)],
                vec![MemoryStep::Child(child(200))],
            ]
        );
    }

    #[test]
    fn boundaries_are_inclusive_at_the_warn_line_and_strict_above() {
        let now = Instant::now();
        // Exactly the limit: no step beyond the (inclusive) warning.
        let mut state = LadderState::default();
        assert_eq!(
            decide_memory_steps(
                &tree(1000, 0),
                LIMIT,
                &mut state,
                now,
                MachinePressure::Normal
            ),
            vec![MemoryStep::Warn]
        );
        // Exactly 1.5x the limit is a trim, not a hard end; just above ends it.
        let mut state = LadderState::default();
        assert_eq!(
            decide_memory_steps(
                &tree(1500, 0),
                LIMIT,
                &mut state,
                now,
                MachinePressure::Normal
            ),
            vec![MemoryStep::Trim { target_bytes: 900 }]
        );
        assert_eq!(
            decide_memory_steps(
                &tree(1501, 0),
                LIMIT,
                &mut state,
                now,
                MachinePressure::Normal
            ),
            vec![MemoryStep::Kill(KernelEndCause::Hard)]
        );
        // A child equal to the kernel does not hold most: the variable step runs,
        // targeting the kernel's own bytes above 60% of the limit (rounded up).
        let mut state = LadderState::default();
        assert_eq!(
            decide_memory_steps(
                &tree(601, 601),
                LIMIT,
                &mut state,
                now,
                MachinePressure::Normal
            ),
            vec![MemoryStep::Trim { target_bytes: 1 }]
        );
        // A child holding most is stopped even past the hard limit.
        let mut state = LadderState::default();
        assert_eq!(
            decide_memory_steps(
                &tree(100, 1900),
                LIMIT,
                &mut state,
                now,
                MachinePressure::Normal
            ),
            vec![MemoryStep::Child(child(1900))]
        );
        // The target never goes negative when the children hold the excess.
        let mut state = LadderState::default();
        assert_eq!(
            decide_memory_steps(
                &tree(500, 501),
                LIMIT,
                &mut state,
                now,
                MachinePressure::Normal
            ),
            vec![MemoryStep::Child(child(501))]
        );
        assert_eq!(
            decide_memory_steps(
                &tree(550, 500),
                LIMIT,
                &mut LadderState::default(),
                now,
                MachinePressure::Normal
            ),
            vec![MemoryStep::Trim { target_bytes: 0 }]
        );
    }
}
