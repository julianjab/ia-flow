# @ia-flow/agent-engine

Harness domain-agnostic para componer agentes en pipelines que reaccionan a eventos.
No sabe nada de GitHub, Slack ni viajes — sólo conoce `DomainEvent`, `Runnable`, `Agent`,
`Pipeline` y `Engine`. Cada app que lo use trae su propio conector de entrada (webhook,
Socket Mode, un cron) que traduce su mundo a `DomainEvent`, y sus propios `Provider`s
(implementaciones concretas de LLM) para los agentes que declara.

Nace de auditar `ia-flow-worktrees/v2-platform/packages/engine-v2` (el motor de pipelines
de ia-flow): el patrón central — `EventBus` → `Pipeline` (matchea por `on`/`when`) → cadena
de `do[]` donde cada paso ve `ctx.steps` de TODOS los pasos anteriores, no sólo el
inmediato — es exactamente lo que hace falta acá. `AgentDefinitionProps`/`Agent` también
espejan la forma real de `engine-v2/src/engine/Agent.ts` a propósito. Lo que se dejó afuera:

- **`Task`/`Project`/`Repo`** — modelan un issue de GitHub con status/PRD/comments/PRs.
  Acá `event.scope` es `Record<string, unknown>` libre: cada dominio pone las claves que
  necesita (`{ owner, repo, issueNumber }`, `{ workspace, channel }`, `{ tripId }`).
- **`Execution`/pausa-y-reanudación de un run largo, capacidad/slots** — complejidad real
  (`run_checkpoints`, reanudar la conversación exacta de un provider, límites de concurrencia)
  que no vale la pena portar hasta que un caso de uso concreto la necesite. Un `Provider.run`
  acá es sólo una `Promise` — un provider asíncrono (lanza un trabajo y se entera de que
  terminó por un canal aparte, como el `TmuxClaudeProvider` de ia-flow) la mantiene pendiente
  el tiempo que haga falta, sin que el harness tenga que saber la diferencia.
- **`ScriptAction`** (correr un script de shell) — reemplazado por `FunctionAction`, que
  corre una función TS del proceso. Sin shell de por medio no hay comandos arbitrarios que
  allow-listear.
- **`HttpAction.url` con interpolación de secretos** — el README de engine-v2 documenta ese
  riesgo (`${SECRETO}` sin allow-list de host) como conocido y no resuelto. Acá `HttpAction`
  no interpola nada: los secretos van en `headers`/`body` ya resueltos por código, nunca
  parseados desde un string de config.

## Instalar (dentro del monorepo)

```bash
bun run --filter @ia-flow/agent-engine test
```

Para usarlo desde otra app del monorepo: `"@ia-flow/agent-engine": "workspace:*"` en su
`package.json`. Es source-only (los `exports` apuntan a `src/*.ts`, sin build ni `dist/`):
`bun run --filter @ia-flow/agent-engine typecheck` corre `tsc --noEmit`. Para usarlo desde un
repo por fuera de ia-flow habría que publicarlo compilado — su única dependencia runtime es
`zod` (para `SchemaTool`).

## Las piezas

```
DomainEvent   { type, payload, scope?, occurredAt, depth }   — un evento crudo, sin negocio
Runnable      { id?, when?, continueOnError?, run(ctx, input?) } — lo que vive en Pipeline.do[]
Action        Runnable con input tipado (zod) — paso de pipeline Y tool de un agente
Agent         Runnable respaldado por un LLM, que termina eligiendo una salida
Condition     { field, op, value, logic }                    — un `when` puro sobre un payload
Pipeline      { on, when?, scope?, exclusive?, do, routes? } — matchea eventos, recorre su grafo
Project       { when?, pipelines, onError?, report? }         — primer filtro + defaults del proyecto
Engine        dispatch(event) / select(event) contra 1..N fuentes — el orquestador
EventBus      publish/subscribe in-process                    — pega todo
```

