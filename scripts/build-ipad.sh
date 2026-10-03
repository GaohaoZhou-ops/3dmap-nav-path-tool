#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IPAD_TARGET="${1:-device}"
case "$IPAD_TARGET" in
  device) DESTINATION='generic/platform=iOS' ;;
  simulator) DESTINATION='generic/platform=iOS Simulator' ;;
  *) echo '用法: bash scripts/build-ipad.sh [device|simulator]' >&2; exit 2 ;;
esac
xcodebuild -project "$PROJECT_DIR/ipad/AtlasTeaching.xcodeproj" -scheme AtlasTeaching \
  -configuration Debug -destination "$DESTINATION" \
  -derivedDataPath "$PROJECT_DIR/ipad/build" CODE_SIGNING_ALLOWED=NO build
