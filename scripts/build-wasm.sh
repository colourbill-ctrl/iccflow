#!/usr/bin/env bash
# Build the iccflow WASM, copy artifacts into the frontend, refresh
# committed checksums.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICCDEV_ROOT="${ICCDEV_ROOT:-/home/colour/code/iccdev}"
BUILD_DIR="$REPO_ROOT/flow-wasm/build"
SRC_DIR="$REPO_ROOT/flow-wasm"
OUT_DIR="$REPO_ROOT/frontend/public/wasm"
CHECKSUM_FILE="$OUT_DIR/SHA256SUMS"

if ! command -v emcmake >/dev/null; then
  echo "error: emcmake not on PATH — source your emsdk_env.sh first" >&2
  exit 1
fi

if [ ! -f "$ICCDEV_ROOT/IccProfLib/IccProfile.h" ]; then
  echo "error: iccDEV source not found at $ICCDEV_ROOT" >&2
  exit 1
fi

if [ ! -d "$BUILD_DIR" ]; then
  emcmake cmake -S "$SRC_DIR" -B "$BUILD_DIR" -DICCDEV_ROOT="$ICCDEV_ROOT"
fi
cmake --build "$BUILD_DIR" -j"$(nproc)"

mkdir -p "$OUT_DIR"

ARTIFACTS=(iccflow.mjs iccflow.wasm)

if [ "${1:-}" = "--verify" ]; then
  if [ ! -f "$CHECKSUM_FILE" ]; then
    echo "error: no committed checksums at $CHECKSUM_FILE" >&2
    exit 2
  fi
  cd "$BUILD_DIR"
  expected=$(sort "$CHECKSUM_FILE")
  actual=$(sha256sum "${ARTIFACTS[@]}" | sort)
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: rebuilt artifacts do not match committed checksums" >&2
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
    exit 3
  fi
  echo "OK: rebuilt artifacts match $CHECKSUM_FILE"
  exit 0
fi

for f in "${ARTIFACTS[@]}"; do
  cp "$BUILD_DIR/$f" "$OUT_DIR/"
done

cd "$OUT_DIR"
sha256sum "${ARTIFACTS[@]}" > SHA256SUMS
echo
echo "=== committed artifact checksums (frontend/public/wasm/SHA256SUMS) ==="
cat SHA256SUMS