Un evento pasa por tres `when`, de lo general a lo particular: el del **proyecto** (si no lo
cumple, ninguna de sus pipelines se evalúa), el de cada **pipeline** (junto con `on` y `scope`) y
el de cada **paso** (al correr). Así una regla transversal — "nada sobre cards con `blocked`" — se
declara una vez en el `Project`. El `Engine` acepta varias fuentes (un `Project` por proyecto, más
las pipelines sin proyecto): cada una aplica su `when` y sus defaults, y la prioridad
`exclusive`/`position` se decide entre todas. `engine.select(event)` devuelve lo que correría, con
el mismo criterio, sin correrlo.

`Pipeline.do[]` es homogéneo: `EmitAction` (publica un evento derivado), `HttpAction` (llama
una API), `FunctionAction` (corre código TS con el contexto completo), cualquier `Action` y
`Agent` son todos `Runnable`. Un `Agent` se pone directo en `do[]`, con su propio `id` como
key de `ctx.steps`.

## Cómo se ejecuta un Pipeline

```ts
interface PipelineExecutionContext {
  event: DomainEvent;
  steps: Record<string, unknown>;   // outputs de pasos anteriores, por su `id`
  bus: EventBus;
  pipelineId: string;
  defaults?: ExitDefaults;           // onError/report del Project
}
```

Los pasos de `do[]` corren en orden, salvo los que son destino de una ruta: esos corren sólo
cuando un agente elige la salida que lleva a ellos, con el input que el agente entregó. Al
elegir una salida corre primero su `report` (el cierre del turno) y después sus destinos, en
orden — el siguiente agente tiene que ver ese comentario.

## `Action` — input tipado, paso o tool

Una `Action` declara su input como `z.strictObject` y lo que hace con él. Sirve como paso de
pipeline (su input se valida al correr) y como tool de un agente (`asTool`), sin duplicar nada.
`bind` fija campos desde la configuración y los saca del schema que ve el modelo:
`updateIssue.bind({ status: 'Build' })` deja al modelo completar el resto, nunca elegir el status.
`sideEffects` es `'write'` por defecto; un agente sólo recibe una acción que escribe si se la
pasás como `action.allowWrite()`.

## `Agent` — un `Runnable` respaldado por un LLM

`Agent` es la única pieza de este paquete que asume "hay un modelo de por medio". Se construye
a partir de una `AgentDefinitionProps` (id, `provider`, `prompt`, `input`, `tools`, `actions`,
`routes`, `report`, `onError`, ...) más un `Provider` — resuelto por id contra un
`ProviderRegistry`. El `Provider` es el ÚNICO punto que sabe hablar con un backend real; ese
código vive fuera del paquete (ver `@ia-flow/provider-anthropic`).

Un agente termina eligiendo una **salida**. Por cada una, el modelo recibe una tool
`submit_<salida>` cuyo schema es el input de los pasos a los que lleva (menos lo fijado con
`bind`): elegir la salida y producir el input del siguiente paso son una sola llamada validada.
Un agente sin salidas declaradas tiene una implícita, `done`.

Las salidas son una cascada de cuatro niveles — **paso > pipeline > agente > proyecto** —
resuelta por `resolveRoutes`:

- **Agente:** declara el vocabulario (qué salidas existen y su `when`) y destinos base, que
  sólo pueden ser acciones. Una salida sin `to` es sólo vocabulario: la pipeline le pone destino.
- **Pipeline (`routes.<agentId>`):** cambia el `to` de una salida (hereda el `when`), la elimina
  con `null`, o cambia su `onError`/`onInterrupt`/`report`. Nunca crea salidas. Encadenar agentes va acá.
- **Pipeline y proyecto:** sólo `onError`, `onInterrupt` y `report` por defecto.

`onInterrupt` es lo que corre en vez de las salidas cuando interrumpen al agente (una regla con
`ifRunning: 'interrupt'` llegó mientras trabajaba): sus pasos leen `steps.interruption` (por qué
y en qué quedó), típicamente para dejar un comentario.

