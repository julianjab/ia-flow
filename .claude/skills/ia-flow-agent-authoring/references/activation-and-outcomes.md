# Activación y outcomes

## Los 5 filtros de selección

`packages/agent-engine/src/agent-selection.ts` → `selectAgent`. Se evalúan en orden;
gana el **primer** agente que sobrevive a todos.

| # | Filtro | Rechaza cuando |
| --- | --- | --- |
| — | `enabled` | `enabled === false` |
| 0 | **Scope** | El agente NO tiene `statusName` ni `when` no vacío |
| 1 | Project | `agent.projectId` está seteado y != `task.projectId` |
| 2 | Repo | `agent.repoName` está seteado y no está en `task.repos[]` |
| 3 | Status | `agent.statusName` está seteado y != `task.status` (case-insensitive) |
| 4 | When | `evalWhen(task, agent.when)` da `false` |

**Orden de evaluación de candidatos:** especificidad primero (agentes con `projectId`
antes que globales), luego `position` ascendente, luego `id` alfabético. Comparar
`position` entre scopes no significa nada — cada scope numera desde 0.

### Por qué existe el filtro 0

Sin `statusName` ni `when`, ningún criterio deja de cumplirse cuando el agente termina:
`statusName: null` matchea cualquier status, así que el `onFinish` que mueve el issue no
lo saca de la selección. El próximo scan lo vuelve a elegir para el MISMO issue → loop.
El diagnóstico aparece en los logs como `rejected: unscoped: <id>`.

## DSL `when`

Formato recomendado (array, con lógica por condición):

```yaml
when:
  - field: labels
    op: '='
    value: 'agent:build'
  - field: labels          # AND implícito con la anterior
    op: '!='
    value: 'ci-checked'
  - field: type            # OR: abre un grupo nuevo
    op: '='
    value: 'technical'
    logic: or
```

Los grupos se separan por cada condición con `logic: or`; dentro de un grupo todo es AND;
el resultado es `OR` entre grupos. El formato legacy (`Record<string,string>`) es todo-AND.

### Operadores

| `op` | Semántica |
| --- | --- |
| `=` | Igualdad exacta (o pertenencia si el campo es array) |
| `!=` | Distinto (o "no pertenece" si es array) |
| `$null` | Campo ausente, string vacío, o array vacío |
| `$not_null` | Campo con valor / array no vacío |

### Resolución de `field`

Se busca en este orden: `task[field]` → `task[lowercase]` → `task[snake_case]` →
alias → `task.fields[...]` (campos custom del source, ej. columnas del GitHub Project).

Aliases: `task type` / `task_type` → `type`, `repository` → `repos`, `labels`, `assignees`.

Si el valor resuelto es un array (`labels`, `assignees`, `repos`), la comparación es
**pertenencia**, no igualdad de lista.

## DSL de outcomes

Un solo canal por slot — `onProcess`, `onFinish`, `onError` — y todo lo que el agente
escribe de vuelta va **contra los campos del source, según su definición**
(`ProjectSource.getFields()` → `{name, dataType, options}`). No hay un canal aparte para
labels: las labels son el campo multi-valor del source.

### Forma corta: nombre de status pelado

```yaml
onFinish: 'In Review'      # equivalente a $set:status=In Review
```

### Forma general: `$set:`

```yaml
onFinish: '$set:status=In Review,Reviewed=true'
```

- Los pares se separan con `,`; el campo y el valor, con el **primer** `=`.
- `status` se enruta a `applyTransition`; todo lo demás va a `setFields`, que resuelve
  cada campo contra su definición en el source (columnas del GitHub Project, o labels
  `field:<name>=<value>` en `github-issues`).

### Campos multi-valor: tokens con signo

Un campo de un solo valor se **asigna**. Uno multi-valor (hoy `Labels`, publicado por
`getFields()` con `dataType: 'MULTI_SELECT'`) recibe **operaciones**, porque el agente casi
nunca quiere "las labels son exactamente éstas" sino "agregá ésta, sacá aquélla" sin pisar
lo que pusieron otros:

```yaml
onProcess: '$set:Labels=-agent:build,-ci-checked'
onFinish:  '$set:status=In Review,Labels=+agent:review'
onError:   '$set:Labels=+blocked'
```

Gramática de los tokens: `+añadir`, `-quitar`, `=reemplazar` (mezclables y repetibles).

- Si hay al menos un token `=`, la base es **exactamente** ese conjunto. Un `=` pelado
  vacía el campo.
- Si no hay `=`, la base es el valor actual del campo.
- Sobre la base se aplican los `+` y después los `-` — **quitar gana sobre añadir**.
- Un token sin prefijo se trata como `+`.

Lo resuelve el source (`applyMultiValueOps`, `packages/issue-sources/src/dispatch/field-ops.ts`),
no el DSL: cada source sabe además qué valores son bookkeeping propio y no debe dejar que
una operación los toque (en `github-issues`, el `anchorLabel`, el `status:*` vigente, el
flag de working y los `field:*`).

### Cómo parsea el `$set:` (por qué los tokens con signo conviven con el `,`)

Un token **sin `=` es la continuación del valor del par anterior**, no un par roto que se
descarta:

```
$set:Labels=+a,-b        → { Labels: '+a,-b' }          ← formato que emite el editor
$set:Labels=+a,Labels=-b → { Labels: '+a,-b' }          ← clave repetida: acumula
$set:Repos=api,web       → { Repos: 'api,web' }         ← valor con comas, también sobrevive
```

Sin esa regla, `Labels=+a,-b` perdía todo menos el primer token — que es exactamente la
razón por la que las labels vivían en un canal aparte antes de unificarse acá.

> **Ya no existen** `onProcessLabels` / `onFinishLabels` / `onErrorLabels` ni el prefijo
> `$labels:`. Si ves uno en un roster o en un ejemplo viejo, está desactualizado: se
> traduce moviendo los tokens al `$set:` del mismo slot, como campo `Labels`.
> La migración 039 hizo esa conversión sobre la tabla `agents`.

## Cerrar el ciclo (la regla que evita loops)

| Activación | Qué debe hacer el agente al terminar |
| --- | --- |
| `statusName: X` | `onFinish` mueve el status fuera de `X` |
| `when: Labels = agent:X` | `onProcess` quita `agent:X` (al arrancar, para que el daemon no lo re-tome mientras corre) y `onFinish` pone la del paso siguiente |
| `when: campo $null` | El run debe dejar ese campo con valor (`$set:` o una tool) |

El `onError` debe llevar a un estado distinto del activador (típicamente `+blocked`, o
retroceder al paso anterior para reintento), o el issue rebota infinitamente.

## Blockers

`allowBlocked: false` (default) hace que `TaskDispatcher` consulte `manager.getBlockers`
y skipee el issue si tiene dependencias abiertas. Ponlo en `true` para agentes cuyo
trabajo es válido igual (refinar, taggear, comentar) y déjalo en `false` para los que
implementan.
