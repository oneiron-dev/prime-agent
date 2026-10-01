//! macOS: the kernel's own Python reads `proc_pidinfo(PROC_PIDT_SHORTBSDINFO)`
//! for the tree and `proc_pid_rusage(RUSAGE_INFO_V0)` `ri_phys_footprint` for
//! the size (the number Activity Monitor shows, compressed pages included),
//! filtered to this user, plus the memorystatus pressure sysctls. The run is
//! isolated (`-I -S`), bounded at 5 s and 16 MiB of output.

#[cfg(any(target_os = "macos", test))]
use super::ProcessRow;

/// First line `pressure <vm_pressure_level> <memorystatus_level>`, then
/// `pid\tppid\tpgid\tfootprint\tcomm` rows. Critical at pressure level 4
/// (critical) or a nonnegative memorystatus level at or below 10; a failed
/// sysctl reports -1.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn parse_darwin_sample(text: &str) -> (Vec<(ProcessRow, u64)>, bool) {
    let mut rows: Vec<(ProcessRow, u64)> = Vec::new();
    let mut critical = false;
    for line in text.split('\n') {
        if let Some(levels) = line.strip_prefix("pressure ") {
            let mut parts = levels.split(' ');
            let level = parts.next().and_then(parse_signed);
            let available = parts.next().and_then(parse_signed);
            if let (Some(level), Some(available), None) = (level, available, parts.next()) {
                critical = level == 4 || (0..=10).contains(&available);
                continue;
            }
        }
        let fields: Vec<&str> = line.split('\t').collect();
        let number = |index: usize| {
            fields
                .get(index)
                .and_then(|field| field.trim().parse::<i64>().ok())
        };
        let (Some(pid), Some(parent), Some(group), Some(bytes)) =
            (number(0), number(1), number(2), number(3))
        else {
            continue;
        };
        let (Ok(pid), Ok(parent), Ok(group), Ok(bytes)) = (
            i32::try_from(pid),
            i32::try_from(parent),
            i32::try_from(group),
            u64::try_from(bytes),
        ) else {
            continue;
        };
        if pid <= 0 {
            continue;
        }
        let name = fields.get(4).copied().unwrap_or_default().to_string();
        rows.retain(|(row, _)| row.pid != pid);
        rows.push((
            ProcessRow {
                pid,
                ppid: parent,
                pgid: group,
                name,
            },
            bytes,
        ));
    }
    (rows, critical)
}

/// `-?\d+` exactly.
#[cfg(any(target_os = "macos", test))]
fn parse_signed(text: &str) -> Option<i64> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

#[cfg(target_os = "macos")]
const DARWIN_SAMPLER: &str = r#"
import ctypes, os
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
def level(name):
    value, size = ctypes.c_int(-1), ctypes.c_size_t(4)
    ok = lib.sysctlbyname(name, ctypes.byref(value), ctypes.byref(size), None, ctypes.c_size_t(0)) == 0
    return value.value if ok else -1
class Info(ctypes.Structure):
    _fields_ = [("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("pgid", ctypes.c_uint32), ("status", ctypes.c_uint32), ("comm", ctypes.c_char * 16)] + [(f, ctypes.c_uint32) for f in ("flags", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "rfu")]
class Usage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(f, ctypes.c_uint64) for f in ("user", "system", "idle", "intr", "pageins", "wired", "resident", "footprint", "start", "exit")]
count = lib.proc_listallpids(None, 0)
pids = (ctypes.c_int * (max(count, 0) + 512))()
count = lib.proc_listallpids(pids, ctypes.sizeof(pids))
lines = ["pressure %d %d" % (level(b"kern.memorystatus_vm_pressure_level"), level(b"kern.memorystatus_level"))]
info, usage, uid = Info(), Usage(), os.getuid()
for pid in pids[:max(count, 0)]:
    if pid <= 0 or lib.proc_pidinfo(pid, 13, ctypes.c_uint64(0), ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info) or info.uid != uid:
        continue
    if lib.proc_pid_rusage(pid, 0, ctypes.byref(usage)) == 0:
        lines.append("%d\t%d\t%d\t%d\t%s" % (pid, info.ppid, info.pgid, usage.footprint, info.comm.decode("utf-8", "replace")))
print("\n".join(lines))
"#;

#[cfg(target_os = "macos")]
async fn read_footprint_table(
    python: Option<std::path::PathBuf>,
) -> anyhow::Result<super::ProcessTable> {
    use tokio::io::AsyncReadExt;
    const SAMPLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
    const MAX_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
    let python =
        python.ok_or_else(|| anyhow::anyhow!("macOS memory reader needs the kernel Python"))?;
    let mut command = tokio::process::Command::new(&python);
    command
        .args(["-I", "-S", "-c", DARWIN_SAMPLER])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("sampler stdout missing"))?;
    let sample = async {
        let mut output = Vec::new();
        (&mut stdout)
            .take(MAX_OUTPUT_BYTES + 1)
            .read_to_end(&mut output)
            .await?;
        if output.len() as u64 > MAX_OUTPUT_BYTES {
            anyhow::bail!("memory sampler output exceeds {MAX_OUTPUT_BYTES} bytes");
        }
        let status = child.wait().await?;
        if !status.success() {
            anyhow::bail!("memory sampler exited with {status}");
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    };
    let text = tokio::time::timeout(SAMPLE_TIMEOUT, sample)
        .await
        .map_err(|_| anyhow::anyhow!("memory sampler timed out"))??;
    let (rows, critical) = parse_darwin_sample(&text);
    Ok(super::ProcessTable::listed(rows, critical))
}

/// The libproc footprint reader (through the kernel's Python).
#[cfg(target_os = "macos")]
pub(super) struct FootprintReader;

#[cfg(target_os = "macos")]
impl super::MemoryReader for FootprintReader {
    fn read(
        &self,
        python: Option<std::path::PathBuf>,
    ) -> futures::future::BoxFuture<'static, anyhow::Result<super::ProcessTable>> {
        Box::pin(read_footprint_table(python))
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
    fn sample_rows_and_pressure_levels() {
        let text = "pressure 1 40\n501\t1\t501\t1048576\tpython3.12\n502\t501\t502\t2048\tsleep\nbad line\n0\t1\t1\t5\tzero\n";
        assert_eq!(
            parse_darwin_sample(text),
            (
                vec![
                    (row(501, 1, 501, "python3.12"), 1_048_576),
                    (row(502, 501, 502, "sleep"), 2048),
                ],
                false
            )
        );
        // Level 4 is critical; so is a memorystatus level at or below 10.
        assert!(parse_darwin_sample("pressure 4 90\n").1);
        assert!(parse_darwin_sample("pressure 1 10\n").1);
        assert!(!parse_darwin_sample("pressure 2 11\n").1);
        // A failed sysctl (-1) never claims pressure.
        assert!(!parse_darwin_sample("pressure -1 -1\n").1);
    }
}
