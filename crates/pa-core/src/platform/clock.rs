//! The host's local civil clock: the UTC offset JavaScript's `Date` local
//! accessors (`getFullYear`/`getMonth`/`getDate`) apply, so a TS-parity
//! date line renders the same local calendar day.

/// The local zone's offset from UTC in seconds at `unix_secs` (positive
/// east of UTC), from the C library's `localtime_r` (it honors `TZ` and the
/// zone's daylight-saving rules). `0` when the instant cannot be converted.
#[cfg(unix)]
// `c_long` is narrower than i64 on 32-bit targets.
#[allow(clippy::useless_conversion)]
pub(crate) fn local_utc_offset_secs(unix_secs: i64) -> i64 {
    // `time_t` is i64 on every supported target (a no-op cast there).
    #[allow(clippy::cast_possible_truncation, clippy::unnecessary_cast)]
    let time = unix_secs as libc::time_t;
    // SAFETY: all-zero is a valid `tm` (integers and a null zone pointer).
    let mut civil: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: `localtime_r` reads `time` and writes only `civil`; a null
    // return means the instant is out of range.
    if unsafe { libc::localtime_r(&raw const time, &raw mut civil) }.is_null() {
        return 0;
    }
    i64::from(civil.tm_gmtoff)
}

/// Non-Unix hosts render the UTC day (no `localtime_r`).
#[cfg(not(unix))]
pub(crate) fn local_utc_offset_secs(_unix_secs: i64) -> i64 {
    0
}
