#!/usr/bin/env bash
# The merge gate for rust-oneiron lanes (upstream CI only runs on main).
#
#   scripts/oneiron/gate.sh [fmt|clippy|test|policy|all] [-- extra cargo test args]
#   scripts/oneiron/gate.sh crates <crate>... [-- test filters]   (focused)
#
# Same gates as `make check` on the toolchain upstream CI pins, plus the fork
# gates, in one of two modes:
#
# - offload (Arch, where $offload/env.sh exists; owner rule: no compiles
#   here): clippy and tests run on the build boxes through the offload cargo
#   wrapper, as `cargo +<toolchain> …`. No local build, bootstrap or sandbox:
#   the remote run gets none of this host's env (the boxes run no TS fleet).
#   fmt stays local. The wrapper silently runs cargo HERE when it is not first
#   on PATH, W7_CARGO_WORK is unset or the worktree is not one it accepts, so
#   the gate refuses to run cargo at all in those cases.
# - local (no offload kit, the Mac): tests run sandboxed. HOME and TMPDIR
#   point at a throwaway dir, so the kernel e2e suites bootstrap their own venv
#   and every test daemon listens in the sandbox. Unsandboxed, `cargo test
#   --workspace` would bootstrap into the real ~/.prime/agent/kernel-venv and
#   probe the real daemon socket dir: a live TS fleet's. The real cargo,
#   rustup, sccache and uv caches are reused.
set -euo pipefail

