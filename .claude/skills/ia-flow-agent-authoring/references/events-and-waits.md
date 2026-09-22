# Eventos, esperas y pausas — `on`/`when` contra el event-catalog

Dos tools de `packages/tools/src/wait/` dejan que un agente **sync** ceda el turno hasta que
pase algo afuera, en vez de sondear con `bash_run` en loop: `wait_for_event` (termina el run,
libera todo) y `pause_until` (retiene el worktree y checkpointea la conversación). Las dos son
`providerKinds: ['sync']` — no existen para terminal, donde el proceso sigue vivo por su cuenta.

| | `wait_for_event` | `pause_until` |
| --- | --- | --- |
| Cuándo usarla | el agente terminó lo que podía hacer, no hay posición que conservar | lo pararon a mitad del trabajo |
| Costo | libera slot, lock y worktree | retiene el worktree; el loop guarda checkpoint |
| Default de `on` | **obligatorio**, no tiene default | `['task.message']` — el próximo mensaje de la tarea |
| Requiere después | una regla sobre el evento que lo reanuda (ver más abajo) | ídem |

Las dos reciben **los mismos dos parámetros**, `on: string[]` y `when` (condiciones), y son lo
que un agente usa para decir *"no hagas nada más conmigo hasta que pase X"*. `pause_until` sin
`on` no tiene `when` tampoco: sin saber qué evento espera, no hay contra qué evaluar condiciones.

## El tipo de evento es EXACTAMENTE el nombre que manda la fuente

**No hay taxonomía curada.** Para un webhook de GitHub, `on` usa el nombre crudo del evento
(`X-GitHub-Event`: `pull_request`, `pull_request_review`, `check_suite`, `workflow_run`,
`issue_comment`, `issues`, `projects_v2_item`, `projects_v2`) — nunca `<evento>.<acción>`, y
nunca un nombre inventado (`ci.finished`, `pr.merged`). Distinguir por `action` (o por un campo
como `pr.merged`) es trabajo del `when`, no del tipo:

```yaml
# mal — taxonomía inventada, ya no existe
on: ['pr.merged']

# bien — el evento crudo, con la acción filtrada por when
on: ['pull_request']
when:
  - field: action
    op: '='
    value: closed
  - field: pr.merged
    op: '='
    value: 'true'
```

**Por qué se abandonó `<evento>.<acción>`** (si ves ese formato en un agente o regla viejos, es
deuda para migrar, no el patrón a copiar): la lista de acciones que un traductor publica se
desincroniza en silencio del set real de GitHub — `pull_request` con `action: 'edited'` no
producía nada porque nadie lo había agregado a la lista curada. Con el nombre crudo, CUALQUIER
`action` de un evento soportado llega, sin lista que mantener.

El catálogo (`packages/shared/src/event-catalog.ts`) es **descripción, no autoridad** — cualquier
tipo que la fuente mande es válido aunque no esté listado (el catálogo es sólo para
autocomplete), así que no inventes un tipo: usá el que el evento real trae, y filtrá por `action`
con `when`.

### Los tipos y campos reales de GitHub — verificados contra payloads reales

`fields` es lo que un `when` puede evaluar. **Sólo lo que GitHub manda de verdad** — no lo que
"tendría sentido" que mandara. Dos correcciones recientes por esto exactamente:

- `projects_v2_item` con `action: 'edited'` **nunca** trae el valor viejo/nuevo de un campo — ni
  para `single_select`, ni para texto, ni para nada. Sólo `fieldName`/`fieldType`. Para el valor
  ACTUAL hay que resolver `item` (el issue enlazado), no inventar un `fieldValue` que no existe.
- `issues` con `action: 'labeled'`/`'unlabeled'`/`'assigned'`/`'unassigned'` trae
  `label`/`assignee` a **nivel raíz** del payload, no anidados dentro de `issue` — por eso el
  catálogo expone `labelName`/`assignee` como campos propios del tipo `issues`, no como
  `issue.label.name`.

| Tipo | `action` que distingue | Campos disponibles en `when` | Notas |
| --- | --- | --- | --- |
| `issue_comment` | `created`, `edited`, `deleted` | `action`, `body`, `author`, `commentUrl`, `issueNumber`, `item` | `item` resuelto sólo si el issue pertenece a un proyecto conocido |
| `issues` | `opened`, `closed`, `labeled`, `unlabeled`, `assigned`, `unassigned`, `edited`, … | `action`, `issueNumber`, `title`, `state`, `labelName`, `assignee`, `item` | `labelName`/`assignee` sólo vienen poblados en labeled/unlabeled/assigned/unassigned — en el resto quedan vacíos |
| `projects_v2_item` | `edited`, `created`, `deleted`, `archived`, `restored`, `reordered`, `converted` | `action`, `itemId`, `fieldName`, `fieldType`, `item` | sin `fieldValue` — el valor actual se lee resolviendo `item` |
| `projects_v2` | `edited`, `created`, `deleted`, `closed`, `reopened` | `action` | sólo cambios en la config del proyecto, no en un item |
| `pull_request` | `opened`, `reopened`, `synchronize`, `ready_for_review`, `edited`, `closed`, … | `action`, `pr.number`, `pr.title`, `pr.state`, `pr.merged`, `pr.isDraft`, `pr.additions`, `pr.deletions`, `pr.changedFiles`, `pr.author`, `pr.head.ref`, `pr.base.ref`, `pr.url` | un `closed` mergeado vs sin mergear se distingue por `pr.merged`, no por otro tipo |
| `pull_request_review` | `submitted`, `edited`, `dismissed` | `action`, `state`, `reviewer`, `body`, `pr.number`, `pr.author` | `state`/`reviewer`/`body` sólo tienen sentido con `action=submitted` |
| `check_suite` | `requested`, `in_progress`, `completed` | `action`, `conclusion`, `status`, `name`, `branch`, `sha`, `url`, `prNumber` | `conclusion` sólo tiene valor con `action=completed` |
| `workflow_run` | `requested`, `in_progress`, `completed` | `action`, `conclusion`, `status`, `name`, `branch`, `sha`, `url`, `prNumber` | mismo hecho que `check_suite` para "terminó el CI" — una regla que no distingue el mecanismo escucha `on: [check_suite, workflow_run]` |
| `task.message` | — | `body`, `author`, `messageId` | default de `pause_until`: el próximo mensaje de la tarea |
| `wait.expired` | — | `waitId`, `agentId`, `taskId` | la espera venció sin que llegara el evento |
| `wait.resumed` | — | `waitId`, `agentId`, `taskId` | llegó el evento esperado y el run retoma |
| `run.finished` | — | `agentId`, `outcome`, `exit` | `outcome` es el resultado real del run (`success`/`error`/`cancelled`/`truncated`), no un estado del dispatcher — sirve para esperar a que OTRO agente termine y condicionar sobre cómo terminó, ej. `on: ['run.finished'], when: [{field:'agentId', op:'=', value:'implementer'}, {field:'outcome', op:'=', value:'error'}]` |

