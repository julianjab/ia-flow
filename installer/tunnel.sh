#!/usr/bin/env bash
# El túnel de Cloudflare de la web instalada: https://$IA_FLOW_TUNNEL_HOST → localhost:$IA_FLOW_WEB_PORT, como el
# LaunchAgent link.julianjab.tunnel.ia-flow-web. Lo corre setup.sh; se puede correr a mano tras cambiar web.env.
#   tunnel.sh            crea o reusa el túnel de esta Mac, su DNS, su config y su LaunchAgent
#   tunnel.sh --remove   baja el LaunchAgent (el túnel y su DNS quedan en Cloudflare)
# Sale con 0 si no hay nada que hacer (sin host, u otro túnel de esta Mac ya sirve ese host) y con 3 si falta
# cloudflared o su login (`cloudflared tunnel login`). No crea la política de Cloudflare Access: un host sin ella
# queda abierto (el runner sigue pidiendo su token, la web no).
set -euo pipefail
CONFIG="$HOME/.config/ia-flow/web.env"
LABEL=link.julianjab.tunnel.ia-flow-web
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
YML="$HOME/.cloudflared/ia-flow-web.yml"
METRICS=127.0.0.1:45173
uid="$(id -u)"

down() { launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; }
[[ "${1:-}" == "--remove" ]] && { down; echo "túnel bajado (sigue en Cloudflare)"; exit 0; }

value() { sed -n "s/^$1=//p" "$CONFIG" 2>/dev/null | tail -1 | tr -d '"' | tr -d "'"; }
host="$(value IA_FLOW_TUNNEL_HOST)"
port="$(value IA_FLOW_WEB_PORT)"
port="${port:-5173}"
if [[ -z "$host" ]]; then down; echo "sin IA_FLOW_TUNNEL_HOST en $CONFIG: sin túnel"; exit 0; fi

cf="$(command -v cloudflared || true)"
[[ -z "$cf" && -x /opt/homebrew/bin/cloudflared ]] && cf=/opt/homebrew/bin/cloudflared
[[ -n "$cf" ]] || { echo "falta cloudflared (brew install cloudflared, o setup.sh --tools)"; exit 3; }
[[ -f "$HOME/.cloudflared/cert.pem" ]] || { echo "falta el login de Cloudflare: cloudflared tunnel login"; exit 3; }

# Otro túnel de esta Mac ya sirve el host (el de desarrollo, el daemon de root): se deja ese, que apunta al mismo puerto
for other in "$HOME"/.cloudflared/*.yml /usr/local/etc/cloudflared/config.yml /etc/cloudflared/config.yml; do
  [[ -f "$other" && "$other" != "$YML" ]] || continue
  if grep -Eq "hostname:[[:space:]]*\"?$host\"?[[:space:]]*$" "$other"; then
    down
    echo "$host ya lo sirve $other: no hace falta otro túnel"
    exit 0
  fi
done

# un túnel por Mac: dos Macs con el mismo nombre se pisarían los conectores
machine="$(scutil --get LocalHostName 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-\n' '-')"
name="ia-flow-web-${machine:-mac}"
id="$("$cf" tunnel list --name "$name" --output json 2>/dev/null | /usr/bin/python3 -c 'import json,sys; t=json.load(sys.stdin) or []; print(t[0]["id"] if t else "")')"
if [[ -z "$id" ]]; then
  "$cf" tunnel create "$name" >/dev/null
  id="$("$cf" tunnel list --name "$name" --output json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"
fi
creds="$HOME/.cloudflared/$id.json"
[[ -f "$creds" ]] || { echo "el túnel $name existe pero falta $creds (se creó en otra Mac): bórralo o cambia el nombre"; exit 4; }

# Sin --overwrite-dns: si el host ya apunta a otro túnel (otra Mac), falla y no se lo roba
if ! out="$("$cf" tunnel route dns "$id" "$host" 2>&1)"; then
  echo "no pude apuntar $host a $name: $out"
  echo "si es de otro túnel, elige otro IA_FLOW_TUNNEL_HOST en $CONFIG y corre $0"
  exit 4
fi

cat >"$YML" <<YML
# Lo escribe ~/Library/Application Support/IAFlow/tunnel.sh (instalador de ia-flow): se pisa al reinstalar.
tunnel: $id
credentials-file: $creds
metrics: $METRICS
ingress:
  - hostname: $host
    service: http://127.0.0.1:$port
  - service: http_status:404
YML

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$cf</string><string>tunnel</string><string>--no-autoupdate</string><string>--config</string><string>$YML</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ia-flow/tunnel.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ia-flow/tunnel.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do launchctl print "gui/$uid/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "gui/$uid" "$PLIST"
echo "túnel $name: https://$host → 127.0.0.1:$port (sin Cloudflare Access, el host queda abierto)"
