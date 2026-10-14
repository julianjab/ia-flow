#!/usr/bin/env bash
# Compila la barra de menú a dist/IAFlowMenu.app. Uso: apps/menubar/build.sh [--install]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
app="$here/dist/IAFlowMenu.app"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
swiftc -O -o "$app/Contents/MacOS/IAFlowMenu" "$here/main.swift"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>IAFlowMenu</string>
  <key>CFBundleIdentifier</key><string>dev.julianjab.ia-flow-menu</string>
  <key>CFBundleExecutable</key><string>IAFlowMenu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>IAFlowRoot</key><string>$root</string>
</dict></plist>
PLIST
codesign --force --sign - "$app" >/dev/null 2>&1 || true
echo "listo: $app"

if [[ "${1:-}" == "--install" ]]; then
  rm -rf "$HOME/Applications/IAFlowMenu.app"
  mkdir -p "$HOME/Applications"
  cp -R "$app" "$HOME/Applications/"
  echo "instalada en ~/Applications/IAFlowMenu.app"
fi
