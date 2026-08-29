# Activación y outcomes

## Los 6 filtros de selección

`packages/agent-engine/src/agent-selection.ts` → `selectAgent` (0–4, puros, sin I/O) y
`packages/agent-engine/src/agent-text-gate.ts` → `selectAgentGated` (el 5, que envuelve
al anterior). Se evalúan en orden; gana el **primer** agente que sobrevive a todos.

| # | Filtro | Rechaza cuando |
| --- | --- | --- |
| — | `enabled` | `enabled === false` |
| 0 | **Scope** | El agente NO tiene `statusName` ni `when` no vacío |
| 1 | Project | `agent.projectId` está seteado y != `task.projectId` |
| 2 | Repo | `agent.repoName` está seteado y no está en `task.repos[]` |
| 3 | Status | `agent.statusName` está seteado y != `task.status` (case-insensitive) |
| 4 | When | `evalWhen(task, agent.when)` da `false` |
| 5 | **WhenText** | `agent.whenText` está seteado y el clasificador dice que el issue no lo cumple |

**Orden de evaluación de candidatos:** especificidad primero (agentes con `projectId`
antes que globales), luego `position` ascendente, luego `id` alfabético. Comparar
`position` entre scopes no significa nada — cada scope numera desde 0.

### El filtro 5 — `whenText`

Los filtros 0–4 comparan valores exactos. `whenText` es una frase en castellano que un
Haiku evalúa contra título, tipo y descripción del issue: expresa criterios que el DSL no
puede ("este cambio tiene efecto observable en runtime").

```yaml
whenText: >-
  El issue requiere validación end-to-end en runtime: toca handlers de eventos,
  endpoints HTTP, colas, schedulers o notificaciones. NO lo requiere un refactor,
  un renombre, o un cambio que los tests unitarios ya cubren enteros.
```

- **Es un gate, no un desempate.** Un agente con `whenText` queda descartado aunque sea
  el único candidato. Ojo: `AgentProviderChoiceSchema.whenText` es el MISMO nombre con
  otra semántica — allá sólo desempata entre >1 provider y nunca rechaza al único.
- **Se evalúa último**, después de los filtros baratos: un agente que ya cayó por status
  o por `when` nunca llega a costar una llamada al modelo.
- **El veredicto se cachea** por (agente + `whenText` + contenido del issue). Reescribir
  la descripción o el criterio lo invalida solo; nada más lo hace.
- **"No pude decidir" ≠ "no aplica".** Sin auth o con la API caída, el dispatch se
  saltea entero y el próximo scan reintenta — no cae al siguiente candidato ni adivina.
- **Sin clasificador inyectado, `whenText` no filtra nada.** Sólo el daemon lo cablea
  (`composition/container.ts` → `classifyAgent`).
- **Escribí el criterio con su negativo explícito.** "Requiere X: A, B, C. NO lo requiere:
  D, E." rinde mucho mejor que sólo la mitad positiva — acá no aplica la regla de "prompt
  en positivo" de los prompts de agente: esto no es una instrucción, es una definición de
  frontera, y una frontera necesita sus dos lados.
- **Cuándo NO usarlo:** si el criterio se puede expresar con una label o un campo, usá
  `when`. `whenText` cuesta una llamada y una decisión no determinística; se justifica
  cuando el agente que gatea es caro de correr de más (levanta servicios, toca staging).

### Por qué existe el filtro 0

Sin `statusName` ni `when`, ningún criterio deja de cumplirse cuando el agente termina:
`statusName: null` matchea cualquier status, así que el `onFinish` que mueve el issue no
lo saca de la selección. El próximo scan lo vuelve a elegir para el MISMO issue → loop.
El diagnóstico aparece en los logs como `rejected: unscoped: <id>`.


## Salidas (`exits`) — antes `onFinish` / `onError`

Un run termina aplicando **una** transición. `onFinish` y `onError` ya eran dos salidas
con nombre hardcodeado; `exits` las nombra y deja declarar más.

```yaml
onProcess: '$set:Labels=-agent:review'      # hook: corre siempre al arrancar
exits:
  success: '$set:Labels=+agent:e2e'          # ← era onFinish
  error:   '$set:Labels=+blocked'            # ← era onError
  back-to-build:                             # ← la pide el agente por nombre
    set:  '$set:Labels=+agent:build'
    when: 'El PRD está bien y lo que falla es la implementación ya escrita.'
```

**El `when` no es un comentario: es lo que el modelo lee para decidir.** Viaja al enum de
`select_exit` como descripción. Sin él, el agente ve `back-to-build` pelado y depende de que
alguien se haya acordado de explicarlo en el prompt — o sea, declarar la salida y explicar
cuándo usarla son dos ediciones en dos lugares, y olvidar la segunda deja config muerta. Es el
mismo modo de falla que tuvo `whenText`.

`success`/`error` van en forma corta (sólo el `$set:`): las elige el engine, el agente nunca
las pide, no hay nada que explicarle.

**Nombres en kebab-case** (`^[a-z0-9]+(-[a-z0-9]+)*$`) — el editor web rechaza el resto, junto
con los duplicados y los que chocan con las reservadas. Los tres casos antes se guardaban
pisando otra salida en silencio.

- **`success` y `error` son nombres reservados**: el default que el engine elige según
  cómo terminó el run. Ausentes = no se aplica ninguna transición por ese camino.
- **Cualquier otra clave la pide el agente** con `select_exit`, y **sólo por nombre**:
  nunca recibe un mapa de campos libre. El operador dibuja todas las aristas; el agente
  elige entre las dibujadas, así que el pipeline se sigue leyendo entero en el YAML.
- **`onProcess` no es una salida** y por eso queda afuera del mapa: es un hook que corre
  siempre al arrancar, no un destino entre los que elegir.

### `select_exit`

```
select_exit({ task_id: '{{task.id}}', exit: 'back-to-build' })
```

No cierra el run — registra la elección y se aplica al terminar. Es también la **única**
forma que tiene un agente SYNC de elegir salida: allá el run lo cierra el engine al ver
`end_turn`, no el modelo, así que no hay un `complete_task` donde pasarla.

Cuatro cosas impiden que el agente invente una transición:

| Capa | Qué frena |
| --- | --- |
| El enum llega al modelo (`exit: {enum: [...]}`, armado por dispatch) | Emitir un valor fuera del set |
| Validación al ejecutar | El curl a mano de async, un agent-host remoto |
| Sin salidas elegibles la tool no se ofrece | Un agente que no debe ramificar |
| El DSL sigue siendo `$set:` contra campos del source | Escribir un campo inexistente |

### Cuándo declarar una salida con nombre

Cuando el agente tiene que poder mandar el issue a **dos destinos distintos por el mismo
camino**. El caso canónico: un refiner que descubre que el PRD está bien y lo que falla es
la implementación — devuelve al builder (`select_exit` + `fail_task`) en vez de bloquear.
Un `fail_task` sin elegir salida sigue yendo a `error`.

Si el agente sólo tiene un destino por camino, no declares nada: `success`/`error` alcanzan
y el agente no ve el parámetro.

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
