#!/bin/sh
# Builds build/PAI.app (menu bar only, no Dock icon).
set -e
cd "$(dirname "$0")"
swift build -c release
BIN=$(swift build -c release --show-bin-path)/PAIMenuBar
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
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict></plist>
PLIST
codesign --force -s - "$APP" >/dev/null 2>&1 || true
echo "built $APP"
