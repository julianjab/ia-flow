#!/usr/bin/env bash
# Deja ia-flow andando desde el runtime del .pkg (o de una versión que bajó update.sh): el menú, la web y su túnel
# como LaunchAgents del usuario, más el actualizador. Lo corre el postinstall; se puede correr a mano.
#   setup.sh            instala / reinstala (pisa los LaunchAgents de un checkout de desarrollo con el mismo label)
#   setup.sh --tools    las herramientas del Brewfile (gh, cloudflared; necesita Homebrew)
#   setup.sh --remove   baja y borra los LaunchAgents y la app (la config de ~/.config/ia-flow se queda)
# El código que corre no es el del .pkg (es de root: actualizarlo pediría la contraseña) sino una copia en
# ~/Library/Application Support/IAFlow/versions/<versión>, con el enlace `current` a la que corre; el menú se copia a
# ~/Applications/IAFlowMenu.app. Así update.sh instala las versiones nuevas sin root.
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
# el Installer corre el postinstall en una carpeta temporal que borra al terminar
cd "$HOME"
SUPPORT="$HOME/Library/Application Support/IAFlow"
CONFIG="$HOME/.config/ia-flow"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/ia-flow"
MENU=link.julianjab.ia-flow-menu
WEB=link.julianjab.ia-flow-web
UPDATE=link.julianjab.ia-flow-update
TUNNEL=link.julianjab.tunnel.ia-flow-web
APP="$HOME/Applications/IAFlowMenu.app"
uid="$(id -u)"
echo "== $(date '+%F %T') ia-flow $(cat "$src/VERSION" 2>/dev/null) desde $src"

notify() { osascript -e "display notification \"$2\" with title \"$1\"" 2>/dev/null || true; }
trap 'notify "ia-flow no quedó instalado" "Falló la línea $LINENO: mira ~/Library/Logs/ia-flow/install.log"' ERR
mkdir -p "$AGENTS" "$LOGS" "$CONFIG"

# bootout manda SIGTERM y launchd tarda en soltar el label: se espera antes de volver a cargarlo
reload() {
  local label="$1"
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  for _ in $(seq 1 30); do launchctl print "gui/$uid/$label" >/dev/null 2>&1 || break; sleep 0.5; done
  for _ in 1 2 3 4 5; do launchctl bootstrap "gui/$uid" "$AGENTS/$label.plist" 2>/dev/null && return 0; sleep 1; done
  echo "no se pudo cargar $label" >&2
  return 1
}

if [[ "${1:-}" == "--tools" ]]; then
  brew=/opt/homebrew/bin/brew
  [[ -x "$brew" ]] || brew="$(command -v brew || true)"
  [[ -x "$brew" ]] || { echo "sin Homebrew"; notify "ia-flow" "Sin Homebrew: instala gh y cloudflared a mano"; exit 1; }
  HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 "$brew" bundle --file "$src/Brewfile" --no-upgrade || true
  exit 0
fi

if [[ "${1:-}" == "--remove" ]]; then
  for label in "$UPDATE" "$TUNNEL" "$WEB" "$MENU"; do
    launchctl bootout "gui/$uid/$label" 2>/dev/null || true
    rm -f "$AGENTS/$label.plist"
  done
  rm -rf "$APP"
  echo "listo: quedan $SUPPORT y $CONFIG"
  exit 0
fi

# 1. esta versión pasa a ser la que corre (instalar el .pkg es elegirla, aunque el actualizador tuviera una más nueva)
version="$(cat "$src/VERSION")"
if [[ "$src" != "$SUPPORT/versions/"* ]]; then
  mkdir -p "$SUPPORT/versions"
  rsync -a --delete "$src/" "$SUPPORT/versions/$version/"
