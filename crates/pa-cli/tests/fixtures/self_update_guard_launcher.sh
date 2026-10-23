#!/bin/sh
set -eu
sandbox=$PWD
IFS= read -r binary < "$sandbox/prime-agent-binary"
exec env -i PATH="$PATH" HOME="$sandbox/home" TMPDIR="$sandbox/tmp" \
    PRIME_AGENT_CODING_AGENT_DIR="$sandbox/home/.prime/agent" \
    PRIME_AGENT_DISABLE_SELF_UPDATE=1 PI_OFFLINE=1 DO_NOT_TRACK=1 \
    "$binary" "$@"
