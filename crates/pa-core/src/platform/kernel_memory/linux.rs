//! Linux: `/proc/<pid>/stat` for the tree, `/proc/<pid>/status` for the
//! size (resident plus swapped, not virtual), `/proc/meminfo` for pressure.
//! Every read is bounded at 64 KiB.

#[cfg(any(target_os = "linux", test))]
use super::ProcessRow;

/// `pid (comm) state ppid pgrp ...`; `comm` may itself contain spaces and
/// parentheses, so the fields after it start past the LAST `)`.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_linux_stat(text: &str) -> Option<ProcessRow> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    if close < open {
        return None;
    }
    let pid = text[..open].trim().parse::<i32>().ok()?;
    let rest = text.get(close + 2..)?;
    let mut fields = rest.split(' ');
    let _state = fields.next()?;
    let parent = fields.next()?.trim().parse::<i32>().ok()?;
    let group = fields.next()?.trim().parse::<i32>().ok()?;
    Some(ProcessRow {
        pid,
        ppid: parent,
        pgid: group,
        name: text[open + 1..close].to_string(),
    })
}

/// The first `<key>:   <n> kB` line's number; a missing field reads as 0.
#[cfg(any(target_os = "linux", test))]
fn status_kb(text: &str, key: &str) -> u64 {
    text.lines()
        .find_map(|line| {
            let rest = line.strip_prefix(key)?.strip_prefix(':')?;
            let digits = rest.trim_start_matches(char::is_whitespace);
            if digits.len() == rest.len() {
                return None;
            }
            let end = digits
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(digits.len());
            if end == 0 || !digits[end..].starts_with(" kB") {
                return None;
            }
            digits[..end].parse::<u64>().ok()
        })
        .unwrap_or(0)
}

/// Resident plus swapped bytes from `/proc/<pid>/status`.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_linux_status_bytes(text: &str) -> u64 {
    status_kb(text, "VmRSS")
        .saturating_add(status_kb(text, "VmSwap"))
        .saturating_mul(1024)
}

/// Critical when `MemAvailable` is at or below 5% of `MemTotal`.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_linux_meminfo_critical(text: &str) -> bool {
    let total = status_kb(text, "MemTotal");
    total > 0 && (status_kb(text, "MemAvailable") as f64) <= total as f64 * 0.05
}

/// One bounded procfs read, decoded byte-for-byte (latin-1): `comm` is raw
/// bytes, and a lossy UTF-8 decode could shift the parenthesis offsets.
#[cfg(target_os = "linux")]
fn read_proc_file(path: &str) -> Option<String> {
    use std::io::Read;
    const PROC_READ_LIMIT: u64 = 64 * 1024;
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(PROC_READ_LIMIT).read_to_end(&mut bytes).ok()?;
    Some(bytes.iter().map(|&b| char::from(b)).collect())
}

/// Lazy per-member size of a procfs table.
#[cfg(target_os = "linux")]
pub(super) fn read_status_bytes(pid: i32) -> u64 {
    read_proc_file(&format!("/proc/{pid}/status")).map_or(0, |text| parse_linux_status_bytes(&text))
}

#[cfg(target_os = "linux")]
fn read_procfs_table() -> anyhow::Result<super::ProcessTable> {
    let mut rows = std::collections::HashMap::new();
    for entry in std::fs::read_dir("/proc")? {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        // A process can exit between the listing and the read.
        let Some(stat) = read_proc_file(&format!("/proc/{name}/stat")) else {
            continue;
        };
        if let Some(row) = parse_linux_stat(&stat) {
            rows.insert(row.pid, row);
        }
    }
    let critical =
        parse_linux_meminfo_critical(&read_proc_file("/proc/meminfo").unwrap_or_default());
    Ok(super::ProcessTable {
        rows,
        critical,
        sizes: super::ProcessSizes::Procfs(std::sync::Mutex::default()),
    })
}

/// The procfs reader: the listing runs on the blocking pool.
#[cfg(target_os = "linux")]
pub(super) struct ProcfsReader;

#[cfg(target_os = "linux")]
impl super::MemoryReader for ProcfsReader {
    fn read(
        &self,
        _python: Option<std::path::PathBuf>,
    ) -> futures::future::BoxFuture<'static, anyhow::Result<super::ProcessTable>> {
        Box::pin(async {
            tokio::task::spawn_blocking(read_procfs_table)
                .await
                .map_err(|error| anyhow::anyhow!("process table read failed: {error}"))?
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: i32, parent: i32, group: i32, name: &str) -> ProcessRow {
        ProcessRow {
            pid,
            ppid: parent,
            pgid: group,
            name: name.to_string(),
        }
    }

    #[test]
    fn stat_fields_start_past_the_last_parenthesis() {
        assert_eq!(
            parse_linux_stat("4242 (python3) S 4000 4000 4000 0 -1"),
            Some(row(4242, 4000, 4000, "python3"))
        );
        // `comm` may hold spaces and parentheses of its own.
        assert_eq!(
            parse_linux_stat("77 (a b) (c)) R 1 77 77 0"),
            Some(row(77, 1, 77, "a b) (c)"))
        );
        assert_eq!(parse_linux_stat("garbage"), None);
        assert_eq!(parse_linux_stat("12 )x( S 1 1"), None);
        assert_eq!(parse_linux_stat("12 (x)"), None);
        assert_eq!(parse_linux_stat("x (y) S 1 1"), None);
    }

    #[test]
    fn status_size_is_resident_plus_swapped() {
        let status = "Name:\tpython3\nVmPeak:\t 9000000 kB\nVmSize:\t 8000000 kB\nVmRSS:\t  1024 kB\nRssAnon:\t 512 kB\nVmSwap:\t     2 kB\n";
        assert_eq!(parse_linux_status_bytes(status), (1024 + 2) * 1024);
        // Missing fields read as zero (kernel threads have no VmRSS).
        assert_eq!(parse_linux_status_bytes("Name:\tkthreadd\n"), 0);
        assert_eq!(parse_linux_status_bytes("VmRSS:\t100 kB\n"), 100 * 1024);
        // No separator, or no unit: not the field.
        assert_eq!(parse_linux_status_bytes("VmRSS:100 kB\nVmSwap:\t5\n"), 0);
    }

    /// The live reader: this test process is listed under its real parent,
    /// with a resident size.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_procfs_reader_lists_this_process_under_its_parent_with_a_size() {
        use super::super::MemoryReader as _;
        let table = ProcfsReader.read(None).await.expect("procfs is readable");
        let me = i32::try_from(std::process::id()).expect("pid fits i32");
        let parent = i32::try_from(std::os::unix::process::parent_id()).expect("pid fits i32");
        assert_eq!(table.rows.get(&me).map(|row| row.ppid), Some(parent));
        assert!(
            table.bytes_of(me) > 1024 * 1024,
            "resident bytes of the test process"
        );
    }

    #[test]
    fn machine_is_critical_at_or_below_five_percent_available() {
        let meminfo = |total: u64, available: u64| {
            format!("MemTotal:       {total} kB\nMemFree:          1 kB\nMemAvailable:   {available} kB\n")
        };
        assert!(parse_linux_meminfo_critical(&meminfo(1000, 50)));
        assert!(!parse_linux_meminfo_critical(&meminfo(1000, 51)));
        assert!(parse_linux_meminfo_critical(&meminfo(1000, 0)));
        // Unreadable or missing totals never claim pressure.
        assert!(!parse_linux_meminfo_critical(""));
        assert!(!parse_linux_meminfo_critical("MemAvailable: 1 kB\n"));
    }
}