Todo el cableado se valida al construir la `Pipeline`: salidas sin destino, overrides de
salidas o agentes que no existen, ciclos entre agentes. `pipeline.routesOf(agentId)` muestra
las rutas efectivas con el origen de cada una.

## Ejemplo mínimo

```ts
import { Agent, END, Engine, EventBus, Pipeline, Project, createEvent,
         providerRegistry } from '@ia-flow/agent-engine';
import { z } from 'zod';

providerRegistry.register(/* tu Provider */);

// updateIssue / postComment: Actions de tu dominio (ej. GitHub).
const triage = new Agent({
  id: 'triage',
  provider: 'anthropic-api',
  prompt: 'Comentario: {{body}}',
  report: null,
  routes: {
    actionable: { when: 'Pide un cambio de código o de PRD' },   // destino: lo pone la pipeline
    not_actionable: { when: 'Pregunta, agradecimiento o ruido', to: END },
  },
});

const refiner = new Agent({
  id: 'refiner',
  provider: 'anthropic-api',
  prompt: 'Ajustá el PRD: {{input.summary}}',
  input: z.strictObject({ summary: z.string().optional() }),
  routes: {
    done: { when: 'El PRD quedó listo', to: updateIssue.bind({ status: 'Refined' }) },
    back_to_build: { when: 'Lo que falla es la implementación', to: updateIssue.bind({ status: 'Build' }) },
  },
});

const pipeline = new Pipeline({
  id: 'comment-refine',
  on: ['github.issue_comment'],
  do: [triage, refiner],
  routes: { triage: { routes: { actionable: { to: refiner } } } },
});

const bus = new EventBus();
const engine = new Engine({
  bus,
  pipelines: new Project({
    id: 'lahaus',
    pipelines: [pipeline],
    report: postComment.bind({ target: 'pr-else-issue' }),
    onError: { to: updateIssue.bind({ labels: ['blocked'] }) },
  }),
});
engine.start();

await bus.publish(createEvent('github.issue_comment', { body: 'falta paginar la tabla' }));
```

El modelo de `triage` ve `submit_actionable({ refiner: { summary } })` y
`submit_not_actionable({})`; el de `refiner` ve `submit_done({ report })` y
`submit_back_to_build({ report })`.

## Los tres casos que motivaron esto

Quedaron en el repo **ia-tools**, en `examples/` (gitignoreado, no se migraron a ia-flow):

- `apps/github-issue-triage.ts` — un webhook de GitHub se traduce a `github.issue.opened`;
  un pipeline hace triage con un `Agent` real (Anthropic) y despacha un fix determinístico.
- `apps/slack-support-reply.ts` — un evento de Slack (`slack.message`) dispara un pipeline
  que responde sólo si el mensaje matchea un `when` de texto.
- `apps/travel-planner.ts` — un pedido de viaje (`travel.trip.requested`) corre un `Agent`
  con dos tools reales (vuelos, hoteles) y arma una recomendación — el mismo `Engine`, cero
  código nuevo, sólo otro `Pipeline`.
- `tools/` — lógica de negocio mock de las tools del travel-planner.

El `Provider` real de Anthropic es `@ia-flow/provider-anthropic` (paquete propio, no vive acá —
ver su README). `AgentDefinitionProps`/`Agent`/`Provider`/`ProviderRegistry` SÍ están en `src/`
de ESTE paquete — son contrato puro, sin I/O (ver la sección de `Agent` más arriba).

### Por qué los examples no viven adentro de este paquete

`@ia-flow/provider-anthropic` depende de `agent-engine` (implementa su `Provider`). Si un
example que usa AMBOS paquetes viviera dentro de `agent-engine/examples/`, este paquete
necesitaría a su vez depender de `provider-anthropic` (aunque sea sólo en `devDependencies`) —
una dependencia cíclica entre workspaces. En ia-flow el ejemplo vivo de los dos juntos es
`apps/runner-v2`, que depende de ambos sin que ninguno dependa del otro.
