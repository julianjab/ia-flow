#!/usr/bin/env bash
# Arma installer/dist/IAFlow.pkg: el menú (IAFlowMenu.app) y la web (el build de apps/web, su servidor y su propio
# bun), para instalar en una Mac sin el repo ni bun. Al instalarlo, el postinstall deja corriendo el menú, la web y,
# si hay login de Cloudflare, su túnel (setup.sh). Al lado deja IAFlow-runtime.tar.gz (+ .sha256): lo mismo suelto,
# lo que baja el actualizador (update.sh). Lo corre el job `installer` de release.yml; también sirve en local.
#   installer/build.sh [versión]     (por defecto 0.0.0-<sha>)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
version="${1:-0.0.0-$(git -C "$repo" rev-parse --short HEAD)}"
out="$here/dist"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
bun="$(command -v bun)"
bun="$(cd "$(dirname "$bun")" && pwd -P)/$(basename "$bun")"
[[ -L "$bun" ]] && bun="$(readlink -f "$bun")"

# lo que se instala en ~/Library/Application Support/IAFlow/versions/<versión> (setup.sh lo copia desde el .pkg)
rt="$stage/root/Library/Application Support/IAFlow/pkg"
mkdir -p "$rt/bin"

# 1. el menú, en modo instalado (sin la ruta del repo: sus servicios son la web y el túnel de acá)
IA_FLOW_MENU_BUNDLED=1 "$repo/apps/menubar/build.sh" >/dev/null
cp -R "$repo/apps/menubar/dist/IAFlowMenu.app" "$rt/IAFlowMenu.app"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $version" "$rt/IAFlowMenu.app/Contents/Info.plist"
codesign --force --sign - -r='designated => identifier "dev.julianjab.ia-flow-menu"' "$rt/IAFlowMenu.app"
codesign --verify "$rt/IAFlowMenu.app"

# 2. la web: rutas relativas (el servidor proxea /api), así el mismo build anda en localhost y detrás del túnel
(cd "$repo/apps/web" && IA_FLOW_API_SAME_ORIGIN=1 "$bun" x vite build --outDir "$rt/web" --emptyOutDir >/dev/null)
"$bun" build "$repo/apps/web/scripts/serve/serve.ts" --target=bun --outfile "$rt/serve.js" >/dev/null
cp "$bun" "$rt/bin/bun"

cp "$here/setup.sh" "$here/update.sh" "$here/tunnel.sh" "$here/Brewfile" "$rt/"
echo "$version" > "$rt/VERSION"

# el mismo runtime suelto, para el actualizador
mkdir -p "$out"
tar -czf "$out/IAFlow-runtime.tar.gz" -C "$rt" .
(cd "$out" && shasum -a 256 IAFlow-runtime.tar.gz > IAFlow-runtime.tar.gz.sha256)

# 3. el paquete. No relocalizable: si no, el Installer «actualiza» la IAFlowMenu.app que encuentre en otro lado
# (la de ~/Applications o la de apps/menubar/dist) en vez de poner la suya donde va
pkgbuild --analyze --root "$stage/root" "$stage/component.plist" >/dev/null
count="$(/usr/libexec/PlistBuddy -c 'Print' "$stage/component.plist" | grep -c 'BundleIsRelocatable' || true)"
for ((i = 0; i < count; i++)); do
  /usr/libexec/PlistBuddy -c "Set :$i:BundleIsRelocatable false" "$stage/component.plist"
done
pkgbuild --root "$stage/root" --component-plist "$stage/component.plist" --scripts "$here/scripts" \
  --identifier dev.julianjab.ia-flow.pkg --version "$version" --install-location / "$out/IAFlow.pkg" >/dev/null
echo "listo: $out/IAFlow.pkg ($version, $(du -h "$out/IAFlow.pkg" | cut -f1))"
