#!/usr/bin/env bash
# Actualiza solo el ia-flow instalado con el .pkg: cada media hora (LaunchAgent link.julianjab.ia-flow-update) mira
# el último release de GitHub; si es más nuevo que el que corre, baja IAFlow-runtime.tar.gz, revisa su sha256, lo
# deja en versions/<versión> y lo pone a correr con setup.sh (el menú, la web y el túnel). Si la web nueva no
# responde en un minuto, vuelve a la versión anterior y no reintenta esa. Sin root: todo vive en la carpeta del usuario.
#   update.sh            revisa y actualiza si hay versión nueva
#   update.sh --check    sólo dice si hay una nueva
# Apagarlo: `touch ~/.config/ia-flow/no-autoupdate`.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO="${IA_FLOW_REPO:-julianjab/ia-flow}"
SUPPORT="$HOME/Library/Application Support/IAFlow"
CONFIG="$HOME/.config/ia-flow"
KEEP=3

log() { echo "== $(date '+%F %T') $*"; }
notify() { osascript -e "display notification \"$2\" with title \"$1\"" 2>/dev/null || true; }

[[ -f "$CONFIG/no-autoupdate" && "${1:-}" != "--check" ]] && { log "apagado ($CONFIG/no-autoupdate)"; exit 0; }
[[ -L "$SUPPORT/current" ]] || { log "sin $SUPPORT/current: instala el .pkg una vez"; exit 0; }

# una sola corrida a la vez (mkdir es atómico); un candado de más de una hora es de una corrida que murió
lock="$SUPPORT/update.lock"
if ! mkdir "$lock" 2>/dev/null; then
  if [[ -n "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ]]; then rm -rf "$lock"; mkdir "$lock"; else log "otra corrida en curso"; exit 0; fi
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$lock" "$tmp"' EXIT

current="$(cat "$SUPPORT/current/VERSION" 2>/dev/null || echo 0.0.0)"
# el repo es público: sin gh ni token. /releases/latest es el último publicado que no es pre-release
tag="$(curl -fsSL --max-time 20 "https://api.github.com/repos/$REPO/releases/latest" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])' 2>/dev/null)" \
  || { log "no pude leer el último release de $REPO"; exit 0; }
latest="${tag#v}"

# sólo hacia adelante: 2.40.0 > 2.9.0 (sort -V); una versión que ya falló no se reintenta
newer() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]; }
if ! newer "$latest" "$current"; then log "al día ($current)"; exit 0; fi
if grep -qsx "$latest" "$SUPPORT/failed"; then log "$latest ya falló antes: espero la siguiente"; exit 0; fi
if [[ "${1:-}" == "--check" ]]; then echo "hay una nueva: $latest (corre $current)"; exit 0; fi

base="https://github.com/$REPO/releases/download/$tag"
if ! curl -fsSL --max-time 300 -o "$tmp/IAFlow-runtime.tar.gz" "$base/IAFlow-runtime.tar.gz" \
  || ! curl -fsSL --max-time 30 -o "$tmp/IAFlow-runtime.tar.gz.sha256" "$base/IAFlow-runtime.tar.gz.sha256"; then
  # un release sin el instalador (el job todavía corre, o falló): se reintenta en la próxima vuelta
  log "$tag no trae IAFlow-runtime.tar.gz (todavía)"
  exit 0
fi
log "actualizando $current → $latest"
want="$(awk '{print $1}' "$tmp/IAFlow-runtime.tar.gz.sha256")"
got="$(shasum -a 256 "$tmp/IAFlow-runtime.tar.gz" | awk '{print $1}')"
[[ -n "$want" && "$want" == "$got" ]] || { log "el sha256 no coincide ($got ≠ $want)"; echo "$latest" >>"$SUPPORT/failed"; exit 1; }

dest="$SUPPORT/versions/$latest"
rm -rf "$dest.part" && mkdir -p "$dest.part"
tar -xzf "$tmp/IAFlow-runtime.tar.gz" -C "$dest.part"
[[ "$(cat "$dest.part/VERSION")" == "$latest" && -x "$dest.part/bin/bun" && -f "$dest.part/serve.js" && -d "$dest.part/IAFlowMenu.app" ]] \
  || { log "el paquete no trae lo esperado"; echo "$latest" >>"$SUPPORT/failed"; exit 1; }
rm -rf "$dest" && mv "$dest.part" "$dest"

prev="$(readlink "$SUPPORT/current")"
port="$(sed -n 's/^IA_FLOW_WEB_PORT=//p' "$CONFIG/web.env" 2>/dev/null | tail -1)"
port="${port:-5173}"
healthy() {
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$port/manifest.webmanifest" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# setup.sh de la versión nueva: la pone en `current`, reinstala el menú y reinicia la web
# (IA_FLOW_FROM_UPDATER: que no recargue el job del actualizador, que es el que está corriendo esto)
export IA_FLOW_FROM_UPDATER=1
if "$dest/setup.sh" && healthy && sleep 10 && healthy; then
  # quedan las $KEEP más nuevas (la que corre siempre entre ellas)
  vers=()
  # shellcheck disable=SC2010 # los nombres son versiones (2.38.0)
  while IFS= read -r v; do vers+=("$v"); done < <(ls -1 "$SUPPORT/versions" | grep -v '\.part$' | sort -V)
  for ((i = 0; i < ${#vers[@]} - KEEP; i++)); do
    [[ "$SUPPORT/versions/${vers[i]}" == "$dest" ]] || rm -rf "${SUPPORT:?}/versions/${vers[i]}"
  done
  log "listo: corre $latest"
else
  log "$latest no respondió: vuelvo a $prev"
  echo "$latest" >>"$SUPPORT/failed"
  "$prev/setup.sh" || true
  notify "ia-flow" "La versión $latest no arrancó: sigo con $current"
  exit 1
fi
