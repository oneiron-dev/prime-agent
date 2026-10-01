//! A kernel's tree in one process table (TS `measureKernelTree`): the kernel,
//! every descendant, and the surviving members of its `bash()` process groups,
//! grouped into stoppable units.

use std::collections::{HashMap, HashSet};

use crate::platform::kernel_memory::{ProcessRow, ProcessTable};

/// One stoppable unit under a kernel: a process group of its own, or a
/// subtree sharing the kernel's group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildUnit {
    /// Set when the unit is a whole process group the kernel started (signal `-pgid`).
    pub pgid: Option<i32>,
    pub pids: Vec<i32>,
    pub bytes: u64,
    /// The heaviest member, named in the message.
    pub pid: i32,
    pub name: String,
}

/// One kernel tree's memory at one pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KernelTreeUsage {
    pub kernel_pid: i32,
    pub kernel_bytes: u64,
    pub total_bytes: u64,
    /// Largest first.
    pub units: Vec<ChildUnit>,
}

/// Children by parent pid, each list in pid order (deterministic tie-breaks).
pub(crate) fn index_children(rows: &HashMap<i32, ProcessRow>) -> HashMap<i32, Vec<i32>> {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for row in rows.values() {
        if row.ppid == row.pid {
            continue;
        }
        children.entry(row.ppid).or_default().push(row.pid);
    }
    for list in children.values_mut() {
        list.sort_unstable();
    }
    children
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum UnitKey {
    Group(i32),
    Subtree(i32),
}

/// The kernel plus every descendant (the kernel shares its owner's process
/// group, so descendants are found by parent pid), plus the members of a
/// `bash()` process group whose shell died and left them reparented. A group
/// whose leader is alive but not a descendant is someone else's: its id was
/// reused. The host's own group and the kernel's group are never a unit of
/// their own.
pub(crate) fn measure_kernel_tree(
    table: &ProcessTable,
    children: &HashMap<i32, Vec<i32>>,
    kernel_pid: i32,
    bash_pgids: &HashSet<i32>,
    own_pgid: Option<i32>,
) -> Option<KernelTreeUsage> {
    let kernel = table.rows.get(&kernel_pid)?;
    let mut members = vec![kernel_pid];
    let mut member_set = HashSet::from([kernel_pid]);
    let mut queue = vec![kernel_pid];
    let mut visit = |pid: i32, members: &mut Vec<i32>, queue: &mut Vec<i32>| {
        if member_set.insert(pid) {
            members.push(pid);
            queue.push(pid);
        }
    };
    let orphan_pgids: HashSet<i32> = bash_pgids
        .iter()
        .copied()
        .filter(|pgid| {
            !table.rows.contains_key(pgid)
                && *pgid > 1
                && *pgid != kernel.pgid
                && Some(*pgid) != own_pgid
        })
        .collect();
    let mut by_pid: Vec<&ProcessRow> = table.rows.values().collect();
    by_pid.sort_unstable_by_key(|row| row.pid);
    for row in &by_pid {
        if orphan_pgids.contains(&row.pgid) {
            visit(row.pid, &mut members, &mut queue);
        }
    }
    while let Some(pid) = queue.pop() {
        for &child in children.get(&pid).map_or(&[][..], Vec::as_slice) {
            visit(child, &mut members, &mut queue);
        }
    }

    let mut units: Vec<ChildUnit> = Vec::new();
    let mut heaviest: Vec<Option<u64>> = Vec::new();
    let mut unit_index: HashMap<UnitKey, usize> = HashMap::new();
    for &pid in &members {
        if pid == kernel_pid {
            continue;
        }
        let Some(row) = table.rows.get(&pid) else {
            continue;
        };
        let own_group = row.pgid != kernel.pgid
            && Some(row.pgid) != own_pgid
            && row.pgid > 1
            && (member_set.contains(&row.pgid) || orphan_pgids.contains(&row.pgid));
        let key = if own_group {
            UnitKey::Group(row.pgid)
        } else {
            // The top-level descendant this process hangs from. Bounded: a
            // table read across a pid reuse can carry a parent cycle.
            let mut top = row;
            for _ in 0..members.len() {
                if top.ppid == kernel_pid || !member_set.contains(&top.ppid) {
                    break;
                }
                let Some(parent) = table.rows.get(&top.ppid) else {
                    break;
                };
                top = parent;
            }
            UnitKey::Subtree(top.pid)
        };
        let bytes = table.bytes_of(pid);
        let index = *unit_index.entry(key).or_insert_with(|| {
            units.push(ChildUnit {
                pgid: own_group.then_some(row.pgid),
                pids: Vec::new(),
                bytes: 0,
                pid,
                name: row.name.clone(),
            });
            heaviest.push(None);
            units.len() - 1
        });
        let unit = &mut units[index];
        unit.pids.push(pid);
        unit.bytes = unit.bytes.saturating_add(bytes);
        if heaviest[index].is_none_or(|most| bytes > most) {
            heaviest[index] = Some(bytes);
            unit.pid = pid;
            unit.name.clone_from(&row.name);
        }
    }
    let kernel_bytes = table.bytes_of(kernel_pid);
    // Stable: equal units keep their discovery order.
    units.sort_by_key(|unit| std::cmp::Reverse(unit.bytes));
    let total_bytes = units
        .iter()
        .fold(kernel_bytes, |sum, unit| sum.saturating_add(unit.bytes));
    Some(KernelTreeUsage {
        kernel_pid,
        kernel_bytes,
        total_bytes,
        units,
    })
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

    fn unit(group: Option<i32>, members: &[i32], bytes: u64, pid: i32, name: &str) -> ChildUnit {
        ChildUnit {
            pgid: group,
            pids: members.to_vec(),
            bytes,
            pid,
            name: name.to_string(),
        }
    }

    /// The TS fork's fixture: the host (10), the kernel (20) sharing the
    /// host's group, a `bash()` group (30) with its child, a shared-group
    /// subtree (40/41), a reparented orphan of a dead `bash()` group (50),
    /// and a stranger whose group id was in the journal but whose leader is
    /// alive and not ours (60).
    #[test]
    fn measures_descendants_and_reparented_bash_groups_as_stoppable_units() {
        let table = ProcessTable::listed(
            [
                (row(10, 1, 10, "node"), 500),
                (row(20, 10, 10, "python"), 100),
                (row(30, 20, 30, "bash"), 5),
                (row(31, 30, 30, "python3"), 900),
                (row(40, 20, 10, "python3"), 50),
                (row(41, 40, 10, "sort"), 60),
                (row(51, 1, 50, "orphan"), 70),
                (row(60, 1, 60, "stranger"), 999),
                (row(61, 60, 60, "stranger"), 999),
            ],
            false,
        );
        let usage = measure_kernel_tree(
            &table,
            &index_children(&table.rows),
            20,
            &HashSet::from([30, 50, 60]),
            Some(10),
        );
        assert_eq!(
            usage,
            Some(KernelTreeUsage {
                kernel_pid: 20,
                kernel_bytes: 100,
                total_bytes: 1185,
                units: vec![
                    unit(Some(30), &[30, 31], 905, 31, "python3"),
                    unit(None, &[40, 41], 110, 41, "sort"),
                    unit(Some(50), &[51], 70, 51, "orphan"),
                ],
            })
        );
    }

    #[test]
    fn a_vanished_kernel_measures_nothing_and_unrelated_processes_stay_out() {
        let table = ProcessTable::listed(
            [
                (row(20, 1, 1, "python"), 10),
                (row(21, 22, 1, "a"), 1),
                (row(22, 21, 1, "b"), 2),
                (row(23, 20, 1, "c"), 3),
                (row(24, 23, 1, "d"), 4),
            ],
            false,
        );
        let children = index_children(&table.rows);
        assert_eq!(
            measure_kernel_tree(&table, &children, 99, &HashSet::new(), None),
            None
        );
        // 21/22 point at each other and never reach the kernel; 23/24 do.
        assert_eq!(
            measure_kernel_tree(&table, &children, 20, &HashSet::new(), None),
            Some(KernelTreeUsage {
                kernel_pid: 20,
                kernel_bytes: 10,
                total_bytes: 17,
                units: vec![unit(None, &[23, 24], 7, 24, "d")],
            })
        );
    }
}
