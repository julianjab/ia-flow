# IA Flow.app — el doble clic que levanta el entorno

Una app de macOS que levanta **la web de ia-flow apuntada al server que elijas**
y, si querés, **el provider gateway registrado contra ese mismo server**. Un
clic repite lo último que usaste; no pregunta nada.

## Instalar

```bash
./scripts/launcher/install.sh
```

Crea `/Applications/IA Flow.app` (o `~/Applications` si el primero no es
escribible). El bundle **no copia código**: ejecuta los `.ts` de esta carpeta
desde el repo, así que editar el launcher no requiere reinstalar. Volvé a
correr el script sólo si movés el repo o cambiás de instalación de bun.

## Usar

| Gesto | Qué hace |
| --- | --- |
| Doble clic | Levanta lo último: mismo server, mismo gateway. Sin diálogos. |
| Doble clic (ya corriendo) | Trae el navegador a la web que ya está andando, no levanta otra copia. |
| **Option** + doble clic | Vuelve a preguntar contra qué server, para la web y para el gateway. |

La primera vez pregunta, porque todavía no hay nada que repetir. Las respuestas
quedan en `$IA_FLOW_CONFIG_DIR/launcher.json` (default `~/.config/ia-flow/`).

Todo corre en una ventana de Terminal con los logs de las dos cosas
prefijados (`[web]` / `[gateway]`). **Ctrl+C ahí baja todo.**

## Qué decide solo

- **Qué servers ofrecer** — sondea `GET /api/projects` en los puertos 3000-3099
  que estén escuchando, más los publicados por containers de podman. Los nombra
  con el container o con los proyectos que devuelve el server. Nadie mantiene
  una lista.
- **Encender un runner apagado** — si elegís un container de `runners/*` que no
  está corriendo, hace `podman compose up -d` en su carpeta y espera a que su
  API conteste.
- **Puerto de la web** — reusa el de la vez pasada si está libre; si no, el
  primero libre entre 5173 y 5199. Chequea IPv4 **e** IPv6, porque un Vite
  ajeno escuchando sólo en `[::1]` no aparece si mirás nada más `127.0.0.1`.
- **Por dónde el server alcanza al gateway** — `host.containers.internal` si el
  server elegido vive en un container, `localhost` si corre en el host.
- **No pisar un gateway vivo** — si el 3002 ya está tomado, deja el que está y
  sólo levanta la web.

## Piezas

| Archivo | Qué es |
| --- | --- |
| `launch.ts` | Entrypoint del `.app`: decide server, puerto y gateway, y abre la Terminal. |
| `run.ts` | Lo que queda vivo en esa Terminal: spawnea web + gateway y multiplexa sus logs. |
| `servers.ts` | Descubrimiento de servers (puertos, containers, carpetas de compose). |
| `state.ts` | La memoria (`launcher.json`) que hace que un clic repita lo último. |
| `ui.ts` | Diálogos nativos (osascript) y apertura de Terminal. |
| `install.sh` | Arma el bundle `.app`. |

## Dos trampas de macOS que este código ya esquiva

- **PATH.** Una app lanzada por el Finder arranca con el PATH pelado del
  sistema: sin `bun`, sin `podman`, sin nada de Homebrew. `install.sh` hornea
  la ruta real de bun en el bundle, y `openInTerminal` propaga el PATH ya
  arreglado al `.command` — sin eso la ventana de Terminal moría al instante
  con `bun: command not found`.
- **Apple Events.** Manejar Terminal con AppleScript (`tell application
  "Terminal" to do script`) exige permiso de Automatización y, sin él, falla en
  **silencio**: hacés clic y no pasa nada. Por eso se escribe un `.command` y se
  abre con `open -a Terminal`, que no pide permisos.
