# apps/desktop — IA Flow.app

**Una app, y es un visor.** Sirve la SPA de `apps/web` y la muestra en una
ventana; contra qué se conecta lo elegís vos en su pantalla de servers.

```bash
bun run --cwd apps/desktop start          # correrla del repo (hot reload)
bun run --cwd apps/desktop dist           # el .dmg distribuible (arm64 + x64)
bun run --cwd apps/desktop install:apps   # un .app clickeable que usa el repo
```

## No levanta el runner

La app sirve la SPA y la muestra: en dev levanta el Vite de `apps/web`
(`bun run dev:web`, puerto 5273) y empaquetada sirve el bundle que trae adentro.
Nada más. El runner (`apps/runner-v2`) corre aparte —su bundle publicado, o el
del repo— y la app se conecta al que elijas en su pantalla de servers, con el
token (`IA_FLOW_API_TOKEN`) que le configures ahí.

## Los servers y sus tokens

La lista **es config, no un descubrimiento**: agregás un server con su URL y —si
lo pide— su token, y queda guardado. El main process la persiste en
`servers.json` del directorio de datos de la app (`app.getPath('userData')`: en
macOS, `~/Library/Application Support/IA Flow`). Una lista que una versión
anterior dejó en `~/.config/ia-flow/desktop-servers.json` se copia ahí una vez
(`migrateLegacyServers`), sin borrar el original.

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
