#!/usr/bin/env bash
# Crea /Applications/IA Flow.app y /Applications/IA Flow Gateway.app.
#
#   bun run --cwd apps/desktop install:apps
#
# Los bundles NO copian Electron adentro (son ~250MB cada uno): ejecutan el
# binario de node_modules con `--mode=`. Es lo mismo que hace `electron .`,
# pero clickeable desde el Finder. Para distribuir a otra máquina haría falta
# electron-builder; para tu propia máquina esto alcanza y no duplica nada.
#
# Volvé a correrlo sólo si movés el repo de carpeta. El código del main
# process se re-lee de dist/main.js en cada arranque, así que un cambio ahí
# sólo pide `bun run --cwd apps/desktop build`.

set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"

# El binario REAL, no el wrapper de node_modules/.bin: ese wrapper es un
# script `#!/usr/bin/env node`, y una app abierta desde el Finder arranca sin
# node en el PATH — moría con "env: node: No such file or directory".
ELECTRON_BIN=""
for candidate in \
  "$DESKTOP_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
  "$REPO_ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
do
  [[ -x "$candidate" ]] && ELECTRON_BIN="$candidate" && break
done

if [[ -z "$ELECTRON_BIN" ]]; then
  echo "✗ no encontré el binario de electron." >&2
  echo "  Corré 'bun install' y después 'bunx electron --version' para bajarlo." >&2
  exit 1
fi

if [[ ! -f "$DESKTOP_DIR/dist/main.js" ]]; then
  echo "✗ falta dist/main.js — corré 'bun run --cwd apps/desktop build'" >&2
  exit 1
fi

if [[ -w /Applications ]]; then
  APPS_DIR=/Applications
else
  APPS_DIR="$HOME/Applications"
  mkdir -p "$APPS_DIR"
  echo "· /Applications no es escribible — instalando en ~/Applications"
fi

# make_app <nombre> <bundle-id> <modo>
make_app() {
  local name="$1" bundle_id="$2" mode="$3"
  local app_dir="$APPS_DIR/$name.app"

  rm -rf "$app_dir"
  mkdir -p "$app_dir/Contents/MacOS"

  cat > "$app_dir/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
PLIST

  cat > "$app_dir/Contents/MacOS/launcher" <<LAUNCHER
#!/bin/bash
# Generado por apps/desktop/install.sh — no editar a mano.
exec "$ELECTRON_BIN" "$DESKTOP_DIR" --mode=$mode "\$@"
LAUNCHER

  chmod +x "$app_dir/Contents/MacOS/launcher"
  touch "$app_dir"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$app_dir" 2>/dev/null || true

  echo "✓ $app_dir"
}

make_app "IA Flow"         "dev.julianjab.ia-flow.desktop" web
make_app "IA Flow Gateway" "dev.julianjab.ia-flow.gateway" gateway

echo "  electron: $ELECTRON_BIN"
echo
echo "  IA Flow.app          → la web en :5273, abre en el selector de server"
echo "  IA Flow Gateway.app  → el gateway en :3002 y su pantalla"
