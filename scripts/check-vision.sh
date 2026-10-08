#!/usr/bin/env bash
set -euo pipefail

VISION_REPO="$(cd "$(dirname "$0")/.." && pwd)"
VISION_ARTIFACTS="${VISION_ARTIFACTS:-$VISION_REPO/vision/test-artifacts/preflight}"
VISION_UI=false
case "${1:-}" in
  --ui) VISION_UI=true ;;
  "") ;;
  *) echo "Usage: ./scripts/check-vision.sh [--ui]" >&2; exit 2 ;;
esac
cd "$VISION_REPO"
mkdir -p "$VISION_ARTIFACTS"

run_check() {
  local label="$1"; shift
  echo "Checking ${label}..."
  if ! "$@" > "$VISION_ARTIFACTS/$label.log" 2>&1; then
    tail -n 60 "$VISION_ARTIFACTS/$label.log"
    echo "Failed: $VISION_ARTIFACTS/$label.log" >&2
    exit 1
  fi
  # Some actool versions report asset errors but incorrectly exit with status 0.
  if rg -q 'Command .* emitted errors but did not return a nonzero exit code' "$VISION_ARTIFACTS/$label.log"; then
    tail -n 60 "$VISION_ARTIFACTS/$label.log"
    echo "Build diagnostics contain errors: $VISION_ARTIFACTS/$label.log" >&2
    exit 1
  fi
  echo "Passed: $label"
}

xcodebuild -version
xcrun --sdk xros --show-sdk-version
run_check vision-native npm run test:vision
run_check ipad-protocol npm run test:ipad
run_check web-build npm run build
run_check vision-device xcodebuild -project vision/AtlasVisionTeaching.xcodeproj -scheme AtlasVisionTeaching \
  -sdk xros -destination 'generic/platform=visionOS' -configuration Release \
  -derivedDataPath "$VISION_ARTIFACTS/device-build" CODE_SIGNING_ALLOWED=NO build
run_check vision-simulator xcodebuild -project vision/AtlasVisionTeaching.xcodeproj -scheme AtlasVisionTeaching \
  -sdk xrsimulator -destination 'generic/platform=visionOS Simulator' \
  -derivedDataPath "$VISION_ARTIFACTS/simulator-build" CODE_SIGNING_ALLOWED=NO build

if $VISION_UI; then
  if [[ -z "${VISION_SIMULATOR_ID:-}" ]]; then
    VISION_SIMULATOR_ID="$(xcrun simctl list devices available -j | python3 -c '
import json,sys
r=json.load(sys.stdin)["devices"]
keys=sorted((k for k in r if "xrOS" in k), key=lambda k: tuple(map(int,k.split("xrOS-")[1].split("-"))), reverse=True)
print(next((d["udid"] for k in keys for d in r[k] if d.get("isAvailable")), ""))
')"
  fi
  if [[ -z "$VISION_SIMULATOR_ID" ]]; then
    echo "Install a visionOS Simulator runtime in Xcode Settings → Components, then retry --ui." >&2
    exit 1
  fi
  # xcodebuild boots the selected simulator. A timestamp preserves prior test reports.
  run_check vision-ui xcodebuild -project vision/AtlasVisionTeaching.xcodeproj -scheme AtlasVisionTeaching \
    -destination "platform=visionOS Simulator,id=$VISION_SIMULATOR_ID" \
    -derivedDataPath "$VISION_ARTIFACTS/simulator-build" \
    -resultBundlePath "$VISION_ARTIFACTS/ui-$(date +%Y%m%d-%H%M%S).xcresult" \
    CODE_SIGNING_ALLOWED=NO test
fi
echo "Vision Pro preflight passed. Logs: $VISION_ARTIFACTS"
echo "Device builds are unsigned; select your Team in Xcode before installing on hardware."
