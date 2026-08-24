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

## Detalles que no son obvios

- **Puertos fijos, no "el primero libre".** La web guarda contra qué server
  estás mirando en el `localStorage` del origen: un puerto distinto en cada
  arranque haría perder esa elección todas las veces.
- **Si el puerto ya está ocupado, no se levanta un segundo proceso** — la
  ventana se cuelga del que ya está corriendo.
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
- **Los `.app` no copian Electron adentro** (~250MB cada uno). Para distribuir
  a otra máquina haría falta `electron-builder`; para la tuya, esto alcanza.
