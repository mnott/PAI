#!/bin/sh
# Builds build/PAI.app (menu bar only, no Dock icon).
set -e
cd "$(dirname "$0")"
VERSION=$(node -p "require('../../package.json').version")
# Keep SwiftPM's scratch/build dir outside the source tree: a synced checkout
# (file-sync client watching it) stalls swift-build on .build/ file churn.
SCRATCH=${PAI_SWIFT_SCRATCH:-$HOME/.cache/pai/swift/menubar}
mkdir -p "$SCRATCH"
swift build -c release --scratch-path "$SCRATCH"
BIN=$(swift build -c release --scratch-path "$SCRATCH" --show-bin-path)/PAIMenuBar
APP=build/PAI.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/PAIMenuBar"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>PAI</string>
<key>CFBundleIdentifier</key><string>org.mnsoft.pai.menubar</string>
<key>CFBundleExecutable</key><string>PAIMenuBar</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$VERSION</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict></plist>
PLIST
if [ -n "$PAI_SIGN_IDENTITY" ]; then
  codesign --force --deep --options runtime --timestamp --entitlements PAI.entitlements -s "$PAI_SIGN_IDENTITY" "$APP"
  echo "signed with Developer ID identity from PAI_SIGN_IDENTITY"
else
  codesign --force --deep -s - "$APP"
  echo "PAI_SIGN_IDENTITY not set: ad-hoc signed (not notarizable)"
fi
echo "built $APP ($VERSION)"
