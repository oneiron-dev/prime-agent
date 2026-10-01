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
# The gate's test build gets its own target dir so it never blocks on (or
# invalidates) the release build's lock in target/.
export CARGO_TARGET_DIR="${GATE_TARGET_DIR:-$root/target/gate}"

run_fmt() { cargo fmt --all --check; }
run_clippy() { cargo clippy --workspace --all-targets --locked -- -D warnings; }

run_test() {
  local scope=(--workspace) sandbox
  if [ ${#crates[@]} -gt 0 ]; then scope=("${crates[@]}"); fi
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/pa-gate.XXXXXX")"
  mkdir -p "$sandbox/home" "$sandbox/tmp"
  echo "gate: sandbox $sandbox"
  (
    export HOME="$sandbox/home" TMPDIR="$sandbox/tmp" XDG_CONFIG_HOME="$sandbox/home/.config" \
      XDG_DATA_HOME="$sandbox/home/.local/share" XDG_STATE_HOME="$sandbox/home/.local/state"
    # CI runs with a clean env: ambient product/telemetry switches (a
    # developer's DO_NOT_TRACK=1, say) would flip the tests that pin env
    # precedence.
    unset PRIME_AGENT_SOCKET_DIR PRIME_AGENT_DAEMON_SOCKET PRIME_AGENT_KERNEL_VENV PRIME_AGENT_KERNEL_PYTHON \
      PRIME_AGENT_CODING_AGENT_DIR PI_PACKAGE_DIR PI_SKIP_VERSION_CHECK PI_OFFLINE DO_NOT_TRACK \
      PRIME_AGENT_TELEMETRY PRIME_AGENT_TELEMETRY_API_KEY PRIME_AGENT_TELEMETRY_ENDPOINT PRIME_AGENT_TELEMETRY_ORIGIN
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
