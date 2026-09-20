#!/bin/zsh
# Build Plan and install it on a cabled iPhone.
#   ./install-phone.sh            # single connected phone
#   ./install-phone.sh <UDID>     # pick one when several are cabled
# Prereqs per phone: Trust prompt accepted, Developer Mode on.
set -e
cd "$(dirname "$0")"

UDID=${1:-$(xcrun devicectl list devices 2>/dev/null | grep -oE '[0-9A-F]{8}-[0-9A-F]{16}' | head -1)}
[[ -n "$UDID" ]] || { echo "no iPhone found — cable one and tap Trust"; exit 1; }
echo "target device: $UDID"

xcodebuild -project Plan.xcodeproj -scheme Plan \
  -destination "id=$UDID" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  -derivedDataPath build build 2>&1 | grep -E "error|BUILD" || true

APP=$(ls -d build/Build/Products/*-iphoneos/Plan.app 2>/dev/null | head -1)
[[ -n "$APP" ]] || { echo "build failed — see above"; exit 1; }

xcrun devicectl device install app --device "$UDID" "$APP"
echo "installed. On the phone: Messages -> any chat -> app drawer -> Plan."
