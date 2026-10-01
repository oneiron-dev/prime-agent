//! The model-visible text of every memory step, byte for byte the TS fork's
//! `memory-guard.ts` builders: numbers in GB like `formatGb`, the variables
//! the kernel reported, and the reason the limit exists.

use std::fmt::Write as _;

use super::{policy::KernelEndCause, GIB, MEMORY_HARD_LIMIT_FACTOR, MEMORY_TRIM_MIN_BYTES};
use crate::kernel::shared::KernelCellLine;

const MIB: f64 = 1024.0 * 1024.0;

pub(crate) const MEMORY_LIMIT_REASON: &str = "The limit protects this machine: other agents and the owner's apps share it, and a process that outgrows memory freezes the whole machine and ends every session on it.";
const MACHINE_PREFIX: &str =
    "The machine is nearly out of memory, and this kernel was the largest this session owns. ";
const PIECES_ADVICE: &str =
    "in pieces (stream, batch, memmap, compact dtypes such as uint8 or float32).";

/// One variable (or alias group) the kernel reported, largest first.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SizedVariable {
    pub name: String,
    pub bytes: f64,
    pub type_name: String,
    /// numpy, pandas, polars and torch values.
    pub shape: Option<Vec<i64>>,
    pub dtype: Option<String>,
    /// Lists, tuples, sets, dicts and deques.
    pub length: Option<u64>,
}

/// JS `Number.prototype.toFixed` for a nonnegative finite value: the exact
/// decimal expansion rounded to `digits` places, an exact half rounding up
/// (Rust's fixed formatting rounds such ties to even).
fn to_fixed(value: f64, digits: usize) -> String {
    let exact = format!("{value:.1100}");
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let tail = &fraction[digits.min(fraction.len())..];
    let tie = tail.starts_with('5') && tail[1..].bytes().all(|byte| byte == b'0');
    if !tie {
        return format!("{value:.digits$}");
    }
    // Round the truncated decimal up by one unit in its last place.
    let mut kept: Vec<u8> = whole.bytes().chain(fraction[..digits].bytes()).collect();
    let mut index = kept.len();
    loop {
        if index == 0 {
            kept.insert(0, b'1');
            break;
        }
        index -= 1;
        if kept[index] == b'9' {
            kept[index] = b'0';
        } else {
            kept[index] += 1;
            break;
        }
    }
    let mut text = String::from_utf8(kept).unwrap_or_default();
    if digits > 0 {
        text.insert(text.len() - digits, '.');
    }
    text
}

