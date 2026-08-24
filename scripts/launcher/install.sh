#!/usr/bin/env bash
# Crea (o actualiza) /Applications/IA Flow.app — el doble clic que levanta la
# web de ia-flow contra el server que elijas, más el provider gateway.
#
#   ./scripts/launcher/install.sh
#
# El .app es un wrapper mínimo: NO copia código adentro, ejecuta los .ts de
# esta carpeta desde el repo. Actualizar el launcher = editar el .ts, sin
# reinstalar nada. Sólo hay que volver a correr esto si movés el repo de lugar
# o cambiás de instalación de bun.

set -euo pipefail

APP_NAME="IA Flow"
LAUNCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LAUNCHER_DIR/../.." && pwd)"

# Una app abierta desde el Finder hereda un PATH mínimo (sin ~/.bun, sin
# /opt/homebrew), así que la ruta de bun se resuelve ahora y se hornea en el
# script del bundle.
BUN_BIN="$(command -v bun || true)"
if [[ -z "$BUN_BIN" ]]; then
  echo "✗ no encontré 'bun' en el PATH — instalalo antes de correr esto" >&2
  exit 1
fi

if [[ -w /Applications ]]; then
  APP_DIR="/Applications/$APP_NAME.app"
else
  APP_DIR="$HOME/Applications/$APP_NAME.app"
  mkdir -p "$HOME/Applications"
  echo "· /Applications no es escribible — instalando en ~/Applications"
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>dev.julianjab.ia-flow.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <!-- Sin ventana propia: todo lo visual son diálogos de osascript y la
       ventana de Terminal que abre. Sin esto quedaría un ícono muerto
       rebotando en el Dock mientras corre. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

BUN_DIR="$(dirname "$BUN_BIN")"

cat > "$APP_DIR/Contents/MacOS/launcher" <<LAUNCHER
#!/bin/bash
# Generado por scripts/launcher/install.sh — no editar a mano.
# El código real vive en $LAUNCHER_DIR/launch.ts.
#
# Una app lanzada desde el Finder arranca con el PATH pelado del sistema: no
# tiene bun, ni podman, ni nada de Homebrew. Sin esta línea el launcher no
# encuentra los containers (podman) y la ventana de Terminal muere en el acto
# con "bun: command not found".
export PATH="$BUN_DIR:/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "$BUN_BIN" "$LAUNCHER_DIR/launch.ts" "\$@"
LAUNCHER

chmod +x "$APP_DIR/Contents/MacOS/launcher"

# El Finder cachea bundles por ruta: sin esto puede seguir mostrando el
# anterior hasta el próximo login.
touch "$APP_DIR"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP_DIR" 2>/dev/null || true

echo "✓ $APP_DIR"
echo "  repo: $REPO_ROOT"
echo "  bun:  $BUN_BIN"
echo
echo "  Doble clic           → levanta lo último que usaste"
echo "  Option + doble clic  → vuelve a preguntar contra qué server"
