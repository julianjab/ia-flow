# installer/ — IAFlow.pkg

El instalador de ia-flow para una Mac sin el repo, al estilo del de mac-pulse. Deja corriendo, como LaunchAgents
del usuario:

| Label | Qué |
| --- | --- |
| `link.julianjab.ia-flow-menu` | el menú de la barra (`~/Applications/IAFlowMenu.app`, en modo instalado) |
| `link.julianjab.ia-flow-web` | la web: el build de `apps/web` servido por `apps/web/scripts/serve/serve.ts` en `localhost:5173`, con `/api` hacia el runner |
| `link.julianjab.tunnel.ia-flow-web` | el túnel de Cloudflare de la web (si hay `cloudflared` con login) |
| `link.julianjab.ia-flow-update` | el actualizador: cada 30 min mira el último release de `julianjab/ia-flow` |

## Archivos

- `build.sh [versión]` → `dist/IAFlow.pkg` y `dist/IAFlow-runtime.tar.gz` (+ `.sha256`). Lo corre el job
  `installer` de `.github/workflows/release.yml` en cada release; también sirve en local (Apple silicon).
- `scripts/postinstall` → corre `setup.sh` como el usuario de la sesión.
- `setup.sh` → copia el runtime a `~/Library/Application Support/IAFlow/versions/<versión>`, apunta `current`,
  instala el menú en `~/Applications` y (re)carga los LaunchAgents. `--remove` los baja; `--tools` instala el `Brewfile`.
- `tunnel.sh` → crea o reusa el túnel `ia-flow-web-<mac>`, apunta el DNS del host (sin `--overwrite-dns`: no le
  roba el host a otro túnel) y escribe `~/.cloudflared/ia-flow-web.yml` (métricas en `127.0.0.1:45173`, que es
  como el menú sabe si está arriba). Si otro túnel de esta Mac ya sirve el host, no hace nada.
- `update.sh` → baja la versión nueva, revisa el sha256 y corre su `setup.sh`; si la web no responde en un minuto,
  vuelve a la anterior y anota la versión en `failed`. `touch ~/.config/ia-flow/no-autoupdate` lo apaga.

## Config

`~/.config/ia-flow/web.env` (se crea la primera vez y después es tuyo): `IA_FLOW_RUNNER_URL`,
`IA_FLOW_PROXY_RUNNERS`, `IA_FLOW_WEB_PORT`, `IA_FLOW_TUNNEL_HOST`. Tras cambiarlo, reiniciá la web
(`launchctl kickstart -k gui/$(id -u)/link.julianjab.ia-flow-web`) y, si cambió el host, corré
`~/Library/Application\ Support/IAFlow/tunnel.sh`.

El túnel no crea la política de Cloudflare Access: un host sin ella queda abierto (el runner sigue pidiendo su
token; la web no).

Logs: `~/Library/Logs/ia-flow/` (`install.log`, `ia-flow-web.log`, `ia-flow-menu.log`, `ia-flow-update.log`,
`tunnel.log`).

## En una Mac con el checkout

Los labels del menú y de la web son los mismos que usan `apps/menubar/build.sh --login` y el LaunchAgent de
desarrollo: instalar el .pkg los pisa. El menú instalado muestra como servicios la web y el túnel instalados; un
`services.json` que ya existe conserva los del repo y suma esos dos.
