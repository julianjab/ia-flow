#!/usr/bin/env bash
# Notificación de escritorio en macOS para las acciones `script` del engine.
#
# Se usa desde una regla (acción `script`, runtime `bash`) y recibe todo por
# argv — nunca por una shell, así que un título con espacios o `;` sigue siendo
# un argumento. El env que llega es sólo el que la acción declara, más PATH.
#
#   uso: notify-macos.sh <titulo> <subtitulo> <mensaje>
#
# Preferimos `terminal-notifier` (brew) sobre `osascript`: en macOS moderno
# "Script Editor" (el dueño de las notificaciones de osascript) ni siquiera
# aparece en Configuración > Notificaciones, así que su banner es imposible
# de habilitar. `terminal-notifier` sí es controlable ahí. Si no está
# instalado, cae a `osascript` para no depender de un `brew install` en la
# máquina donde corre el daemon.
set -euo pipefail

title="${1:-ia-flow}"
subtitle="${2:-}"
message="${3:-}"

if command -v terminal-notifier >/dev/null 2>&1; then
  terminal-notifier -title "$title" -subtitle "$subtitle" -message "$message" -sound Ping
else
  # Escapar backslashes y comillas: el AppleScript se arma como texto y un
  # título con `"` lo rompería.
  esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
  osascript -e "display notification \"$(esc "$message")\" with title \"$(esc "$title")\" subtitle \"$(esc "$subtitle")\" sound name \"Ping\""
fi
echo "notificado: ${title} — ${subtitle}"
