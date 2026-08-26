# apps/desktop — las apps de escritorio

Dos apps de macOS, un solo main process. Cada una levanta un proceso del repo
y muestra **su** web en una ventana:

| App | Levanta | Muestra |
| --- | --- | --- |
| **IA Flow.app** | `bun run dev:web` en `:5273` | la SPA, abierta en `/servers` |
| **IA Flow Gateway.app** | el gateway en `:3002` | su pantalla de `/` |

```bash
bun run --cwd apps/desktop install:apps   # buildea el main y crea los dos .app
bun run --cwd apps/desktop start          # o corré uno suelto, sin instalar
```

Volvé a correr `install:apps` sólo si movés el repo. Un cambio en el main
process pide `bun run --cwd apps/desktop build`; un cambio en la web o el
gateway no pide nada — se levantan del working tree en cada arranque.

## Por qué no hay diálogos nativos

Elegir contra qué server mirar, y configurar el gateway, **ya son pantallas
web** (`/servers` y la de `/` del gateway). Duplicarlas en Electron sería
mantener dos veces la misma decisión, así que el main process no pregunta
nada: levanta el proceso y muestra su UI.

Eso reemplazó al launcher anterior (`scripts/launcher/`, borrado), que hacía
lo mismo con diálogos de `osascript` y una ventana de Terminal.

**Lo que se perdió en el cambio:** aquel launcher encendía un runner de
`runners/*` apagado antes de apuntarle la web. La pantalla de servers no
puede hacerlo (el navegador no corre `podman`), así que hoy hay que levantar
el container a mano. Si molesta, la vuelta es un IPC del main process.

## Íconos

Un ícono por modo, no uno compartido: `AppIcon` para `IA Flow`, `GatewayIcon`
para `IA Flow Gateway`. De cada uno salen el `.icns` (Finder / Dock del bundle,
vía `CFBundleIconFile`) y el `.png` de 1024 que la app se pone en runtime con
`app.dock.setIcon` (`ModeConfig.icon`).

`GatewayIcon` tiene fuente vectorial (`icons/GatewayIcon.svg`); para
regenerar sus PNG + iconset + icns:

```bash
./apps/desktop/icons/render-icons.sh GatewayIcon
```

`AppIcon` no tiene SVG — sus PNG están a mano en `icons/AppIcon.iconset`, así
que ahí el paso es sólo:

```bash
iconutil -c icns apps/desktop/icons/AppIcon.iconset -o apps/desktop/icons/AppIcon.icns
```

Tras cambiar un ícono hay que re-correr `install:apps`: el `.icns` se copia
dentro del bundle, no se lee del repo.

**El nombre del menú sigue diciendo "Electron".** Estos bundles ejecutan el
binario de Electron desde afuera, y macOS toma el nombre del proceso del
bundle real que lo contiene, no del nuestro — `app.setName()` no lo cambia.
Arreglarlo pide un bundle Electron de verdad (copiar `Electron.app` y
reemplazarle Info.plist + recursos, que es lo que hace `electron-builder`):
~250MB por app en vez de un script de dos líneas.

## Detalles que no son obvios

- **Puertos fijos, no "el primero libre".** La web guarda contra qué server
  estás mirando en el `localStorage` del origen: un puerto distinto en cada
  arranque haría perder esa elección todas las veces.
- **Si el puerto ya está ocupado, no se levanta un segundo proceso** — la
  ventana se cuelga del que ya está corriendo. El chequeo prueba los **dos**
  stacks (`127.0.0.1` y `::1`): Vite escucha en `[::1]`, así que mirar sólo
  IPv4 daba "libre" con un dev server ya corriendo, se levantaba un segundo que
  moría con EADDRINUSE, y la app esperaba 60s a un puerto que nunca iba a ver
  antes de rendirse. Se veía como "la app no abre".
- **El hijo se mata también en las señales**, no sólo en `before-quit`: un
  `kill` al proceso de Electron no dispara ese evento, y ahí es exactamente
  cuando quedaba el Vite huérfano que rompía el arranque siguiente.
- **El PATH se completa a mano** al spawnear: una app abierta desde el Finder
  arranca con el PATH del sistema, sin `bun` ni nada de Homebrew.
- **Los bundles ejecutan el binario real de Electron**
  (`node_modules/electron/dist/Electron.app/…/Electron`), no el wrapper de
  `node_modules/.bin/electron`: ese wrapper es un script `#!/usr/bin/env node`
  y moría con `env: node: No such file or directory`.
- **El main se buildea a CommonJS con `--external electron`.** Sin `--external`
  bun empaqueta el paquete npm `electron` (el wrapper que devuelve la ruta del
  binario) y `app` llega `undefined`; sin `--format=cjs` + extensión `.cjs`,
  Electron lo carga como ESM y `require` no existe.
- **La ventana del gateway no pide token.** El main lee
  `API_AI_PROVIDER_TOKEN` del `.env` del gateway — es el mismo proceso que
  levanta — y lo pasa al preload por argv, que lo deja en el localStorage de
  esa ventana antes de que corran los scripts de la página. En el navegador la
  pantalla sigue pidiéndolo, porque ahí nadie puede saberlo por vos.
- **Los `.app` no copian Electron adentro** (~250MB cada uno). Para distribuir
  a otra máquina haría falta `electron-builder`; para la tuya, esto alcanza.
