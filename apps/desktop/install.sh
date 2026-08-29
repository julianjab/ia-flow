#!/usr/bin/env bash
# Crea /Applications/IA Flow.app.
#
#   bun run --cwd apps/desktop install:apps
#
# Esto NO es el empaquetado distribuible — para eso está `bun run dist`, que
# produce un .app autocontenido y su .dmg. Esto crea un bundle clickeable desde
# el Finder que ejecuta el Electron de `node_modules` contra el repo: no copia
# Electron adentro (~250MB), así que sirve para TU máquina y no para mover.
#
# Volvé a correrlo sólo si movés el repo de carpeta. El código del main process
# se re-lee de dist/main.cjs en cada arranque, así que un cambio ahí sólo pide
# `bun run --cwd apps/desktop build`. La web se levanta del working tree.

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

if [[ ! -f "$DESKTOP_DIR/dist/main.cjs" ]]; then
  echo "✗ falta dist/main.cjs — corré 'bun run --cwd apps/desktop build'" >&2
  exit 1
fi

if [[ -w /Applications ]]; then
  APPS_DIR=/Applications
else
  APPS_DIR="$HOME/Applications"
  mkdir -p "$APPS_DIR"
  echo "· /Applications no es escribible — instalando en ~/Applications"
fi

APP_NAME="IA Flow"
APP_DIR="$APPS_DIR/$APP_NAME.app"

# La app aparte del agent-host ya no existe: su consola es la ruta /agent-host
# de la misma SPA. Se borra la que haya quedado de una instalación anterior — la
# creó este script, así que limpiarla es su trabajo. Dejarla ahí sería un ícono
# que abre lo mismo que el de al lado.
#
# El nombre de abajo NO se renombra con el resto: es el nombre REAL del bundle
# que quedó en disco, y cambiarlo haría que este cleanup no lo encuentre nunca.
LEGACY="$APPS_DIR/IA Flow Gateway.app"
if [[ -d "$LEGACY" ]]; then
  rm -rf "$LEGACY"
  echo "· quitada la obsoleta $LEGACY (su consola es ahora /agent-host)"
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$DESKTOP_DIR/icons/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>dev.julianjab.ia-flow.desktop</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
</dict>
</plist>
PLIST

cat > "$APP_DIR/Contents/MacOS/launcher" <<LAUNCHER
#!/bin/bash
# Generado por apps/desktop/install.sh — no editar a mano.
exec "$ELECTRON_BIN" "$DESKTOP_DIR" "\$@"
LAUNCHER

chmod +x "$APP_DIR/Contents/MacOS/launcher"
touch "$APP_DIR"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP_DIR" 2>/dev/null || true

echo "✓ $APP_DIR"
echo "  electron: $ELECTRON_BIN"
echo
echo "  Abre la SPA en /servers. Elegí ahí contra qué server mirar."
