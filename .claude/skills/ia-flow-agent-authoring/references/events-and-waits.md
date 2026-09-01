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

## El tipo de evento es `<evento>.<acción>`, tal cual lo manda GitHub

**No es una taxonomía curada aparte.** Antes el tipo era el nombre del webhook
(`issue_comment`, `issues`, `projects_v2_item`) y la acción vivía sólo en el payload; hoy el
tipo YA incluye la acción, con el mismo criterio que ya usaban `pr.opened`/`pr.merged`:

```yaml
# mal — así funcionaba antes de este cambio, ya no
on: ['issue_comment']
when: [{ field: 'action', op: '=', value: 'created' }]

# bien — la acción está en el tipo
on: ['issue_comment.created']
```

Una regla ya no necesita filtrar `created` de `edited`/`deleted` con un `when`: los descarta el
propio `on`. El catálogo (`packages/shared/src/event-catalog.ts`) es **descripción, no
autoridad** — cualquier `<evento>.<acción>` que GitHub mande es válido aunque no esté listado
(el catálogo es sólo para autocomplete), así que no inventes un tipo: usá el que el evento real
trae.

### Los tipos y campos reales de GitHub — verificados contra payloads reales

`fields` es lo que un `when` puede evaluar. **Sólo lo que GitHub manda de verdad** — no lo que
"tendría sentido" que mandara. Dos correcciones recientes por esto exactamente:

- `projects_v2_item.edited` **nunca** trae el valor viejo/nuevo de un campo — ni para
  `single_select`, ni para texto, ni para nada. Sólo `fieldName`/`fieldType`. Para el valor
  ACTUAL hay que resolver `item` (el issue enlazado), no inventar un `fieldValue` que no existe.
- `issues.labeled` / `issues.unlabeled` / `issues.assigned` / `issues.unassigned` traen
  `label`/`assignee` a **nivel raíz** del payload, no anidados dentro de `issue` — por eso el
  catálogo expone `labelName`/`assignee` como campos propios del tipo `issues.*`, no como
  `issue.label.name`.

| Tipo | Campos disponibles en `when` | Notas |
| --- | --- | --- |
| `issue_comment.created` | `action`, `body`, `author`, `commentUrl`, `issueNumber`, `item` | `item` resuelto sólo si el issue pertenece a un proyecto conocido |
| `issues.opened` (y cualquier `issues.<acción>`: `closed`, `labeled`, `unlabeled`, `assigned`, `unassigned`, …) | `action`, `issueNumber`, `title`, `state`, `labelName`, `assignee`, `item` | `labelName`/`assignee` sólo vienen poblados en labeled/unlabeled/assigned/unassigned — en el resto quedan vacíos |
| `projects_v2_item.edited` | `action`, `itemId`, `fieldName`, `fieldType`, `item` | sin `fieldValue` — el valor actual se lee resolviendo `item` |
| `projects_v2.edited` | `action` | sólo cambios en la config del proyecto, no en un item |
| `pr.opened` | `action`, `pr.number`, `pr.title`, `pr.state`, `pr.isDraft`, `pr.additions`, `pr.deletions`, `pr.changedFiles`, `pr.author`, `pr.head.ref`, `pr.base.ref`, `pr.url` | |
| `pr.synchronize` | `action`, `pr.number`, `pr.head.ref`, `pr.head.sha`, `pr.author` | commits nuevos en un PR abierto |
| `pr.ready_for_review` | `action`, `pr.number`, `pr.title`, `pr.author` | salió de draft |
| `pr.merged` | `action`, `pr.number`, `pr.title`, `pr.base.ref`, `pr.author` | |
| `pr.closed` | `action`, `pr.number`, `pr.title`, `pr.author` | cerrado SIN mergear — `pr.merged` es el evento aparte para eso |
| `pr.review_submitted` | `state`, `reviewer`, `body`, `pr.number`, `pr.author` | |
| `ci.finished` | `conclusion`, `status`, `name`, `branch`, `sha`, `url`, `kind`, `prNumber` | unifica `check_suite` y `workflow_run` |
| `task.message` | `body`, `author`, `messageId` | default de `pause_until`: el próximo mensaje de la tarea |
| `wait.expired` | `waitId`, `agentId`, `taskId` | la espera venció sin que llegara el evento |
| `wait.resumed` | `waitId`, `agentId`, `taskId` | llegó el evento esperado y el run retoma |

Cualquier otra acción de un evento ya listado (`issue_comment.deleted`, `issues.reopened`, …) se
publica con el mismo prefijo aunque no aparezca en la tabla — la tabla trae las más comunes, no
todas. Ante la duda, `describeEventType`/`EVENT_CATALOG`
(`packages/shared/src/event-catalog.ts`) es la fuente real.

### Ejemplo — esperar un PR concreto

```yaml
# la orden viene de afuera (un humano, otra regla) y sabe qué está esperando:
# pausar hasta que se mergee el PR 5
on: ['pr.merged']
when:
  - field: 'pr.number'
    op: '='
    value: '5'
```

```yaml
# esperar CI verde de la propia rama
on: ['ci.finished']
when:
  - field: 'conclusion'
    op: '='
    value: 'success'
```

El `when` de estas tools es **el mismo evaluador** que el DSL de activación de agentes
(`references/activation-and-outcomes.md`): `packages/rules/src/when.ts`, con sus 10 operadores
(`=`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$contains`, `$matches`, `$null`, `$not_null`).
`packages/issue-sources/src/dispatch/when.ts` sólo lo re-exporta para no romper imports viejos.
Lo único que cambia es el sujeto: un `Task` cuando lo usa la selección de agentes, el payload de
un `EngineEvent` cuando lo usa una espera o una regla — así que un operador que funciona en un
`when` de activación funciona igual acá.

## La trampa: una espera sin regla que la reanude no despierta nunca

`wait_for_event`/`pause_until` sólo **arman la espera**. Que el agente vuelva a correr al llegar
el evento lo decide una **regla** aparte, sobre `wait.resumed` — el engine no cablea "despertar"
con "correr". Un agente con `on: ['pr.merged']` y ninguna regla sobre `wait.resumed` se despierta,
consume la fila de espera, y **no vuelve a correr nunca**: quedó una espera "resuelta" sin que
nada haya pasado.

Conviene también una regla sobre `wait.expired` — si no, una espera que vence deja la task
muerta en silencio sin que nadie se entere.

## Checklist adicional para agentes con `wait_for_event`/`pause_until`

- [ ] `on` usa el formato `<evento>.<acción>` real (verificado contra
      `packages/shared/src/event-catalog.ts` o el payload de GitHub), nunca el nombre del
      webhook pelado.
- [ ] Cada `field` del `when` está entre los `fields` reales de ESE tipo — no un campo que
      "tendría sentido" (como el extinto `fieldValue` de `projects_v2_item`).
- [ ] Existe una regla configurada sobre `wait.resumed` que decide qué agente vuelve a correr.
- [ ] Existe (recomendado) una regla sobre `wait.expired` para no dejar la task muerta en
      silencio si la espera vence.
