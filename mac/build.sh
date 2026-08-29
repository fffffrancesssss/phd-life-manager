#!/bin/bash
# Builds the Mac app from this checkout.
#
# Only needed when mac/main.swift or mac/makeicon.swift changes — the
# interface (public/*.html, .css, .js) and the server (server.py) are read
# from disk at run time, so day-to-day edits need no rebuild, just a reload
# (Cmd+R) in the app, or a restart for server.py.
#
# The app is installed to ~/Applications by default. Override with:
#   INSTALL_DIR=/Applications ./mac/build.sh
set -e
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications}"
APP="$INSTALL_DIR/PhD Life Manager.app"

swiftc -O -o phdapp main.swift -framework Cocoa -framework WebKit

# Icon is regenerated when it is missing, or when its source is newer than it.
# Testing only for the file's existence meant an edit to makeicon.swift
# silently did nothing on the next build.
if [ ! -f AppIcon.icns ] || [ makeicon.swift -nt AppIcon.icns ]; then
  swiftc -O -o makeicon makeicon.swift -framework Cocoa
  ./makeicon ./AppIcon.iconset
  iconutil -c icns AppIcon.iconset -o AppIcon.icns
fi

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp phdapp "$APP/Contents/MacOS/PhD Life Manager"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp Info.plist "$APP/Contents/Info.plist"

# The app has to find the Python half of itself. Recording the checkout it
# was built from means a clone works wherever it was cloned to, with nobody
# editing a path into a source file.
/usr/libexec/PlistBuddy -c "Add :PHDProjectDirectory string $REPO" "$APP/Contents/Info.plist" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Set :PHDProjectDirectory $REPO" "$APP/Contents/Info.plist"

# Stale metadata makes codesign refuse, so clear it first. This is an ad-hoc
# signature: fine for an app you built yourself, not enough to hand someone
# a prebuilt copy (see README).
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"

# macOS caches Dock icons hard; without this a changed icon often won't show.
touch "$APP"
killall Dock >/dev/null 2>&1 || true

echo "Built: $APP"
