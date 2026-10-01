"""Kernel-local memory handlers for the host's memory ceiling.

Sizes the user namespace by the object that holds each name's memory and
drops the largest values when the host asks (the ``trim_memory`` request).
Sizing is best-effort: a bounded walk that extrapolates past its budget, with
array libraries' own size reports preferred where they exist.
"""

from __future__ import annotations

import ctypes
import sys
import types
from collections.abc import Collection
from typing import Any

# Sizing walks at most this many objects per top-level value, then extrapolates.
SIZE_WALK_NODES = 100_000
# A memory report races a kill: it walks less and extrapolates more.
REPORT_WALK_NODES = 10_000
_SIZE_WALK_DEPTH = 32
_UNSIZED_TYPES = (types.ModuleType, type, types.FunctionType, types.BuiltinFunctionType, types.MethodType)
_ATOMS = (int, float, complex, bool, type(None), bytes, bytearray, str)
_ARRAY_MODULES = ("numpy", "pandas", "polars", "torch")
_SIZED_CONTAINERS = (list, tuple, set, frozenset, dict)


def _direct_size(value: Any) -> int | None:
    """In-memory bytes of atoms and of array-likes that report their own size, else None."""
    if type(value) in _ATOMS:
        return sys.getsizeof(value)
    if isinstance(value, memoryview):
        return value.nbytes
    module = type(value).__module__ or ""
    try:
        if module.startswith("pandas"):
            usage = value.memory_usage(deep=True)
            return int(usage.sum()) if hasattr(usage, "sum") else int(usage)
        if module.startswith("polars"):
            return int(value.estimated_size())
        nbytes = getattr(value, "nbytes", None)
        if callable(nbytes):
            nbytes = nbytes()
    except Exception:  # noqa: BLE001 - a broken size hook falls back to the walk
        return None
    return nbytes if isinstance(nbytes, int) and not isinstance(nbytes, bool) else None


def _deep_size(value: Any, seen: set[int], budget: list[int], depth: int = 0) -> int:
    """Bounded walk: containers and instance dicts; a list longer than the budget is extrapolated."""
    if id(value) in seen or isinstance(value, _UNSIZED_TYPES):
        return 0
    seen.add(id(value))
    budget[0] -= 1
    direct = _direct_size(value)
    if direct is not None:
        return direct
    try:
        size = sys.getsizeof(value)
    except Exception:  # noqa: BLE001
        size = 0
    if depth >= _SIZE_WALK_DEPTH:
        return size
    try:
        if isinstance(value, dict):
            children: Any = [item for pair in value.items() for item in pair]
            count = 2 * len(value)
        elif isinstance(value, (list, tuple, set, frozenset)) or type(value).__name__ == "deque":
            children, count = value, len(value)
        else:
            attrs = getattr(value, "__dict__", None)
            if not isinstance(attrs, dict):
                return size
            children, count = list(attrs.values()), len(attrs)
        walked = total = 0
        for child in children:
            if budget[0] <= 0:
                break
            total += _deep_size(child, seen, budget, depth + 1)
            walked += 1
    except Exception:  # noqa: BLE001 - a mutating or broken container keeps what was measured
        return size
    if 0 < walked < count:
        total = total * count // walked
    return size + total


def _array_owner(value: Any) -> Any:
    """The array that owns a view's memory (numpy .base chain), so views and bases drop together."""
    for _ in range(8):
        base = getattr(value, "base", None) if (type(value).__module__ or "").startswith("numpy") else None
        if base is None or not (type(base).__module__ or "").startswith("numpy"):
            return value
        value = base
    return value


def _shape_fields(value: Any) -> dict[str, Any]:
    """Shape and dtype of an array or frame (numpy, pandas, polars, torch), or a container's length."""
    try:
        if (type(value).__module__ or "").split(".")[0] in _ARRAY_MODULES:
            fields: dict[str, Any] = {}
            shape = getattr(value, "shape", None)
            if isinstance(shape, tuple):
                fields["shape"] = [int(n) for n in shape]
            dtype = getattr(value, "dtype", None)
            if dtype is not None:
                fields["dtype"] = str(dtype).removeprefix("torch.")
            elif getattr(value, "dtypes", None) is not None:
                kinds = list(dict.fromkeys(str(kind) for kind in list(value.dtypes)))
                fields["dtype"] = "/".join(kinds[:3]) + ("/..." if len(kinds) > 3 else "")
            return fields
        if isinstance(value, _SIZED_CONTAINERS) or type(value).__name__ == "deque":
            return {"length": len(value)}
    except Exception:  # noqa: BLE001 - a broken attribute leaves the size and type
        pass
    return {}


def sized_groups(ns: dict[str, Any], skip: Collection[str], walk_nodes: int = SIZE_WALK_NODES) -> list[dict[str, Any]]:
    """Top-level names grouped by the object that holds their memory, largest first."""
    groups: dict[int, dict[str, Any]] = {}
    for name, value in list(ns.items()):
        if not isinstance(name, str) or (name.startswith("__") and name.endswith("__")) or name in skip:
            continue
        if isinstance(value, _UNSIZED_TYPES):
            continue
        owner = _array_owner(value)
        group = groups.get(id(owner))
        if group is None:
            group = groups[id(owner)] = {
                "names": [],
                "ids": set(),
                "bytes": _deep_size(owner, set(), [walk_nodes]),
                "type": type(value).__name__,
                "details": _shape_fields(value),
            }
        group["names"].append(name)
        group["ids"].add(id(value))
    return sorted(groups.values(), key=lambda group: group["bytes"], reverse=True)


def sized_entry(group: dict[str, Any]) -> dict[str, Any]:
    """One group as the host's sized-variable record: names, bytes, type, and shape/dtype or length."""
    return {"name": ", ".join(group["names"]), "bytes": group["bytes"], "type": group["type"], **group["details"]}


def _release_heap() -> None:
    """Hand freed heap pages back to the OS so the host's measurement sees the drop."""
    try:
        if sys.platform.startswith("linux"):
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        elif sys.platform == "darwin":
            ctypes.CDLL("/usr/lib/libSystem.B.dylib").malloc_zone_pressure_relief(None, 0)
    except (OSError, AttributeError):
        pass


def trim_memory(
    ns: dict[str, Any], skip: Collection[str], target_bytes: int, min_bytes: int, count: int = 3
) -> dict[str, Any]:
    """Drop the largest top-level values (never one under min_bytes) until target_bytes are freed."""
    import gc

    groups = sized_groups(ns, skip)
    dropped: list[dict[str, Any]] = []
    freed = 0
    purge_ids: set[int] = set()
    for group in groups:
        if freed >= target_bytes or group["bytes"] < min_bytes:
            break
        for name in group["names"]:
            ns.pop(name, None)
        purge_ids |= group["ids"]
        freed += group["bytes"]
        dropped.append(sized_entry(group))
    output_cache = ns.get("Out")
    if isinstance(output_cache, dict):
        for key in [key for key, value in output_cache.items() if id(value) in purge_ids]:
            del output_cache[key]
    for attr in ("last_type", "last_value", "last_traceback", "last_exc"):
        if hasattr(sys, attr):
            setattr(sys, attr, None)
    kept = groups[len(dropped) :]
    del groups
    gc.collect()
    _release_heap()
    largest = [sized_entry(group) for group in kept[:count]]
    return {"dropped": dropped, "largest": largest, "more": max(0, len(kept) - count), "freed_bytes": freed}