/// JS `String(Number(fixed))`: drop the fractional zeros toFixed padded.
fn trim_fixed(text: String) -> String {
    if !text.contains('.') {
        return text;
    }
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn fixed_gb(bytes: f64, digits: usize) -> String {
    trim_fixed(to_fixed(bytes / GIB, digits))
}

/// Bytes as GB with 2 decimals below 10, 1 below 100, none above.
pub(crate) fn format_gb(bytes: f64) -> String {
    let gb = bytes / GIB;
    let digits = if gb >= 100.0 {
        0
    } else if gb >= 10.0 {
        1
    } else {
        2
    };
    fixed_gb(bytes, digits)
}

/// A usage above the limit never reads as the limit itself ("16 GB, above
/// its 16 GB limit"): up to 3 decimals until it reads above.
fn format_over(bytes: f64, limit_bytes: f64) -> String {
    let mut text = format_gb(bytes);
    let mut digits = 2;
    while bytes > limit_bytes
        && text.parse::<f64>().unwrap_or(0.0) * GIB <= limit_bytes
        && digits <= 3
    {
        text = fixed_gb(bytes, digits);
        digits += 1;
    }
    text
}

/// Variable sizes: GB like every other number in the messages, MB or KB below 10 MB.
fn format_size(bytes: f64) -> String {
    if bytes >= 10.0 * MIB {
        return format!("{} GB", format_gb(bytes));
    }
    if bytes >= MIB {
        return format!("{} MB", (bytes / MIB).round() as i64);
    }
    format!("{} KB", ((bytes / 1024.0).round() as i64).max(1))
}

fn describe_type(variable: &SizedVariable) -> String {
    if let Some(length) = variable.length {
        return format!("{} of {length}", variable.type_name);
    }
    let text = match &variable.dtype {
        Some(dtype) => format!("{} {dtype}", variable.type_name),
        None => variable.type_name.clone(),
    };
    match &variable.shape {
        Some(shape) => {
            let dims = shape
                .iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            let trailing = if shape.len() == 1 { "," } else { "" };
            format!("{text}, shape ({dims}{trailing})")
        }
        None => text,
    }
}

fn describe_variable(variable: &SizedVariable) -> String {
    format!(
        "{} ({}, {})",
        variable.name,
        format_size(variable.bytes),
        describe_type(variable)
    )
}

fn describe_variables(variables: &[SizedVariable]) -> String {
    variables
        .iter()
        .map(describe_variable)
        .collect::<Vec<_>>()
        .join(", ")
}

fn cell_at(line: &KernelCellLine) -> String {
    format!("line {} (`{}`)", line.lineno, line.source)
}

/// The owed warning, delivered after the next user cell's own output.
pub(crate) fn memory_warning_message(
    total_bytes: f64,
    limit_bytes: f64,
    largest: &[SizedVariable],
) -> String {
    let variables = if largest.is_empty() {
        "none".to_string()
    } else {
        largest
            .iter()
            .map(|variable| {
                format!(
                    "{} {} ({})",
                    variable.name,
                    format_size(variable.bytes),
                    describe_type(variable)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let limit = format_gb(limit_bytes);
    format!(
        "Memory: this kernel and its processes use {} GB of their {limit} GB limit. \
         Largest variables: {variables}. Free what you no longer need (del name) or load the rest in pieces. \
         At {limit} GB the runtime stops the cell and deletes the largest variables. {MEMORY_LIMIT_REASON}",
        format_gb(total_bytes)
    )
}

/// The stopped child, as the message names it.
pub(crate) struct StoppedChild<'a> {
    pub name: &'a str,
    pub pid: i32,
    pub bytes: f64,
}

pub(crate) struct ChildStepContext<'a> {
    pub child: StoppedChild<'a>,
    pub total_bytes: f64,
    /// The tree without the stopped child.
    pub after_bytes: f64,
    pub limit_bytes: f64,
    pub machine: bool,
}

pub(crate) fn memory_child_message(context: &ChildStepContext<'_>) -> String {
    let limit = format_gb(context.limit_bytes);
    let mut used = format!(
        "used {} GB",
        format_over(context.child.bytes, context.limit_bytes)
    );
    if context.child.bytes > context.limit_bytes {
        let _ = write!(used, ", above the {limit} GB limit");
    } else if context.total_bytes > context.limit_bytes {
        let _ = write!(
            used,
            " and took this kernel and its processes to {} GB, above the {limit} GB limit",
            format_over(context.total_bytes, context.limit_bytes)
        );
    }
    format!(
        "{}Memory limit: {} (pid {}), started from this kernel, {used}, \
         so the runtime stopped it. Memory now: {} GB. \
         The kernel and all its variables are intact, and files on disk are untouched. {MEMORY_LIMIT_REASON} \
         Next: process the data {PIECES_ADVICE}",
        if context.machine { MACHINE_PREFIX } else { "" },
        context.child.name,
        context.child.pid,
        format_gb(context.after_bytes)
    )
}

pub(crate) struct TrimStepContext<'a> {
    pub total_bytes: f64,
    /// Measured after the trim; `None` when the table could not be read.
    pub after_bytes: Option<f64>,
    pub limit_bytes: f64,
    pub dropped: &'a [SizedVariable],
    /// The running cell was stopped for this step.
    pub cell_stopped: bool,
    pub line: Option<&'a KernelCellLine>,
}

pub(crate) fn memory_trim_message(context: &TrimStepContext<'_>) -> String {
    let head = format!(
        "Memory limit: this kernel used {} GB, above its {} GB limit, so the runtime ",
        format_over(context.total_bytes, context.limit_bytes),
        format_gb(context.limit_bytes)
    );
    let stopped = if context.cell_stopped {
        match context.line {
            Some(line) => format!("stopped the cell at {}", cell_at(line)),
            None => "stopped the cell".to_string(),
        }
    } else {
        String::new()
    };
    let now = context
        .after_bytes
        .map(|after| format!(" Memory now: {} GB.", format_gb(after)))
        .unwrap_or_default();
    let next = format!("{MEMORY_LIMIT_REASON} Next: recompute only what you need, {PIECES_ADVICE}");
    if context.dropped.is_empty() {
        let action = if stopped.is_empty() {
            "looked for large variables"
        } else {
            stopped.as_str()
        };
        return format!(
            "{head}{action}. No variable held {} GB or more, \
             so none was deleted: every variable is intact, and files on disk are untouched.{now} \
             If memory stays above the limit, the runtime ends the kernel. {next}",
            format_gb(MEMORY_TRIM_MIN_BYTES as f64)
        );
    }
    let action = if stopped.is_empty() {
        "deleted".to_string()
    } else {
        format!("{stopped} and deleted")
    };
    format!(
        "{head}{action} the largest variables: {}.{now} \
         Every other variable is intact, and files on disk are untouched. {next}",
        describe_variables(context.dropped)
    )
}

/// Names the kernel held when it ended, largest first.
pub(crate) struct HeldVariables<'a> {
    pub names: &'a [SizedVariable],
    pub more: u64,
    /// Set when the names come from an earlier reading this many seconds ago.
    pub stale_seconds: Option<u64>,
}

pub(crate) struct KillStepContext<'a> {
    pub total_bytes: f64,
    pub limit_bytes: f64,
    pub cause: KernelEndCause,
    /// A user cell was running when the kernel ended.
    pub cell_running: bool,
    pub line: Option<&'a KernelCellLine>,
    pub held: Option<HeldVariables<'a>>,
}

