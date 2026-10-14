# apps/menubar

App nativa de barra de menú (macOS, Swift/AppKit, sin Dock ni ventanas) para levantar, reiniciar y
detener web, gateway y runner. ~25 MB de RAM y 0 % de CPU en reposo.

```bash
apps/menubar/build.sh            # compila a apps/menubar/dist/IAFlowMenu.app
apps/menubar/build.sh --install  # además la copia a ~/Applications
```

- Servicios: `~/.config/ia-flow-menubar/services.json` (se crea con defaults; "Editar servicios…"
  lo abre). Cada uno: `command`, `cwd`, `port`, `url`, `env` opcional. Cambios → reabrir la app.
- Logs: `~/.local/state/ia-flow/menubar/<id>.log` (fuera del repo).
- Cada servicio corre en su propio grupo de procesos: detener baja también a vite/bun hijos.
- Un puerto ocupado por algo que no lanzó la app aparece amarillo "(externo)" y no se puede iniciar.
- Salir de la app detiene los servicios que ella levantó.
- No es un workspace de bun (sin `package.json`); no pasa por `bun run check`.
