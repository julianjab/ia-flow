#!/usr/bin/env bash
# Rasteriza un .svg de este directorio a su .iconset + .icns + .png de 1024.
#
#   ./apps/desktop/icons/render-icons.sh GatewayIcon
#
# Usa Chrome headless porque macOS no trae rasterizador de SVG en CLI (sips no
# lee SVG) y no queremos sumar una dependencia de build sólo para el ícono.
# Se rinde UNA vez a 1024 y de ahí bajan los tamaños con sips: escalar el PNG
# grande da mejor resultado en 16/32px que rasterizar el SVG a ese tamaño.

set -euo pipefail

NAME="${1:?uso: render-icons.sh <nombre-sin-extension>}"
ICONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVG="$ICONS_DIR/$NAME.svg"
[[ -f "$SVG" ]] || { echo "✗ no existe $SVG" >&2; exit 1; }

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x "$CHROME" ]] || { echo "✗ falta Google Chrome (rasterizador)" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$SVG" "$TMP/icon.svg"
cat > "$TMP/page.html" <<'HTML'
<style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:100vw;height:100vh}</style>
<img src="icon.svg">
HTML

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --force-device-scale-factor=1 \
  --window-size=1024,1024 --screenshot="$TMP/1024.png" \
  "file://$TMP/page.html" >/dev/null 2>&1

cp "$TMP/1024.png" "$ICONS_DIR/$NAME.png"

SET="$ICONS_DIR/$NAME.iconset"
rm -rf "$SET"; mkdir -p "$SET"
for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
            128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 \
            512:icon_256x256@2x 512:icon_512x512 1024:icon_512x512@2x; do
  px="${spec%%:*}"; out="${spec##*:}"
  sips -z "$px" "$px" "$TMP/1024.png" --out "$SET/$out.png" >/dev/null
done

iconutil -c icns "$SET" -o "$ICONS_DIR/$NAME.icns"
echo "✓ $ICONS_DIR/$NAME.icns + $NAME.png + $NAME.iconset"
