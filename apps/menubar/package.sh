#!/bin/sh
# Release artifact: Release build, ad-hoc signed, zipped as
# build/PAI-MenuBar-<version>.zip (version from the PAI package.json).
# Run through the build queue: pai build run -- ./package.sh
set -e
cd "$(dirname "$0")"
VERSION=$(node -p "require('../../package.json').version")
./build.sh
ZIP="build/PAI-MenuBar-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --keepParent build/PAI.app "$ZIP"
codesign --verify --deep --strict build/PAI.app
echo "packaged $ZIP"
