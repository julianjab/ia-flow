# @ia-flow/provider-remote

Un `Provider` de `@ia-flow/agent-engine` que corre en **otra máquina** — un `claude` logueado,
otro disco, otra red — como si fuera un CLI local, pero contra una API. Trae las dos mitades:

- **`RemoteHub`** (el runner): la API a la que se suscriben los hosts. Cada host suscrito aparece
  en el `ProviderRegistry` como `remote:<name>` (un `RemoteProvider`); los agentes lo nombran, o
  `remote:*` (ver los comodines de `ProviderSelector`).
- **`HostClient`** (la otra máquina): se suscribe, pide tareas y corre cada una con lo que le
  pasen (`TaskRunner`); el runner-v2 lanza ahí un `claude` (`launchCli` de
  `@ia-flow/provider-anthropic-cli`).

## El runner le entrega la corrida y se desentiende

```
host   ──POST /v1/hosts/subscribe {name, maxConcurrent, accepts}──▶ runner   → remote:<name>
host   ──POST /v1/hosts/<session>/poll {running} (long-poll)──────▶ runner   ← tareas, corridas cerradas
runner:  un agente elige remote:* → canAccept (las condiciones del host) → abre el canal de la
         corrida en su API y le entrega la tarea al host → espera
host:    claude en SU worktree, con el MCP y los hooks apuntando al canal en el runner
claude ──POST /v1/runs/<token>/mcp  (tools/call submit_done)──────▶ runner   la tool corre acá → el turno cierra
host   ──POST /v1/runs/<token>/report {exited|failed}─────────────▶ runner   si la sesión terminó sin cerrarlo
```

- **Todas las conexiones las abre el host.** Sólo necesita salida: nada de URL pública ni túneles.
  El runner ya es público (recibe los webhooks de GitHub).
- **El canal de la corrida es el del CLI local** (`RunChannel` de `@ia-flow/provider-shared`),
  montado en la API del runner en vez de en `127.0.0.1`: las tools del agente por MCP, los hooks
  (la traza de las tools nativas, el inbox, no terminar sin cerrar el turno) y el cierre cuando el
  modelo llama una tool terminal. El runner no conduce nada — espera ese cierre.
- **Un solo checkout, el del host.** `remote:<name>` tiene workspace nativo: las tools de workspace
  del agente (`fs_*`, `bash_run`, …) no le llegan; `claude` trabaja su worktree con las suyas. El
  `git push` sale con las credenciales de esa máquina.

## Suscripción, vencimiento, reinicios

- `POST /v1/hosts/subscribe` con el bearer de hosts del runner (`IA_FLOW_HOST_TOKEN` en los dos
  lados). Sin token configurado, la API de hosts responde 503: nunca queda abierta por olvido.
- Cada poll renueva la suscripción. Un host que no vuelve en `leaseMs` (default 45 s) sale del
  registry, y sus corridas en curso terminan como perdidas (el engine las retoma).
- El runner se reinicia: el poll del host recibe 404 y se vuelve a suscribir solo.
- El host se reinicia: deja de listar la corrida como en curso y el runner la da por perdida; al
  retomarla, la tarea trae `session.resume` y el host cierra la sesión tmux vieja antes de lanzar.
- Las rutas de una corrida (`/v1/runs/<token>/*`) no usan el bearer: el token, al azar y uno por
  corrida, va en el path — como el servidor local del CLI. Muere con la corrida.

## Qué trabajo toma un host

Lo declara al suscribirse y lo decide **el runner** (`RemoteProvider.canAccept`), sin ir y volver:

- su tope (`maxConcurrent`) contra las corridas que tiene en curso;
- sus condiciones (`accepts`), en el mismo lenguaje que el `when` de las pipelines, contra el
  payload del evento más `agentId`, `eventType` y `scope`.

Un "no" demora la corrida o pasa al candidato siguiente (el comodín `remote:*` los prueba en orden
de suscripción; sin ninguno, el siguiente de `providers` es el respaldo).

## La telemetría del host es la del runner

El host no tiene backend propio: su SDK exporta OTLP/HTTP **JSON estándar** al runner
(`POST /v1/hosts/telemetry/{traces,logs}`, con el bearer de hosts), y el runner lo recibe con
`onTelemetry` — lo guarda en su base de actividad y lo reexporta a su collector. Para que se vea
igual que lo del runner, cada `HostTask` lleva `trace`: el `traceparent` del span del agente y
sus atributos heredados (`ia.execution.id`, `ia.issue`…). `HostClient` corre la tarea colgada de
ahí, en un span `host.run <agente>` (`ia.host.name`): el worktree, la sesión y sus logs quedan en la
misma traza y la misma ejecución que el resto de la corrida.

Lo que no es de una corrida (suscripción, un poll caído) no entra en la base, pero sí se reexporta.
Y lo que pasa cuando el host no llega al runner no puede viajar por él: queda en su consola.

## Límites conocidos

- **La transcripción queda allá.** El canal no lee el `transcript_path` (es del disco del host):
  una corrida remota no tiene los spans `chat <model>` ni el texto en vivo. Las tools (las del
  agente y las nativas, por los hooks) sí se trazan en el runner.
- **`mcpServers` viaja con sus credenciales** (resueltas en el runner): usá HTTPS.
- **Un host, un runner.** Un `HostClient` se suscribe a una base; para prestarle a dos runners,
  dos hosts.