pub(crate) fn memory_kill_message(context: &KillStepContext<'_>) -> String {
    let above = format!(", above its {} GB limit", format_gb(context.limit_bytes));
    let why = match context.cause {
        KernelEndCause::Grace => format!(
            "{above}, and {} did not bring it down",
            if context.cell_running {
                "stopping the cell"
            } else {
                "deleting the largest variables"
            }
        ),
        KernelEndCause::Hard => format!(
            "{above} and past the {} GB hard limit",
            format_gb(context.limit_bytes * MEMORY_HARD_LIMIT_FACTOR)
        ),
        KernelEndCause::Machine => {
            if context.total_bytes > context.limit_bytes {
                above
            } else {
                String::new()
            }
        }
    };
    let place = match (context.cell_running, context.line) {
        (false, _) => String::new(),
        (true, Some(line)) => format!(" while the cell ran {}", cell_at(line)),
        (true, None) => " while a cell was running".to_string(),
    };
    let held = match &context.held {
        None => {
            " The kernel did not answer in time, so the names it held are not known.".to_string()
        }
        Some(held) if held.names.is_empty() => " The kernel held no variables.".to_string(),
        Some(held) => {
            let when = held
                .stale_seconds
                .map(|seconds| format!(" (at a reading {seconds} s earlier)"))
                .unwrap_or_default();
            let more = if held.more > 0 {
                format!(", and {} more", held.more)
            } else {
                String::new()
            };
            format!(
                " The kernel held{when}: {}{more}.",
                describe_variables(held.names)
            )
        }
    };
    format!(
        "{}Memory limit: this kernel used {} GB{why}, \
         so the runtime ended the kernel and every process it started{place}. \
         All Python variables are gone; the next cell starts a fresh kernel.{held} Files on disk are untouched. \
         {MEMORY_LIMIT_REASON} Next: rebuild state in pieces, and run a heavy one-off job as a script through bash.",
        if context.cause == KernelEndCause::Machine {
            MACHINE_PREFIX
        } else {
            ""
        },
        format_over(context.total_bytes, context.limit_bytes)
    )
}

/// A tool result's text: notices from actions taken while no cell ran come
/// first, this cell's own last.
pub(crate) fn place_memory_notices(text: &str, queued: &[String], current: &[String]) -> String {
    queued
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(text))
        .chain(current.iter().map(String::as_str))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
#[path = "messages_tests.rs"]
mod tests;
