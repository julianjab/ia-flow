# apps/menubar

App nativa de barra de menú (macOS, Swift/AppKit + SwiftUI, sin Electron ni Dock) para levantar, reiniciar y
detener web, gateway, runner, Grafana y túneles de julianjab.link. El clic en el ícono abre un **popover**
(SwiftUI, claro/oscuro) con los servicios agrupados en tarjetas, un switch por servicio, chips de puerto que abren
la URL y un menú ⋯ (reiniciar, abrir, log en iTerm, borrar túnel). Clic derecho o ⌥-clic: menú corto
(actualizar, editar servicios, salir). La interfaz SwiftUI sólo existe con el popover abierto: en reposo ~17 MB y 0 % de CPU.

![lista](screenshot-list-dark.png)

«Nuevo túnel» es un formulario dentro del popover (subdominio, puerto elegible entre los que están en escucha,
avisos y confirmaciones en línea):

![formulario](screenshot-form-light.png)

Estructura: `Core.swift` (config, cloudflared y API de Cloudflare), `Service.swift` (proceso, detached o adoptado),
`Model.swift` (estado y acciones), `Components.swift` y `Views.swift` (SwiftUI), `Icon.swift` (glifo), `main.swift`
(barra de estado y popover). `main.swift --screenshot <base>` regenera las capturas con datos de ejemplo
(`IA_FLOW_MENUBAR_HOME=<dir vacío>` para no tocar la config real).

```bash
apps/menubar/build.sh            # compila a apps/menubar/dist/IAFlowMenu.app
apps/menubar/build.sh --install  # además la copia a ~/Applications
apps/menubar/build.sh --login    # --install + LaunchAgent: arranca con la sesión
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
- Salir de la app (menú, `pkill`, `kill`, cerrar sesión: SIGTERM/SIGINT/SIGHUP) detiene sólo los procesos
  que ella levantó (web, gateway, runner, túneles). Un SIGKILL o un crash no pasa por ahí y los deja
  huérfanos: al reabrir, la app los reconoce (padre = launchd, líder de su grupo, mismo comando) y
  los muestra corriendo para poder detenerlos; un proceso lanzado a mano desde una terminal no se adopta.
- `IAFlowMenu --status` imprime el estado de cada servicio y sale; `IA_FLOW_MENUBAR_HOME=<dir>` aísla
  la config, los logs y los túneles en otra carpeta (para probar sin tocar los reales).
- "Ver log" abre `tail -f` en una ventana de iTerm (sin iTerm, el archivo en el editor).
- No es un workspace de bun (sin `package.json`); no pasa por `bun run check`.
- **Arranque con la sesión (`--login`):** crea `~/Library/LaunchAgents/link.julianjab.ia-flow-menu.plist`
  (`RunAtLoad`, y `KeepAlive` sólo si no salió con éxito: se relanza tras un crash o `SIGKILL`, no tras
  «Salir»). Log en `~/Library/Logs/ia-flow/menubar.log`. Para quitarlo:
  `launchctl bootout gui/$(id -u)/link.julianjab.ia-flow-menu` y borrar el plist. Una guarda de instancia
  única evita dos íconos si se abre a mano mientras launchd ya la corre. Cierre cualquier instancia abierta
  a mano antes de `--login` (con `SIGKILL` si no quiere detener lo que lanzó).
