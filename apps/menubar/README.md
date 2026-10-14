# apps/menubar

App nativa de barra de menú (macOS, Swift/AppKit, sin Dock ni ventanas) para levantar, reiniciar y
detener web, gateway y runner. ~25 MB de RAM y 0 % de CPU en reposo.

```bash
apps/menubar/build.sh            # compila a apps/menubar/dist/IAFlowMenu.app
apps/menubar/build.sh --install  # además la copia a ~/Applications
```

- La web corre en modo normal (`vite build` + `vite preview`), sin watch ni HMR; gateway y runner no hacen watch.
- Servicios: `~/.config/ia-flow-menubar/services.json` (se crea con defaults; "Editar servicios…"
  lo abre). Cada uno: `command`, `cwd`, `port`, `url`, `env` opcional. Cambios → reabrir la app.
- Logs: `~/.local/state/ia-flow/menubar/<id>.log` (fuera del repo).
- Cada servicio corre en su propio grupo de procesos: detener baja también a vite/bun hijos.
- Un puerto ocupado por algo que no lanzó la app aparece amarillo "(externo)" y no se puede iniciar.
- **Túneles bajo julianjab.link:** «Nuevo túnel…» pide subdominio y puerto (elegible entre los puertos en
  escucha), crea un túnel de cloudflared (`menubar-<sub>`) con su DNS y lo inicia. Detener sólo
  detiene el proceso (el túnel y el DNS quedan, así que iniciar es instantáneo); salir de la app
  también los detiene. Los túneles quedan en `~/.config/ia-flow-menubar/tunnels.json`.
  «Borrar túnel» lo elimina de cloudflared y borra su CNAME en Cloudflare (sólo el que apunta a ese
  túnel) usando `cloudflare-zone-id` y `cloudflare-token` (permiso Zone·DNS·Edit) de esa carpeta; sin
  token borra el túnel y el CNAME queda. Si el subdominio ya tiene un registro DNS pregunta antes de
  reapuntarlo. Exponen el puerto SIN autenticación.
- Grafana (OTel, vía `podman compose`) y el proxy OTLP (LaunchAgent, vía `launchctl`) son servicios
  "detached" (`stopCommand` en el JSON): su estado sale del puerto y siguen vivos al salir de la app.
- Salir de la app detiene sólo los procesos que ella levantó (web, gateway, runner).
- "Ver log" abre `tail -f` en una ventana de iTerm (sin iTerm, el archivo en el editor).
- No es un workspace de bun (sin `package.json`); no pasa por `bun run check`.
