<!-- GENERADO por scripts/sync-plugin-docs.ts desde .claude/skills/ia-flow-agent-authoring/references/pipelines.md. No editar: cambiá la fuente y corré `bun run plugin:sync`. -->

# Pipelines — el disparo

Schema: `PipelineDoc` en `packages/agent-engine/definitions/src/schema.ts`. Semántica:
`packages/agent-engine/core/CLAUDE.md` § "Salidas de un agente" y § "Ejecuciones". Ejemplos
reales: la config de La Haus (`la-haus/claw-agents` → `agents/ai-development-flow/config/`, `projects/lahaus-ai-flow/pipelines/`).

## Qué eventos hay (`on`)

El intake (`resolve_task`, en `runner.yaml`) convierte cada webhook crudo (`github.<evento>`) en
un evento de task. El mapeo está en `packages/github/webhook/src/locate.ts`:

| `on` | Cuándo | Campos propios en la raíz del payload |
| --- | --- | --- |
| `issue.created` | un item nuevo en el board | — |
| `issue.status_changed` | cambió el Status de la card. Con un board de Project v2 de una **org**, por el webhook `projects_v2_item`; con `board: { kind: issues }`, por un label `status:*` puesto (`to` es la columna) | `from`, `to`, `sender` |
| `issue.opened`, `issue.labeled`, `issue.unlabeled` | webhook `issues` del repo (no depende del board: es la señal de un Project v2 de cuenta personal, que no emite `projects_v2_item`) | `action`, `label` (el que se puso o sacó), `sender` |
| `projects_v2_item.edited` | cambió otro campo de la card | `action`, `fieldName` |
| `issue_comment` | comentario creado en el issue o en su PR (o respuesta en el hilo de Slack del pedido de review, `intake/slack.ts`) | `body`, `author`, `commentId`, `action` |
| `pull_request`, `pull_request_review` | un PR que cierra un issue de la task | `action`, `pr.*`; en review: `state`, `reviewer`, `body` |
| `check_suite`, `workflow_run` | CI `completed` de un PR de la task | `conclusion`, `status`, `name`, `branch`, `sha`, `url`, `prNumber` |
| `issue.unblocked` | se mergeó el PR del último bloqueador (`intake-unblock`) | — |

Todos llevan además `item.*` y `task.*` (ver `variables.md`). El intake no publica nada para un
repo fuera del catálogo (`repos/`), una card de otro board, ni una task que no cumple el `when`
del intake (`with.when` de `resolve_task` en runner.yaml: qué tasks toma este runner).

## Filtros, de lo general a lo particular

1. `scope` — el runner le pone `projectId: <id>` (la clave en `sources.projects` de
   `runner.yaml`) a cada pipeline del proyecto (`src/engine/withScope.ts`); los YAML de ejemplo lo
   escriben igual, para que se lea.
2. `on` + `when` de la pipeline (`ConditionRows`: `{ field, op, value | valueFrom, logic }`; ops
   en el schema). Barato y determinístico: filtrá acá todo lo que se pueda.
3. `whenText` de la pipeline — un modelo decide (capacidad `whenText` → agente
   `text-classifier`). Sólo después del `when`. Sin veredicto, no corre.
4. `when` / `whenText` de cada paso del `do`.

`when` de varias filas se pliega de izquierda a derecha, **sin precedencia**: cada fila hace AND
(o OR con `logic: or`) con el resultado acumulado hasta ahí — `[A, B, C(or), D]` es
`((A∧B)∨C)∧D` (ver el paso `frontend-implementer` de `50-comment.yaml`; `Condition.ts`). Un campo
ausente vale `undefined`: `eq` falla, pero `neq`/`notIn`/`notContains` pasan.

## Quién gana

- `exclusive: true` + `position`: si alguna de las que matchean es exclusiva, corre la exclusiva
  de menor `position` más cualquier otra con `position` todavía menor; si ninguna lo es, corren
  todas (`engine/DispatchPlanner.ts`).
- `firstMatch: true`: `do` es una lista de alternativas, corre el primer paso cuyo `when` pasa.
  El orden es la prioridad (el caso específico antes que el genérico).
- `enabled: false` apaga una pipeline sin borrarla.

## La task ocupada

