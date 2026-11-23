#!/bin/sh
# Release artifact: build/PAI-MenuBar-<version>.zip (version from the PAI package.json).
# PAI_SIGN_IDENTITY  Developer ID Application identity: hardened runtime + timestamp.
# PAI_NOTARY_PROFILE notarytool keychain profile: notarize, staple, re-zip, verify.
# Without them the app is ad-hoc signed (right-click > Open on first launch).
# Run through the build queue: pai build run -- ./package.sh
set -e
cd "$(dirname "$0")"
VERSION=$(node -p "require('../../package.json').version")
./build.sh
APP=build/PAI.app
ZIP="build/PAI-MenuBar-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
codesign --verify --deep --strict "$APP"
if [ -n "$PAI_SIGN_IDENTITY" ] && [ -n "$PAI_NOTARY_PROFILE" ]; then
  xcrun notarytool submit "$ZIP" --keychain-profile "$PAI_NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  spctl -a -vv -t exec "$APP"
  xcrun stapler validate "$APP"
  echo "packaged $ZIP (Developer ID signed, notarized, stapled)"
elif [ -n "$PAI_SIGN_IDENTITY" ]; then
  echo "packaged $ZIP (Developer ID signed, NOT notarized: PAI_NOTARY_PROFILE not set)"
else
  echo "packaged $ZIP (ad-hoc signed, not notarized)"
fi
