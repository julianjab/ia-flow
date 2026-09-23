# ia-flow v2 — esqueleto del engine en clases

Sólo clases: propiedades tipadas + firmas de métodos. Los cuerpos de lógica real
tiran `throw new Error('not implemented — ...')` con una nota de qué pieza de v1
cubre ese hueco. Nada de esto se ejecuta — es la base para discutir la forma antes
de portar lógica.

No está en el `workspaces` del `package.json` raíz (a propósito, todavía). Es un
paquete standalone: `cd v2 && bun install && bun run typecheck`.

## La idea central

En v1 el comportamiento estaba repartido en funciones puras sueltas
(`match.ts`, `TaskDispatcher.ts`, `Agent.ts`, `execution-log.ts`…) que un
`AgentOrchestrator` externo iba llamando en orden. Acá cada responsabilidad es
un método de la clase dueña de ese estado — `Agent` y `Rule` dejan de ser un
puñado de funciones al lado de un objeto de config.

**Decisión clave (confirmada): `Agent` vive en un `AgentRegistry` y las `Rule`
lo referencian por id — nunca se embebe en la cadena de una regla.** Es fiel a
cómo funciona v1: `AgentActionSchema.agentId` es un string, no el agente
mismo, porque un mismo `Agent` se reusa desde N reglas distintas sin
duplicarse. La alternativa (instancias embebidas directo en `Rule.do`) era más
simple de leer pero perdía ese reuso — se descartó.

## Mapa de archivos

```
src/
├── domain/
│   ├── Task.ts        — el issue normalizado (status, repos, PRD, comments, PRs…)
│   ├── Project.ts      — source + settings (caps, Slack review, baseWhen, disabledRuleIds)
│   └── Repo.ts         — coordenadas de un repo (no un path de disco fijo)
├── events/
│   ├── DomainEvent.ts  — { type, payload, occurredAt }
│   └── EventBus.ts     — pub/sub in-process
├── rules/
│   ├── Condition.ts    — un `when` (field/op/value/logic) + evaluate()
│   ├── ActionRegistry.ts — acciones nombradas, reusables vía RefAction
│   ├── Rule.ts          — on + when + whenText + schedule + do[] + exclusive/position
│   └── actions/
│       ├── RuleActionEntry.ts — base abstracta: id/when/continueOnError + RuleExecutionContext
│       ├── AgentAction.ts      — { agentId, brief, emitOn, exitsOverride, allowAgents, liveInject }
│       ├── HttpAction.ts       — llamar una API
│       ├── EmitAction.ts       — publicar un DomainEvent derivado
│       ├── ScriptAction.ts     — correr un script del repo (feature flag en v1)
│       └── RefAction.ts        — correr una acción nombrada aparte
└── engine/
    ├── Agent.ts          — identidad + capacidad de un agente (tools, provider, exits, output…)
    ├── AgentRegistry.ts  — resuelve agentId → Agent
    └── Engine.ts          — dueño del roster de Rule[], dispatch(event)
```

## Cómo se ejecuta una regla (`Rule.execute`)

`Rule.do` es un `RuleActionEntry[]` heterogéneo (`AgentAction | HttpAction |
EmitAction | ScriptAction | RefAction`). A diferencia de un pipe estricto
(output de uno = input del siguiente), cada paso recibe el `RuleExecutionContext`
completo:

```ts
interface RuleExecutionContext {
  event: DomainEvent
  task?: Task
  steps: Record<string, unknown>   // outputs de pasos anteriores, por su `id`
  agents: AgentRegistry
  actions: ActionRegistry
  bus: EventBus
}
```

Esto es fiel a v1: un paso lee `{{steps.<id>.output}}` de CUALQUIER paso
anterior con nombre, no sólo del inmediato anterior — y su propio `when`
también puede leer `steps.*` (el patrón "triage nombrado → despacho
condicionado a `steps.triage.output.actionable`" de un solo `do[]`, sin
evento intermedio).

## Qué se completó en esta pasada (auditoría contra los schemas reales de v1)

La primera versión del esqueleto dejó afuera bastante. Se corrigió contra
`AgentDefinitionSchema`, `AgentActivationSchema`, `TaskSchema`, `ProjectSchema`,
`RepoDefSchema` y `RuleSchema` (`packages/shared/src/schemas.ts` y `rules.ts`):

- **`Agent`** ahora incluye `variables`, `providerConfig`, `mcpCatalogIds`,
  `requiresBranch`, `allowBlocked` (sobrevive a la migración 059 — es
  tolerancia de trabajo, no criterio de activación), `projectId`/`position`
  (ownership y orden del editor, no activación), `output` (contrato
  `submit_output`), `verify` (comandos post-run del engine), `save_output`,
  `onProcess`, `comment`. `exits` pasó de array a `Record<string, AgentExit>`
  con las claves reservadas `success`/`error`. `provider` pasó a
  `string | AgentProviderChoice[]`.
- **`Task`** suma `prd`, `sections`, `createdAt`/`approvedAt`, `error`,
  `issueNumber`/`issueUrl`, `assignees`, `comments[]`, `pullRequests[]`.
- **`Project`** suma `settings` completo (`maxConcurrentDispatches`,
  `systemPrompts`, Slack review, `disabledRuleIds`, `baseWhen`), `source`,
  timestamps y `archivedAt`.
- **`Rule.do`** dejó de ser `Step[]` con `Agent` embebido — ver la decisión
  clave arriba. Cada entrada del `do` ahora modela lo que v1 realmente
  permite: 5 tipos de acción (no sólo agente), y cada una con su propia
  metadata de paso (`id`, `when` por-paso, `continueOnError`) que la versión
  anterior no tenía en absoluto.

## Lo que sigue sin decidir

- ¿Dónde entran los **ports** reales (persistencia, provider de IA, fuente de
  issues)? Hoy `Agent.execute`/`onStart`/`finalize` y las `RuleActionEntry.run`
  tiran `not implemented` sin ningún colaborador inyectado — falta decidir si
  entran por constructor (como en v1) o viajan dentro de `RuleExecutionContext`.
- ¿Cómo se **hidratan** `Rule`/`Agent` desde config (DB/YAML) a instancias de
  estas clases? Hoy sólo hay constructores que reciben props ya tipadas.
- `Condition.evaluate`/`evaluateAll` y `Rule.matchesText` siguen sin
  implementación — son el puente directo a `evalCondition`/`evalWhen` y al
  clasificador Haiku de v1.
- **`HttpAction.url` resuelve `${SECRETO}` sin allow-list de hosts destino** —
  fiel a `apps/server/src/adapters/actions/http-action.ts` de v1 (mismo
  riesgo, ya presente hoy, no introducido acá). Quien edita una Rule con
  acceso a un secreto puede mandarlo a cualquier URL. `ScriptAction.env` tiene
  la misma forma (allow-list de NOMBRES, no de valores). Si se decide acotar
  esto, el cambio tiene que aplicar a los dos lados (v1 y v2), no sólo acá.
- Caps, locks y `run_checkpoints` (estado transversal a la ejecución) todavía
  no tienen dueño claro en este esqueleto.
