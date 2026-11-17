#!/usr/bin/env bash
# Compila la barra de menú a dist/IAFlowMenu.app.
# Uso: apps/menubar/build.sh [--install | --login]
#   IA_FLOW_MENU_BUNDLED=1  la del instalador (installer/build.sh): sin la ruta del repo, con los servicios de la
#                           web y el túnel instalados (Core.swift, `isInstalled`)
#   --install  la copia a ~/Applications
#   --login    --install + LaunchAgent link.julianjab.ia-flow-menu: arranca con la sesión y se relanza si
#              se cae (no si se sale con «Salir»). Cierre antes cualquier instancia abierta a mano.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
app="$here/dist/IAFlowMenu.app"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
swiftc -O -o "$app/Contents/MacOS/IAFlowMenu" "$here"/*.swift

# Ícono de app de la marca: el mismo binario dibuja los PNG (--icon <px> <ruta>) y iconutil arma el .icns.
mkdir -p "$app/Contents/Resources"
iconset="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  "$app/Contents/MacOS/IAFlowMenu" --icon "$s" "$iconset/icon_${s}x${s}.png"
  "$app/Contents/MacOS/IAFlowMenu" --icon "$((s * 2))" "$iconset/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>IAFlowMenu</string>
  <key>CFBundleIdentifier</key><string>dev.julianjab.ia-flow-menu</string>
  <key>CFBundleExecutable</key><string>IAFlowMenu</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <!-- el dictado de los chats del asistente (Voice.swift) -->
  <key>NSMicrophoneUsageDescription</key><string>Para dictarle preguntas al asistente.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Para convertir en texto lo que le dictás al asistente.</string>
  <!-- el runner local habla http (localhost:3001, otra máquina de la red) -->
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>IAFlowRoot</key><string>$root</string>
</dict></plist>
PLIST
if [[ "${IA_FLOW_MENU_BUNDLED:-}" == 1 ]]; then
  /usr/libexec/PlistBuddy -c "Delete :IAFlowRoot" -c "Add :IAFlowBundled bool true" "$app/Contents/Info.plist"
fi
# El requisito por identificador (y no por el hash de esta firma ad hoc): el permiso del micrófono se ata a él, así
# una versión nueva no lo vuelve a pedir.
codesign --force --sign - -r='designated => identifier "dev.julianjab.ia-flow-menu"' "$app" >/dev/null 2>&1 || true
echo "listo: $app"

if [[ "${1:-}" == "--install" || "${1:-}" == "--login" ]]; then
  rm -rf "$HOME/Applications/IAFlowMenu.app"
  mkdir -p "$HOME/Applications"
  cp -R "$app" "$HOME/Applications/"
  echo "instalada en ~/Applications/IAFlowMenu.app"
fi

if [[ "${1:-}" == "--login" ]]; then
  label="link.julianjab.ia-flow-menu"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/ia-flow"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$HOME/Applications/IAFlowMenu.app/Contents/MacOS/IAFlowMenu</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ia-flow/menubar.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ia-flow/menubar.log</string>
</dict>
</plist>
PLIST
  # bootout manda SIGTERM a la app, que tarda en cerrar (detiene lo que levantó): se espera a que launchd
  # la desregistre antes de volver a cargarla, y se reintenta el bootstrap por si aún no terminó.
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  for _ in $(seq 1 30); do
    launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break
    sleep 0.5
  done
  loaded=0
  for _ in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then loaded=1; break; fi
    sleep 1
  done
  if [[ "$loaded" != 1 ]]; then
    echo "no se pudo cargar el LaunchAgent: launchctl bootstrap gui/$(id -u) $plist" >&2
    exit 1
  fi
  echo "LaunchAgent $label cargado (arranca con la sesión)"
fi
