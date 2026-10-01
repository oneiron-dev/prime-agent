//! The kernel memory ceiling (the TS fork's `core/kernel/memory-guard.ts`):
//! every two seconds one pass measures every watched kernel plus the
//! processes it started and walks the ladder - warn, stop the child, drop the
//! big variables, end the kernel - with a machine-wide backstop.
//!
//! Concerns: [`policy`] decides the steps from one measurement, [`tree`]
//! turns a process table into a kernel's stoppable units, [`messages`] owns
//! the model-visible text, [`watcher`] runs the pass over the registered
//! kernels. The OS readers live behind the platform wall
//! (`platform::kernel_memory`); the kernel manager owns the actions
//! (`kernel::manager::memory`).

pub(crate) mod messages;
pub(crate) mod policy;
pub(crate) mod tree;
pub(crate) mod watcher;

/// Default ceiling per kernel tree, in GiB.
pub const DEFAULT_KERNEL_MEMORY_LIMIT_GB: f64 = 16.0;
/// Overrides the ceiling when the `kernelMemoryLimitGb` setting is unset.
pub const KERNEL_MEMORY_LIMIT_ENV: &str = "PRIME_AGENT_KERNEL_MEMORY_LIMIT_GB";
/// `0`/`false`/`off`/`no` turn the machine backstop off when the
/// `kernelMemoryBackstop` setting is unset.
pub const KERNEL_MEMORY_BACKSTOP_ENV: &str = "PRIME_AGENT_KERNEL_MEMORY_BACKSTOP";

/// "GB" in every number the ladder prints is GiB.
pub(crate) const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
pub(crate) const MEMORY_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
pub(crate) const MEMORY_WARN_FRACTION: f64 = 0.6;
pub(crate) const MEMORY_HARD_LIMIT_FACTOR: f64 = 1.5;
/// The trim never deletes a variable smaller than this.
pub(crate) const MEMORY_TRIM_MIN_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const MEMORY_TRIM_GRACE: std::time::Duration = std::time::Duration::from_secs(10);
/// The backstop never ends a tree this small: a fresh kernel frees nothing worth its state.
pub(crate) const BACKSTOP_MIN_TREE_BYTES: u64 = MEMORY_TRIM_MIN_BYTES;

/// The configured limit in GiB when it is a finite number `>= 0`, else the
/// environment override (JS `Number` grammar, `>= 0`), else 16. `0` turns the
/// whole ladder off, the machine backstop and the model-facing line included.
#[must_use]
pub fn resolve_kernel_memory_limit_gb(configured: Option<f64>, raw_env: Option<&str>) -> f64 {
    if let Some(configured) = configured.filter(|value| value.is_finite() && *value >= 0.0) {
        return configured;
    }
    raw_env
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .and_then(js_number)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(DEFAULT_KERNEL_MEMORY_LIMIT_GB)
}

/// The configured backstop flag, else on unless the environment says
/// `0`, `false`, `off` or `no` (trimmed, any case).
#[must_use]
pub fn resolve_kernel_memory_backstop(configured: Option<bool>, raw_env: Option<&str>) -> bool {
    if let Some(configured) = configured {
        return configured;
    }
    let raw = raw_env.map(|raw| raw.trim().to_ascii_lowercase());
    !matches!(raw.as_deref(), Some("0" | "false" | "off" | "no"))
}

/// The model-facing line that states the ceiling up front (the ipython tool
/// description and the system prompt carry it); `None` when the ladder is off.
#[must_use]
pub fn kernel_memory_prompt_line(limit_gb: f64) -> Option<String> {
    // TS `!(limitGb > 0)`: NaN is off too.
    if limit_gb.is_nan() || limit_gb <= 0.0 {
        return None;
    }
    Some(format!(
        "Memory: each kernel, with the processes it starts, may use up to {} GB. Load large data in pieces, and run a heavy one-off job as a script through `bash()`, so a breach stops only that script.",
        messages::format_gb(limit_gb * GIB)
    ))
}

/// JS `Number(text)` for an already-trimmed, nonempty string: decimal
/// literals with an optional sign, exponent, and leading or trailing dot,
/// `Infinity`, and unsigned `0x`/`0o`/`0b` integers. Anything else is NaN
/// (`None`); Rust's own float parser accepts more (`inf`, `nan`).
fn js_number(text: &str) -> Option<f64> {
    let radix = match text.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &text[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return None;
        }
        return Some(
            digits
                .chars()
                .filter_map(|c| c.to_digit(radix))
                .fold(0.0, |value, digit| {
                    value * f64::from(radix) + f64::from(digit)
                }),
        );
    }
    let unsigned = text
        .strip_prefix('+')
        .or_else(|| text.strip_prefix('-'))
        .unwrap_or(text);
    if unsigned == "Infinity" {
        return Some(if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits_only = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if (whole.is_empty() && fraction.is_empty()) || !digits_only(whole) || !digits_only(fraction) {
        return None;
    }
    if let Some(exponent) = exponent {
        let exponent_digits = exponent
            .strip_prefix('+')
            .or_else(|| exponent.strip_prefix('-'))
            .unwrap_or(exponent);
        if exponent_digits.is_empty() || !digits_only(exponent_digits) {
            return None;
        }
    }
    text.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Fixture {
        limit: Vec<(Option<String>, serde_json::Value, f64)>,
        backstop: Vec<(Option<String>, serde_json::Value, bool)>,
        #[serde(rename = "promptLine")]
        prompt_line: Vec<(f64, Option<String>)>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("ts_parity.json")).expect("TS parity fixture parses")
    }

    /// The settings value as the lenient settings loader hands it over: a
    /// number survives, a string/bool/null is a wrong-typed field (`None`).
    fn configured_number(value: &serde_json::Value) -> Option<f64> {
        value.as_f64()
    }

    fn configured_bool(value: &serde_json::Value) -> Option<bool> {
        value.as_bool()
    }

    /// Replays the TS resolver's outputs (captured from the fork's
    /// `resolveKernelMemoryLimitGb` / `resolveKernelMemoryBackstop` with
    /// bun, see `messages_tests.rs`) over the same settings/env pairs.
    #[test]
    fn limit_and_backstop_resolve_like_the_ts_fork() {
        let fixture = fixture();
        let limits: Vec<(Option<String>, f64)> = fixture
            .limit
            .iter()
            .map(|(raw, configured, _)| {
                (
                    raw.clone(),
                    resolve_kernel_memory_limit_gb(configured_number(configured), raw.as_deref()),
                )
            })
            .collect();
        let expected: Vec<(Option<String>, f64)> = fixture
            .limit
            .iter()
            .map(|(raw, _, value)| (raw.clone(), *value))
            .collect();
        assert_eq!(limits, expected);

        let backstops: Vec<(Option<String>, bool)> = fixture
            .backstop
            .iter()
            .map(|(raw, configured, _)| {
                (
                    raw.clone(),
                    resolve_kernel_memory_backstop(configured_bool(configured), raw.as_deref()),
                )
            })
            .collect();
        let expected: Vec<(Option<String>, bool)> = fixture
            .backstop
            .iter()
            .map(|(raw, _, value)| (raw.clone(), *value))
            .collect();
        assert_eq!(backstops, expected);
    }

    #[test]
    fn prompt_line_states_the_limit_only_while_the_ladder_is_on() {
        let fixture = fixture();
        let lines: Vec<(f64, Option<String>)> = fixture
            .prompt_line
            .iter()
            .map(|(limit, _)| (*limit, kernel_memory_prompt_line(*limit)))
            .collect();
        assert_eq!(lines, fixture.prompt_line);
    }
}
