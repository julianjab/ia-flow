# @ia-flow/provider-remote

Un `Provider` de `@ia-flow/agent-engine` que corre en **otra máquina** — otro disco, otro stack,
otra red. La corrida del agente se corre allá con el provider de ESA máquina (el CLI `claude`, la
Messages API…), igual que el runner corre los suyos. Trae las dos mitades:

- **`RemoteHub`** (el runner): la API a la que se suscriben los hosts. Cada host suscrito aparece
  en el `ProviderRegistry` como `remote:<name>` (un `RemoteProvider`); los agentes lo nombran, o
  `remote:*` (ver los comodines de `ProviderSelector`).
- **`HostClient`** (la otra máquina): se suscribe, pide tareas y corre cada una con lo que le
  pasen (`TaskRunner`); el runner-v2 la corre con su provider (`providerHost.ts`). **`RunnerLink`**
  le da a ese provider lo que necesita del runner: las tools del engine, la bandeja, la
  conversación y el texto en vivo.

## El runner le entrega la corrida y espera el resultado

```
host   ──POST /v1/hosts/subscribe {name, maxConcurrent, accepts}──▶ runner   → remote:<name>
host   ──POST /v1/hosts/<session>/poll {running} (long-poll)──────▶ runner   ← tareas, corridas cerradas
runner:  un agente elige remote:* → canAccept (las condiciones del host) → RemoteProvider.run arma
         la tarea con el ProviderRunContext del agente y se la entrega al host → espera
host:    su provider.run(ctx) sobre SU worktree
host   ──POST /v1/runs/<token>/tools {name, input}─────────────────▶ runner   una tool del engine corre acá
host   ──POST /v1/runs/<token>/inbox | conversation | text──────────▶ runner   la bandeja, la conversación, el texto
host   ──POST /v1/runs/<token>/result {output | failed}─────────────▶ runner   lo que devolvió su provider
```

- **Todas las conexiones las abre el host.** Sólo necesita salida: nada de URL pública ni túneles.
  El runner ya es público (recibe los webhooks de GitHub).
- **La tarea es el `ProviderRunContext` en JSON**: prompt, system prompts, variables,
  `providerConfig` (lo valida el provider del host), los MCP externos con su credencial resuelta,
  la conversación a retomar (`resume`, opaca: la armó el provider del host) y el evento.
- **Las tools se parten en dos.** Las del engine (`submit_*`, GitHub…) viajan como `ToolSpec` y se
  corren en el runner por `/tools`, cada una con su span. Las de workspace (`fs_*`, `bash_run`)
  viajan como `WorkspaceToolSpec`, con su `origin` (la acción y sus `options`), y el host las rearma
  sobre su worktree si su provider las usa; una sin `origin` no viaja. Por eso `RemoteProvider`
  declara `workspace: 'runner'`: necesita verlas para mandar su origen.
- **El host decide con qué corre.** El runner no sabe qué provider tiene el host, ni le importa.
- **El resultado vuelve tal cual** (`ProviderRunOutput`). Un host que no pudo correrla devuelve
  `failed` con el motivo.
- **Un solo checkout, el del host.** El `git push` sale con las credenciales de esa máquina.

## Suscripción, vencimiento, reinicios

- `POST /v1/hosts/subscribe` con el bearer de hosts del runner (`IA_FLOW_HOST_TOKEN` en los dos
  lados). Sin token configurado, la API de hosts responde 503: nunca queda abierta por olvido.
- Cada poll renueva la suscripción. Un host que no vuelve en `leaseMs` (default 45 s) sale del
  registry, y sus corridas en curso terminan como perdidas (el engine las retoma).
- El runner se reinicia: el poll del host recibe 404 y se vuelve a suscribir solo. Un agente que
  nombra `remote:<name>` espera a que su host vuelva (`ProviderRegistry.expectDynamic`).
- El host se reinicia: deja de listar la corrida como en curso y el runner la da por perdida; al
  retomarla, la tarea trae `resume` con la conversación que el provider del host fue guardando.
- El runner da una corrida por terminada (venció, se perdió): se la saca al host en el poll
  (`closed`) y `HostClient` aborta su `signal` (`CLOSED_BY_RUNNER`): el provider se corta
  (`ProviderRunContext.signal`) y su resultado ya no se manda.
- Las rutas de una corrida (`/v1/runs/<token>/*`) no usan el bearer: el token, al azar y uno por
  corrida, va en el path. Muere con la corrida.

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
ahí, en un span `host.run <agente>` (`ia.host.name`): el worktree, lo que hace el provider (los
requests al modelo, las tools nativas y los hooks del CLI) y sus logs quedan en la misma traza y la
misma ejecución que el resto de la corrida.

Lo que no es de una corrida (suscripción, un poll caído) no entra en la base, pero sí se reexporta.
Y lo que pasa cuando el host no llega al runner no puede viajar por él: queda en su consola.

## Límites conocidos

- **`mcpServers` viaja con sus credenciales** (resueltas en el runner): usá HTTPS.
- **El provider del host decide qué MCP sabe usar.** La Messages API sólo habla con MCP remotos
  por HTTP (el MCP connector); un MCP stdio (Playwright) necesita el CLI.
- **`run_agent` no corre en un host**: delega en un provider del runner.
- **Un host, un runner.** Un `HostClient` se suscribe a una base; para trabajar para dos runners,
  dos hosts.