Cualquier otra `action` de un tipo ya listado se publica igual aunque no esté en la columna
"acciones" — esa columna trae las más comunes, no todas. Ante la duda, `describeEventType`/
`EVENT_CATALOG` (`packages/shared/src/event-catalog.ts`) es la fuente real.

### Ejemplo — esperar un PR concreto

```yaml
# la orden viene de afuera (un humano, otra regla) y sabe qué está esperando:
# pausar hasta que se mergee el PR 5
on: ['pull_request']
when:
  - field: action
    op: '='
    value: closed
  - field: 'pr.merged'
    op: '='
    value: 'true'
  - field: 'pr.number'
    op: '='
    value: '5'
```

```yaml
# esperar CI verde de la propia rama
on: ['check_suite', 'workflow_run']
when:
  - field: action
    op: '='
    value: completed
  - field: 'conclusion'
    op: '='
    value: 'success'
```

El `when` de estas tools es **el mismo evaluador** que el DSL de activación de agentes
(`references/activation-and-outcomes.md`): `packages/rules/src/when.ts`, con sus 10 operadores
en la forma estructurada `{field, op, value}` — `=`, `!=`, `>`, `>=`, `<`, `<=`, `$contains`,
`$matches`, `$null`, `$not_null`. (`$ne`/`$gt`/`$gte`/`$lt`/`$lte` son sólo la codificación
interna on-wire de la forma string legacy, `op: '$gt'` en el array NO es válido y falla en
silencio — matchea por igualdad de string y nunca dispara.)
`packages/issue-sources/src/dispatch/when.ts` sólo lo re-exporta para no romper imports viejos.
Lo único que cambia es el sujeto: un `Task` cuando lo usa la selección de agentes, el payload de
un `EngineEvent` cuando lo usa una espera o una regla — así que un operador que funciona en un
`when` de activación funciona igual acá.

## La trampa: un nombre de evento viejo no despierta nunca

Una espera con `on: ['ci.finished']`/`['pr.merged']`/`['issue_comment.created']` (la taxonomía
curada que ya no existe) se ARMA bien — la tool no valida el tipo contra nada — pero jamás va a
matchear ningún evento real, porque el traductor de GitHub ya no publica esos nombres. El
composition root traduce lo que puede EN MEMORIA al crear la espera (mismo algoritmo que migra
`rules`/`waits` en SQLite — `adapters/github/legacy-event-rename.ts`) y deja un `log.warn`, pero
eso es una red, no una licencia: si tu prompt sigue enseñando el nombre viejo, cada espera pasa
por esa traducción innecesariamente, y algunos casos (mezcla de tipos) NO son traducibles y
quedan muertos. Escribí el nombre crudo desde el prompt.

## La otra trampa: una espera sin regla que la reanude no despierta nunca

`wait_for_event`/`pause_until` sólo **arman la espera**. Que el agente vuelva a correr al llegar
el evento lo decide una **regla** aparte, sobre `wait.resumed` — el engine no cablea "despertar"
con "correr". Un agente con `on: ['pull_request']` (`when: action=closed, pr.merged=true`) y
ninguna regla sobre `wait.resumed` se despierta, consume la fila de espera, y **no vuelve a
correr nunca**: quedó una espera "resuelta" sin que nada haya pasado.

Conviene también una regla sobre `wait.expired` — si no, una espera que vence deja la task
muerta en silencio sin que nadie se entere.

## Checklist adicional para agentes con `wait_for_event`/`pause_until`

- [ ] `on` usa el nombre CRUDO del evento (verificado contra
      `packages/shared/src/event-catalog.ts` o el payload real de GitHub), nunca
      `<evento>.<acción>` ni un nombre inventado.
- [ ] Cada `field` del `when` está entre los `fields` reales de ESE tipo — no un campo que
      "tendría sentido" (como el extinto `fieldValue` de `projects_v2_item`).
- [ ] Si el tipo lo requiere (`pull_request`, `pull_request_review`, `check_suite`,
      `workflow_run`, `issue_comment`, `issues`, `projects_v2_item`, `projects_v2`), el `when`
      filtra por `action` — sin eso, la espera se despierta con CUALQUIER acción de ese evento.
- [ ] Existe una regla configurada sobre `wait.resumed` que decide qué agente vuelve a correr.
- [ ] Existe (recomendado) una regla sobre `wait.expired` para no dejar la task muerta en
      silencio si la espera vence.
