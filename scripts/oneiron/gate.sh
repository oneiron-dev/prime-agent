#!/usr/bin/env bash
# The local merge gate for rust-oneiron lanes (upstream CI only runs on main).
#
#   scripts/oneiron/gate.sh [fmt|clippy|test|policy|all] [-- extra cargo test args]
#   scripts/oneiron/gate.sh crates <crate>... [-- test filters]   (focused, same sandbox)
#
# Same gates as `make check` on the toolchain upstream CI pins, plus the fork
# gates. Tests run sandboxed: HOME and TMPDIR point at a throwaway dir, so the
# kernel e2e suites bootstrap their own venv and every test daemon listens in
# the sandbox. Unsandboxed, `cargo test --workspace` would bootstrap into the
# real ~/.prime/agent/kernel-venv and probe the real daemon socket dir: the
# live TS fleet's. The real cargo, rustup, sccache and uv caches are reused.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
step="${1:-all}"
[ $# -gt 0 ] && shift
crates=()
if [ "$step" = "crates" ]; then
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do crates+=(-p "$1"); shift; done
  [ ${#crates[@]} -gt 0 ] || { echo "usage: $0 crates <crate>... [-- test filters]" >&2; exit 2; }
fi
[ "${1:-}" = "--" ] && shift

export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.98.1}"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
if command -v sccache >/dev/null 2>&1; then
  export RUSTC_WRAPPER="${RUSTC_WRAPPER:-sccache}"
  export SCCACHE_DIR="${SCCACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/sccache}"
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

run_fmt() { cargo fmt --all --check; }
run_clippy() { cargo clippy --workspace --all-targets --locked -- -D warnings; }

run_test() {
  local scope=(--workspace) sandbox
  if [ ${#crates[@]} -gt 0 ]; then scope=("${crates[@]}"); fi
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/pa-gate.XXXXXX")"
  mkdir -p "$sandbox/home" "$sandbox/tmp"
  echo "gate: sandbox $sandbox"
  local ts_reference="${PA_TS_BINARY:-}"
  (
    export HOME="$sandbox/home" TMPDIR="$sandbox/tmp" XDG_CONFIG_HOME="$sandbox/home/.config" \
      XDG_DATA_HOME="$sandbox/home/.local/share" XDG_STATE_HOME="$sandbox/home/.local/state"
    # CI runs with a clean env. Every product switch goes: state roots
    # (session dirs, agent dir), update roles (the restart roster), sockets,
    # venvs, telemetry (a developer's DO_NOT_TRACK=1 flips the env-precedence
    # tests). HOME/TMPDIR alone would not neutralize an inherited override.
    for name in $(env | sed -n 's/^\(PRIME_AGENT_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(PI_[A-Za-z0-9_]*\)=.*/\1/p'); do
      unset "$name"
    done
    unset DO_NOT_TRACK PA_TS_REFERENCE
    # The TS-differential suites run `PA_TS_BINARY`, else `prime-agent` on
    # PATH: by default that is the Oneiron TS fork (not upstream's parity
    # ground truth), so they skip as on a CI runner; an explicit
    # PA_TS_BINARY is kept as the reference.
    export PA_TS_BINARY="${ts_reference:-/nonexistent/pa-gate-no-ts-binary}"
    cargo build --locked --workspace --bins
    "$CARGO_TARGET_DIR/debug/prime-agent" --prime-agent-bootstrap
    cargo test --locked "${scope[@]}" --no-fail-fast "$@"
  )
  rm -rf "$sandbox"
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