fi
ln -sfh "$SUPPORT/versions/$version" "$SUPPORT/current"
rt="$SUPPORT/current"
# bun y los scripts en rutas fijas: los LaunchAgents no cambian de una versión a otra
mkdir -p "$SUPPORT/bin"
cmp -s "$rt/bin/bun" "$SUPPORT/bin/bun" || { cp "$rt/bin/bun" "$SUPPORT/bin/bun.new" && chmod +x "$SUPPORT/bin/bun.new" && mv -f "$SUPPORT/bin/bun.new" "$SUPPORT/bin/bun"; }
for f in update.sh tunnel.sh; do cp "$rt/$f" "$SUPPORT/$f.new" && chmod +x "$SUPPORT/$f.new" && mv -f "$SUPPORT/$f.new" "$SUPPORT/$f"; done
[[ -f "$SUPPORT/failed" ]] && { grep -vx "$version" "$SUPPORT/failed" >"$SUPPORT/failed.new" || true; mv -f "$SUPPORT/failed.new" "$SUPPORT/failed"; }

# 2. la config de la web, la primera vez (después es del usuario)
if [[ ! -f "$CONFIG/web.env" ]]; then
  cat >"$CONFIG/web.env" <<'ENV'
# La web instalada de ia-flow (link.julianjab.ia-flow-web). Tras cambiarla:
#   launchctl kickstart -k gui/$(id -u)/link.julianjab.ia-flow-web
# El runner al que la web le pasa /api:
IA_FLOW_RUNNER_URL=http://localhost:3001
# Runners extra, cada uno bajo /<nombre>/ (nombre=URL,…):
# IA_FLOW_PROXY_RUNNERS=prod=https://runner.interno
IA_FLOW_WEB_PORT=5173
# El hostname del túnel de Cloudflare (tunnel.sh). Vacío: sin túnel.
IA_FLOW_TUNNEL_HOST=app.julianjab.link
ENV
fi

# la web lee web.env en cada arranque: un cambio sólo pide reiniciarla
cat >"$SUPPORT/web.sh" <<'SH'
#!/bin/bash
set -a
[[ -f "$HOME/.config/ia-flow/web.env" ]] && . "$HOME/.config/ia-flow/web.env"
set +a
support="$HOME/Library/Application Support/IAFlow"
exec "$support/bin/bun" "$support/current/serve.js"
SH
chmod +x "$SUPPORT/web.sh"

plist() { # label, programa, extra (claves del plist)
  cat >"$AGENTS/$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
$3
  <key>StandardOutPath</key><string>$LOGS/${1##*.}.log</string>
  <key>StandardErrorPath</key><string>$LOGS/${1##*.}.log</string>
</dict>
</plist>
PLIST
}

# 3. la web
plist "$WEB" "<string>/bin/bash</string><string>$SUPPORT/web.sh</string>" "  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>"
reload "$WEB"

# 4. el menú: arranca con la sesión y se relanza tras un crash, no tras «Salir»
mkdir -p "$HOME/Applications"
launchctl bootout "gui/$uid/$MENU" 2>/dev/null || true
rsync -a --delete "$rt/IAFlowMenu.app/" "$APP/"
plist "$MENU" "<string>$APP/Contents/MacOS/IAFlowMenu</string>" "  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>"
reload "$MENU"

# 5. el actualizador: cada media hora
plist "$UPDATE" "<string>/bin/bash</string><string>$SUPPORT/update.sh</string>" "  <key>StartInterval</key><integer>1800</integer>
  <key>ProcessType</key><string>Background</string>"
reload "$UPDATE"

# 6. el túnel, si hay con qué (cloudflared con login): no lo tener no es un error de la instalación
"$SUPPORT/tunnel.sh" || echo "sin túnel: $SUPPORT/tunnel.sh lo explica"

port="$(sed -n 's/^IA_FLOW_WEB_PORT=//p' "$CONFIG/web.env" | tail -1)"
port="${port:-5173}"
for _ in $(seq 1 20); do curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null && break; sleep 1; done
if curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
  notify "ia-flow $version" "El menú y la web (localhost:$port) están corriendo"
else
  notify "ia-flow" "La web no arrancó: mira ~/Library/Logs/ia-flow/ia-flow-web.log"
fi