| Clave | Default | Úsala |
| --- | --- | --- |
| `ifRunning` | `wait` | `interrupt` cuando el evento invalida lo que hace el agente (la card cambió de columna); `skip` para lo que no vale la pena encolar. `interruptOn` (`[{ on, when }]`) limita qué eventos interrumpen |
| `ifQueued` | `replace` | `keep` donde cada evento cuenta (comentarios): con `replace`, el segundo borra al primero |
| `ifPaused` | `supersede` | `wait` para reglas que pueden no hacer nada (un triage): no se lleva puesta la espera del CI |

Los `injects` del agente que corre se evalúan ANTES: un evento que acepta se le inyecta y ninguna
pipeline con agentes arranca por él.

## Pasos del `do`

| Paso | Forma |
| --- | --- |
| agente | `{ agent: <id>, brief?, when?, whenText? }` — `brief` se antepone al prompt: por qué corre en ESTE momento |
| acción | `{ action: <id>, with?, options?, when? }` — `with` con `{{...}}` se resuelve al correr |
| pausa | `{ pause: <id>, branches: { <nombre>: { on, when?, to? } }, timeout: { after: 30m, to? } }` |
| otros | `emit`, `http`, `function` — ver `packages/agent-engine/definitions/src/factories/` |
| reuso | `{ ref: <id> }` — un paso declarado antes en el mismo `do` |
| grupo | `{ parallel: [<pasos>], id, until: { all\|any: <salida(s)> }, advisory?: [<ids>], routes: { passed?: { to }, failed?: { to } } }` — ver abajo |

### Grupo `parallel` — varios agentes a la vez

```yaml
- parallel:
    - { agent: reviewer, brief: … }
    - { agent: e2e-visual-qa, when: [ { field: item.repos, op: contains, value: lh-seller-v2-frontend } ] }
  id: gate
  until: { all: [ approved, passed ] }   # todos los que corrieron eligieron una de ésas
  routes:
    passed: { to: [ … ] }
    failed: { to: { action: update_issue, with: { status: Build } } }
```

- Los miembros corren a la vez en la misma ejecución; cada uno con su `when` y su reporte.
- **Las salidas de un miembro no tienen destino**: son veredicto y reporte. Sus `to` (los del
  agente) no corren dentro del grupo, y `routes.<miembro>` con `to` no carga. La transición es del
  grupo (`passed` / `failed`).
- Un miembro saltado por su `when` no cuenta. Uno que falla, o termina sin salida, hace fallar al
  grupo: corre el `onError` de la pipeline/proyecto UNA vez.
- `advisory: [<ids>]` marca miembros **consultivos**: corren y publican su reporte, pero no votan
  ni hacen fallar al grupo (un e2e contra un entorno compartido, que todavía no es gate
  confiable). `until` nombra salidas de los que votan, y al menos uno tiene que votar.
- Un miembro no puede pausar (ni `waits`). Cada miembro lee sólo lo que SUS `injects` aceptan.

## Rutas por pipeline

`routes.<agentId>.routes.<salida>: { to }` cambia el destino de una salida que el agente declaró
(hereda su `when`); `null` la elimina; nunca crea salidas. También `onError`, `onInterrupt` y
`report` por agente o para toda la pipeline. Encadenar agentes va acá; los ciclos entre agentes
se rechazan al cargar: un "vuelve a build" es un cambio de status que dispara otra pipeline.

## Loops — la trampa de siempre

Un loop entre agentes (review → build → review) pasa por eventos: nada en el grafo lo corta, y el
tope de profundidad tampoco (el eco del webhook vuelve con `depth` 0). Ponele `maxRuns` a la
pipeline que lo cierra:

```yaml
maxRuns:
  max: 3
  counter: review-loop                 # opcional; lo comparten las pipelines que lo nombran
  counts:                              # sólo lo que hace el bot cuenta
    - { on: [ issue.status_changed ], when: [ { field: sender, op: matches, value: '\[bot\]$' } ] }
  resetOn:                             # una persona interviene → ronda nueva
    - { on: [ issue_comment ] }
  onExhausted:                         # acciones; corren EN VEZ de la pipeline
    - { action: post_notice, with: { summary: … } }
    - { action: update_issue, with: { addLabels: [ blocked, runs-cap ] } }
```

Para destrabar a mano, la acción `reset_runs` (en una `taskActions`) pone la cuenta en cero.

Una pipeline sobre `issue.status_changed` con `to: Build` cuyo agente termina moviendo la card
a `Build` se re-dispara con su propio eco. Revisá, para cada salida: ¿el estado en que deja la
task todavía pasa el `when`? `engine.interrupt.ownSenders` (runner.yaml) evita que el eco
interrumpa, pero no que re-dispare.