offload=/home/lexi/w8-opus/offload
# The worktree roots the offload wrapper offloads from (one level below).
offload_roots="/home/lexi/code/oneiron-impl-waves/repos/prime-agent/.claude/worktrees /home/lexi/w8-opus"
toolchain="${RUSTUP_TOOLCHAIN:-1.98.1}"

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
step="${1:-all}"
[ $# -gt 0 ] && shift
scope=(--workspace)
if [ "$step" = "crates" ]; then
  scope=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do scope+=(-p "$1"); shift; done
  [ ${#scope[@]} -gt 0 ] || { echo "usage: $0 crates <crate>... [-- test filters]" >&2; exit 2; }
fi
[ "${1:-}" = "--" ] && shift

if [ -f "$offload/env.sh" ]; then
  mode=offload
  echo "gate: offload mode (build boxes)"
  # shellcheck source=/dev/null
  . "$offload/env.sh"
  unset W7_CARGO_LOCAL
  cargo=(cargo "+$toolchain")
  # The wrapper forwards only its own short env list: an explicit TS
  # reference would not reach the remote differential suites, which would
  # then skip or pick another binary.
  case "$step" in
    test|crates|all)
      if [ -n "${PA_TS_BINARY:-}" ]; then
        echo "gate: PA_TS_BINARY is set, but an explicit TS reference cannot travel to the build boxes; run that comparison in local mode on the Mac" >&2
        exit 1
      fi ;;
  esac
else
  mode=local
  echo "gate: local mode"
  cargo=(cargo)
  export RUSTUP_TOOLCHAIN="$toolchain"
  export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
  export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
  if command -v sccache >/dev/null 2>&1; then
    export RUSTC_WRAPPER="${RUSTC_WRAPPER:-sccache}"
    export SCCACHE_DIR="${SCCACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/sccache}"
    # The sccache server is a long-lived daemon that keeps the environment it
    # was spawned with: started inside a test sandbox, it would keep the
    # sandbox TMPDIR and fail every compile once the sandbox is removed. Start
    # it (if none is running) from the real environment, and never idle out.
    SCCACHE_IDLE_TIMEOUT=0 sccache --start-server >/dev/null 2>&1 || true
  fi
  export UV_CACHE_DIR="${UV_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/uv}"
  # mold cuts link time and memory when several lanes build at once (Linux x64 only).
  if [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] && command -v mold >/dev/null 2>&1; then
    export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS="${CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS:--C link-arg=-fuse-ld=mold}"
  fi
  # The gate's build gets its own target dir so it never blocks on (or
  # invalidates) the release build's lock in target/. It must keep the
  # `<...>/target/<profile>/` shape: pa-daemon's lease-holder classifier
  # recognizes a cargo build by it (`target/gate/debug` reads as a foreign
  # process), so it lives outside the worktree.
  export CARGO_TARGET_DIR="${GATE_TARGET_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pa-gate/$(basename "$root")/target}"
fi

# Offload mode only: refuse (before any cargo call) every case in which the
# wrapper would run cargo on this host instead of a build box.
require_offload() {
  local refuse="gate: offload mode, refusing to run cargo on this host:" top accepted ok=""
  [ "$(command -v cargo)" = "$offload/bin/cargo" ] ||
    { echo "$refuse cargo on PATH is $(command -v cargo || echo nothing), not $offload/bin/cargo" >&2; exit 1; }
  [ -n "${W7_CARGO_WORK:-}" ] || { echo "$refuse W7_CARGO_WORK is unset" >&2; exit 1; }
  top="$(git rev-parse --show-toplevel 2>/dev/null)" && top="$(cd "$top" && pwd -P)" || top=""
  for accepted in $offload_roots; do
    case "$top" in "$accepted"/*/*) ;; "$accepted"/?*) ok=1 ;; esac
  done
  [ -n "$ok" ] && [ "$top" = "$(pwd -P)" ] ||
    { echo "$refuse $root is not a worktree the wrapper offloads from (one level under: $offload_roots)" >&2; exit 1; }
  # The hosts the wrapper reads at every call (its hosts file wins over
  # W7_CARGO_HOSTS): at least one well-formed build box, and no `local`
  # entry (a local slot runs cargo here).
  local hosts entries entry host rest slots jobs dir remote=""
  if [ -f "$offload/hosts" ]; then hosts="$(tr -d '\n' < "$offload/hosts")"; else hosts="${W7_CARGO_HOSTS:-}"; fi
  IFS=';' read -ra entries <<<"$hosts"
  for entry in ${entries[@]+"${entries[@]}"}; do
    host=${entry%%:*}
    [ -n "$host" ] && [ "$host" != "$entry" ] || continue
    [ "$host" != local ] || { echo "$refuse the wrapper's hosts list a local entry" >&2; exit 1; }
    rest=${entry#*:}; slots=${rest%%:*}; rest=${rest#*:}; jobs=${rest%%:*}; dir=${rest#*:}
    [[ "$slots" =~ ^[0-9]+$ ]] && [[ "$jobs" =~ ^[0-9]+$ ]] && [ "$slots" -gt 0 ] && [ -n "$dir" ] || continue
    remote=1
  done
  [ -n "$remote" ] || { echo "$refuse no build host in $offload/hosts (or W7_CARGO_HOSTS)" >&2; exit 1; }
}

# Offload mode: cargo through the wrapper, passing only when its stderr
# names the build box that ran it (`[factory-cargo] <host> slot …`, the
# last one). A run without one ran on this host: a loud failure, never a
# pass. The hosts can change between require_offload and the call.
offloaded() {
  local log status host
  log="$(mktemp "${TMPDIR:-/tmp}/gate-offload.XXXXXX")"
  set +e
  { "${cargo[@]}" "$@" 2>&1 1>&3 3>&- | tee "$log" >&2; status=${PIPESTATUS[0]}; } 3>&1
  set -e
  host="$(sed -n 's/^\[factory-cargo\] \([^ ]*\) slot .*/\1/p' "$log" | tail -n 1)"
  rm -f "$log"
  if [ -z "$host" ] || [ "$host" = local ]; then
    echo "gate: offload mode, but cargo ran on this host, not a build box (exit $status); failing" >&2
    return 1
  fi
  return "$status"
}

run_fmt() { "${cargo[@]}" fmt --all --check; }

run_clippy() {
  if [ "$mode" = offload ]; then
    require_offload
    offloaded clippy --workspace --all-targets --locked -- -D warnings
  else
    "${cargo[@]}" clippy --workspace --all-targets --locked -- -D warnings
  fi
}

run_test() {
  if [ "$mode" = offload ]; then
    require_offload
    offloaded test --locked "${scope[@]}" --no-fail-fast "$@"
  else
    run_sandboxed_test "$@"
  fi
}

# Local mode's build, bootstrap and tests, under a throwaway HOME and TMPDIR.
run_sandboxed_test() {
  local sandbox
  # Short paths: tests bind unix sockets under TMPDIR and sun_path holds
  # ~104-108 bytes, so the sandbox sits directly in /tmp as on a CI runner.
  sandbox="$(mktemp -d /tmp/pg.XXXXXX)"
  mkdir -p "$sandbox/h" "$sandbox/t" "$sandbox/bin"
  echo "gate: sandbox $sandbox"
  local ts_reference="${PA_TS_BINARY:-}" shadowed_path="" seen="" dir entry status shadows=0
  # PATH minus any `prime-agent`: each dir holding one is replaced, at its
  # own position, by a shadow dir of links (to absolute targets) to
  # everything else in it, so every other command resolves as before.
  # Repeats and empty entries (the cwd: here, the worktree) are dropped.
  local IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || continue
    case ":$seen:" in *":$dir:"*) continue ;; esac
    seen="${seen:+$seen:}$dir"
    if [ -e "$dir/prime-agent" ]; then
      shadows=$((shadows + 1))
      mkdir "$sandbox/bin/$shadows"
      for entry in "$(cd "$dir" && pwd -P)"/*; do
        case "${entry##*/}" in prime-agent|prime-agent-*|sol) ;; *) ln -s "$entry" "$sandbox/bin/$shadows/" ;; esac
      done
      dir="$sandbox/bin/$shadows"
    fi
    shadowed_path="${shadowed_path:+$shadowed_path:}$dir"
  done
  unset IFS
  # A subshell left of && or || runs with set -e off, so a failed build or
  # bootstrap would pass the gate on green tests. It stands alone and sets
  # -e itself; the outer shell collects its status for the cleanup below.
  set +e
  (
    set -e
    export HOME="$sandbox/h" TMPDIR="$sandbox/t" XDG_CONFIG_HOME="$sandbox/h/.config" \
      XDG_DATA_HOME="$sandbox/h/.local/share" XDG_STATE_HOME="$sandbox/h/.local/state" \
      PATH="$shadowed_path" TZ=UTC
    # CI runs with a clean env. Every product switch goes: state roots
    # (session dirs, agent dir), harness state and debug sinks (RLM_*,
    # PA_*: write destinations, not metadata), update roles (the restart
    # roster), sockets, venvs, telemetry (a developer's DO_NOT_TRACK=1 flips
    # the env-precedence tests). HOME/TMPDIR alone would not neutralize an
    # inherited override.
    for name in $(env | sed -nE 's/^((PRIME_AGENT|PI|RLM|PA)_[A-Za-z0-9_]*)=.*/\1/p'); do
      unset "$name"
    done
    unset DO_NOT_TRACK
    # The TS-differential suites run `PA_TS_BINARY`, else `prime-agent` on
    # PATH. Here that would be the Oneiron TS fork, not upstream's parity
    # ground truth, so by default neither exists (they skip as on a CI
    # runner); an explicit PA_TS_BINARY is kept as the reference.
    if [ -n "$ts_reference" ]; then export PA_TS_BINARY="$ts_reference"; fi
    # TZ=UTC as on CI: fixtures pin zone-less git dates (golden bash replay).
    cargo build --locked --workspace --bins
    "$CARGO_TARGET_DIR/debug/prime-agent" --prime-agent-bootstrap
    cargo test --locked "${scope[@]}" --no-fail-fast "$@"
  )
  status=$?
  set -e
  # /tmp is RAM-backed here: a failed run's sandbox (kernel venv included)
  # is kept only on request.
  if [ "$status" -ne 0 ] && [ -n "${GATE_KEEP_SANDBOX:-}" ]; then
    echo "gate: kept sandbox $sandbox"
  else
    rm -rf "$sandbox"
  fi
  return "$status"
}

run_policy() {
  python3 scripts/oneiron/test_policy_gate.py
  python3 scripts/oneiron/test_side_by_side.py
}

case "$step" in
  fmt) run_fmt ;;
  clippy) run_clippy ;;
  test|crates) run_test "$@" ;;
  policy) run_policy ;;
  all) run_fmt; run_clippy; run_policy; run_test "$@" ;;
  *) echo "usage: $0 [fmt|clippy|test|policy|all|crates <crate>...] [-- cargo test args]" >&2; exit 2 ;;
esac
echo "gate: $step passed"
