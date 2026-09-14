# apps/desktop — IA Flow.app

**Una app, y es un visor.** Sirve la SPA de `apps/web` y la muestra en una
ventana; contra qué se conecta lo elegís vos en su pantalla de servers.

```bash
bun run --cwd apps/desktop start          # correrla del repo (hot reload)
bun run --cwd apps/desktop dist           # el .dmg distribuible (arm64 + x64)
bun run --cwd apps/desktop install:apps   # un .app clickeable que usa el repo
```

## Levantar procesos — sólo los 4 del monorepo, sólo en dev

Esto decía que la app no levantaba nada, a propósito: antes eran **dos** apps
(`IA Flow` levantaba el dev server de la web, `IA Flow AgentHost` el
agent-host y su consola) y se unificaron cuando la consola del agent-host
dejó de ser un bundle aparte — hoy es la ruta `/agent-host` de la misma SPA,
así que dos ventanas para la misma información era pura duplicación. Esa
decisión sigue en pie: la app sigue sin arrancar nada para conectarse a un
server publicado, y el bundle **empaquetado** (`.dmg`) no trae el repo, así
que no puede levantar nada tampoco.

Lo que cambió es el panel **"Procesos locales"** (ruta `/devctl`, sólo útil
corriendo `bun run --cwd apps/desktop start` desde el repo): controla los 4
procesos del monorepo — server (3001), web (5173), agent-host de frontend
(3002) y agent-host de backend e2e (3003) — con el modo (`dev` con watch, o
`run`) y el puerto elegidos a mano. Reemplaza tener 4 terminales abiertas, no
reintroduce las dos apps viejas: sigue siendo una sola ventana, un solo
`.app`, y la lógica de spawn/kill (`src/devctl.ts`) es un módulo aparte,
testeable sin Electron — igual que `servers-store.ts`.

- **Sólo en dev.** `registerDevctlIpc` registra los handlers igual
  empaquetado (un `invoke` sin handler del lado del renderer rechaza feo),
  pero `devctl:start` devuelve un error explícito si `app.isPackaged` — no
  hay `apps/server` ni `apps/web` adentro del bundle para spawnear.
- **Sólo lo que esta app levantó se puede parar desde acá.** Si el puerto ya
  tiene algo (lo levantaste vos en otra terminal), el panel lo muestra como
  ocupado pero no ofrece "detener" — no hay forma segura de saber que ese
  proceso es tuyo.
- **Mismo guard que los tokens de servers** (`fromOurPage` en main.ts,
  `--ia-flow-trusted` en preload.ts): spawnear procesos en tu máquina es al
  menos tan sensible como leer un token, así que sólo una página servida por
  esta misma app ve el bridge.
- **Se matan solos al cerrar la app** (`stopAll()`, junto al `killChild()`
  que ya existía) — atendido también en señales (`SIGTERM`/`SIGINT`/`SIGHUP`),
  no sólo `before-quit`, por el mismo motivo que el resto de este archivo: un
  `kill`/`pkill` al proceso de Electron no dispara ese evento.

## Los servers y sus tokens

La lista **es config, no un descubrimiento**: agregás un server con su URL y —si
lo pide— su token, y queda guardado. El main process la persiste en
`<IA_FLOW_CONFIG_DIR>/desktop-servers.json`, al lado del `agent-host.json` y del
`ia-flow.sqlite`.

En un archivo y no en el `localStorage` de la ventana porque es config:
sobrevive a limpiar datos del sitio, se puede editar a mano, y no vive adentro
del perfil de Chromium. El puente es `contextBridge` (`src/preload.ts`), así que
la página no gana acceso a Node — sólo a esas dos operaciones, sobre un path
que elige el main.

Corriendo la web en un browser (`bun run dev:web`) no hay puente y se cae a
`localStorage`, que es lo único que hay ahí.

## Dev vs. empaquetado

|  | dev (`app.isPackaged === false`) | empaquetado |
| --- | --- | --- |
| la SPA | `bun run dev:web` del repo, con hot reload | `Contents/Resources/web`, servida por la app |

`parseMode()` devuelve `'web'` sin mirar argv cuando está empaquetado: el único
bundle que se publica es este, y depender de un default dejaría que cambiarlo
redefina en silencio qué hace el artefacto.

## Detalles que no son obvios

- **El puerto es fijo (5273), no "el primero libre".** La elección de server
  vive en el `localStorage` del origen: un puerto distinto en cada arranque la
  haría perder todas las veces.
- **Si el puerto ya está ocupado, la ventana se cuelga de lo que haya ahí** — y
  apunta a `localhost`, NO a `127.0.0.1`. `isPortTaken` prueba los dos stacks,
  así que da true también para Vite, que escucha sólo en `[::1]`; con la IPv4
  hardcodeada la ventana abría con ERR_CONNECTION_REFUSED.
- **El hijo se mata también en las señales**, no sólo en `before-quit`: un
  `kill` al proceso de Electron no dispara ese evento, y ahí es exactamente
  cuando quedaba el Vite huérfano que rompía el arranque siguiente.
- **El PATH se completa a mano** al spawnear: una app abierta desde el Finder
  arranca con el del sistema, sin `bun` ni nada de Homebrew.
- **El main se buildea a CommonJS con `--external electron`.** Sin `--external`
  bun empaqueta el paquete npm `electron` (el wrapper que devuelve la ruta del
  binario) y `app` llega `undefined`; sin `--format=cjs` + extensión `.cjs`,
  Electron lo carga como ESM y `require` no existe.
- **`electronVersion` va explícito en electron-builder.yml.** Bun hoistea
  `electron` a la raíz del workspace y electron-builder no lo encuentra donde
  lo busca.
- **`npmRebuild: false`.** Sin eso, electron-builder intenta ejecutar el binario
  `bun` con node y revienta con un `SyntaxError` que no menciona a Bun.

## Íconos

`AppIcon` — el `.icns` para el Finder y el Dock del bundle, y el `.png` de 1024
que la app se pone en runtime con `app.dock.setIcon`.

```bash
iconutil -c icns apps/desktop/icons/AppIcon.iconset -o apps/desktop/icons/AppIcon.icns
```

`AgentHostIcon` se fue con la segunda app: no lo referenciaba ya nada, y un
ícono que nadie usa es sólo 280 KB de confusión sobre si hay dos apps. Está en
el historial si alguna vez vuelve a hacer falta.
