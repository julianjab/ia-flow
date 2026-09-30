# @ia-flow/provider-remote

Un `Provider` de `@ia-flow/agent-engine` que corre en **otra máquina**. Trae las dos mitades:

- **`RemoteProvider`** (el runner): para el engine es un provider más. `canAccept` le pregunta
  al host si puede tomar la corrida; `run` la abre allá y la sigue hasta que termina.
- **`RemoteProviderHost`** (la otra máquina): expone por HTTP cualquier `Provider` local
  (`AnthropicProvider`, `ClaudeCliProvider`, …). Es un handler de `fetch`:

```ts
// el host
const host = new RemoteProviderHost({
  providers: [new ClaudeCliProvider({ id: 'claude-cli', cwd, mode: 'print' })],
  token: process.env.IA_FLOW_PROVIDER_HOST_TOKEN,
  admit: admissionRules([{ field: 'repo', op: 'matches', value: 'la-haus/*' }]),
})
Bun.serve({ port: 3002, fetch: host.fetch })

// el runner
providerRegistry.register(
  new RemoteProvider({ id: 'gpu-box', provider: 'claude-cli', url: 'http://gpu-box:3002', token }),
)
```

Es el `RemoteAgentProvider` + `apps/agent-host` de ia-flow v1, sobre el contrato nuevo.

## Las tools corren en el runner

Las tools de un agente (sus actions, `submit_*`, `fail_turn`, `wait_for_event`) son funciones del
runner: eligen la salida, escriben en GitHub con su identidad. No viajan. El host le da al
provider de allá **proxies**: cuando el modelo llama una, el host la publica como evento
`tool_call`; el runner la levanta en su próximo sync, la corre con el `ctx` de la corrida y manda
el resultado en el siguiente. Un error de la tool vuelve como excepción del proxy — el provider
de allá lo trata igual que a una tool propia que tira.

**Nadie más que el runner inicia conexiones.** En v1 el agent-host se conectaba de vuelta al
`/api/mcp` del daemon, con lo que había que publicarle una URL y mandarle un token con permisos
de escritura sobre el daemon. Acá las tools van y vuelven por el mismo sync: el host no necesita
alcanzar al runner ni tener con qué autenticarse contra él.

## El protocolo

Todo con `Authorization: Bearer <token>` (ver `src/protocol.ts`, en zod, lo validan los dos lados):

| | |
| --- | --- |
| `GET /v1/providers` | qué expone el host y cuánto tiene corriendo |
| `GET /v1/providers/:id/capacity?<pistas>` | si tomaría una corrida ahora (consultivo) |
| `POST /v1/providers/:id/runs` | abre una corrida → `202 { runId }`, o `503` si está al tope |
| `POST /v1/runs/:runId/sync` | el ida y vuelta (long-poll): resultados + inbox → eventos |
| `DELETE /v1/runs/:runId` | la corta, si sigue, y la olvida |

Los eventos (`tool_call`, `conversation`, `done`, `failed`) tienen un `seq`: el runner manda en
cada sync el último que procesó (`after`) y el host le devuelve los que siguen. Lo que el runner
manda (resultados, inbox) se reenvía hasta que un sync vuelve bien, y el host descarta lo
repetido: un sync cortado a mitad de camino no pierde ni duplica nada.

## Lo que se trajo de v1

- **La sonda de capacidad** con las pistas de la corrida (`agentId`, `eventType`, el `scope` del
  evento y las que agregue el runner, como `repo`), para que las reglas del host corten ANTES de
  abrir. Un "no" demora la corrida (`Admission` con `retryAfterMs`), no la hace fallar.
- **Un host que no contesta también demora** — el health monitor de v1, sin monitor: mandarle
  trabajo a un host caído haría fallar el run de verdad. Cualquier otra respuesta rara (un 404 de
  un host viejo) admite, y si algo está mal falla en `run` diciendo qué.
- **El 503 al abrir no es un error**: la sonda es consultiva y otro runner pudo tomar el último
  lugar en el medio. Se espera lo que pida el host y se reintenta.
- **Silencio medido en tiempo, no en sondas** (`maxSilenceSeconds`, default 120; `0` = sin
  límite): un blip de red o un reinicio corto no matan la corrida; un host que no vuelve, sí.
- **"No la conozco" es terminal**: un 404 en el sync (el host reinició, o ya la olvidó) tira en
  vez de sondear para siempre.
- **El cancel avisa del otro lado**: si el runner deja de esperar (tope, silencio), manda el
  `DELETE` para que el host no siga trabajando sobre una corrida que ya nadie lee.
- **Reglas de admisión** (`admissionRules`): `equals`/`notEquals`/`matches`/`notMatches`, `*`
  como comodín, AND. Una pista que no vino no rechaza; una que vino vacía, sí.

Lo que **no** se trajo, porque el contrato nuevo lo resuelve distinto:

- `SessionHandle` (liveness/close de la sesión de terminal): el engine nuevo no lo tiene; el
  provider del host maneja su sesión entera (su timeout, su cierre).
- `daemonUrl`/`daemonToken`: las tools vuelven por el sync.
- El registro dinámico de hosts (`/api/provider-registrations`) y la pantalla del agent-host: los
  hosts se declaran en la config del runner.

## Del lado del host

- **Huérfanas.** Si el runner no sincroniza en `orphanAfterMs` (default 120 s) —se reinició, se
  cortó la red— la corrida se corta: toda tool pendiente o futura falla con ese motivo, y el
  provider de allá termina en vez de esperar un resultado que nadie va a mandar.
- **Resultados sin buscar** se olvidan a los `retainMs` (default 10 min).
- **Sin token, todo 500**: nunca queda abierto por olvido.
- **El `ctx` que ve el provider de allá** es el evento real (de él sale el worktree, igual que en
  el runner) con un bus propio: lo que publique no vuelve.

## Límites conocidos

- **El inbox llega con hasta un long-poll de demora** (`longPollMs`, 15 s): el runner lo manda en
  cada sync. Un mensaje que llega después de que el provider de allá dejó de leer se pierde con la
  corrida — igual que con un provider local que termina.
- **Dos checkouts.** Con un provider de CLI en el host, sus tools nativas (Bash, Edit) trabajan
  en el worktree del HOST; las actions de disco del agente (`fs_*`, `bash_run`), en el del runner.
  Un agente remoto de CLI no debería declarar actions de disco.
- **La traza no cruza**: los spans de las tools quedan en el runner, colgados del agente; los del
  provider de allá, en el host, sin `traceparent` compartido.
- **El `providerConfig` no se valida en el runner**: viaja tal cual y lo valida el provider del
  host, que es el que sabe qué acepta. Un typo aparece en la primera corrida, no al montar.
- **`mcpServers` viaja con sus credenciales** (ej. el token de GitHub del MCP): usá HTTPS entre
  runner y host.
