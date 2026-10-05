# @ia-flow/agent-engine

Harness domain-agnostic para componer agentes en pipelines que reaccionan a eventos
(GitHub, Slack, cron, un pedido de viaje — lo que sea). Ver `README.md` para el contrato
completo; esto es guía específica para trabajar en el código del paquete.

## Qué es y qué NO es este paquete

Es **contrato puro, sin I/O**: interfaces y clases (`DomainEvent`, `EventBus`, `Condition`,
`Runnable`, `Agent`, `Pipeline`, `Engine`, `AgentDefinitionProps`, `Provider`,
`ProviderRegistry`, `ToolRegistry`, `SchemaTool`, `Action`, `PipelineSource`, la cascada de rutas). Las
dependencias runtime son `zod` — la usan `SchemaTool`, `Action`, el `input` de `Agent` y los
schemas de `submit_*`; es validación pura en memoria — y `@ia-flow/telemetry` (trazas y logs
por las APIs de OpenTelemetry; ver "Telemetría" abajo), que sin un SDK registrado es no-op sin
I/O. Ninguna rompe la regla de abajo. No sumes otra sin una razón igual de fuerte — y nunca un
SDK de OTel: eso lo elige la app.

La regla NO es "nada que mencione un LLM" — `Agent` sabe
que existe un `prompt`, `systemPrompts`, sus salidas; eso es dominio, no infra, porque es
TypeScript puro sin `fetch` ni credenciales. La línea real es **contrato vs. implementación
con I/O real**: un `Provider` CONCRETO que le pega a la API de Anthropic/OpenAI/lo que sea
(hace `fetch`, lee `process.env`, maneja retries) es infra — vive en su propio paquete
(`@ia-flow/provider-anthropic-api`), nunca en `src/` de ESTE paquete. Antes de agregar algo acá,
preguntate: ¿esto compila sin tocar la red ni el filesystem? Si la respuesta es no, no va acá.

## Estructura

```
src/
├── agent/
│   ├── Agent.ts             un Runnable respaldado por un LLM: provider + render + tools + turno
│   ├── AgentDefinition.ts   AgentDefinitionProps + tipos (SystemPromptRef, Tool, McpServerRef, ...)
│   ├── TurnProtocol.ts      cómo termina un turno: submit_*/fail_turn/yield_turn → AgentRunResult
│   ├── SubmitTool.ts, FailTool.ts, YieldTool.ts   las tools con las que el modelo cierra su turno
│   ├── PromptRenderer.ts    {{path}} + system prompts (SystemPromptCatalog, puerto)
│   ├── Toolset.ts           tools + acciones (guarda de escritura) + nombres únicos
│   ├── Provider.ts          Provider (interfaz) + ProviderRegistry + providerRegistry (singleton)
│   ├── ToolRegistry.ts      base genérica de registry de Tool con AUTO-REGISTRO por clase
│   ├── SchemaTool.ts        base de Tool con input declarado como z.strictObject (valida + JSON Schema)
│   └── tests/
├── capability/
│   ├── Capability.ts        lo que el engine le pide a un modelo: nombre + input/output (zod)
│   ├── Capabilities.ts      corre el `Runnable` enchufado a cada una (`ctx.capabilities`)
│   └── tests/
├── condition/
│   ├── Condition.ts, Conditional.ts, EventFilter.ts
│   ├── TextClassifier.ts, CapabilityTextClassifier.ts   el gate semántico (`whenText`)
│   └── tests/
├── events/
│   ├── DomainEvent.ts, EventBus.ts
│   └── tests/
├── pipeline/
│   ├── Pipeline.ts          fachada: props, execute; compone las cuatro de abajo
│   ├── PipelineTrigger.ts   qué eventos la arrancan (EventFilter + scope + enabled)
│   ├── PipelineGraph.ts     el grafo, analizado una vez: agentes, pausas, destinos, validación
│   ├── StepRunner.ts        corre un paso, su salida (report + destinos) y su onError
│   ├── Checkpoints.ts       guardar/retomar por dónde sigue una pausa
│   ├── Runnable.ts          base de todo lo que vive en Pipeline.do[] (+ StepOutcome, Resumable)
│   ├── ParallelGroup.ts     varios pasos a la vez + veredicto combinado (`passed`/`failed`)
│   ├── tracing.ts           qué deja la Pipeline en la traza (opciones de @traced)
│   ├── tests/
│   └── actions/
│       ├── Action.ts         Action (input tipado) + BoundAction (bind) + AllowedAction (allowWrite)
│       ├── ActionTool.ts     una Action como tool de un agente
│       ├── Pause.ts          la pausa en curso (valor, serializable: toJSON/fromJSON)
│       ├── PauseAction.ts, EmitAction.ts, HttpAction.ts, FunctionAction.ts
│       ├── HttpStep.ts, EmitStep.ts, ActionStep.ts   con `{{...}}` resueltos al correr
│       └── tests/
├── template/
│   └── Template.ts          `{{path}}` al correr (render) y `{{vars.x}}` al leer (substituteVars)
├── routing/
│   ├── ExitRoutes.ts        END, ExitRoutes, resolveRoutes (la cascada), submitSchemaFor
│   └── tests/
├── engine/
│   ├── Engine.ts            fachada: start, dispatch, tick, select
│   ├── DispatchPlanner.ts   qué pipelines corren para un evento (y la de un checkpoint)
│   ├── ExecutionCoordinator.ts  el evento frente a la ejecución de su task (inject, wake, ifRunning, vencer)
│   ├── RunLauncher.ts       lanzar corridas (esperadas con AggregateError, o desacopladas)
│   ├── Redelivery.ts        re-despachar lo inyectado que nadie leyó
│   ├── Execution.ts         UNA ejecución: ciclo de vida + ExecutionRecord + ExecutionJournal
│   ├── Inbox.ts             lo que le llega a una ejecución (entregado / no aceptado)
│   ├── ExecutionStore.ts    una por task + tope + ifPaused + recuperación, sobre un repositorio
│   ├── ExecutionScheduler.ts, KeyedQueue.ts, Semaphore.ts   turno por task + tope global
│   ├── ExecutionRepository.ts   el puerto de persistencia (síncrono)
│   ├── InMemoryExecutionRepository.ts, InMemoryExecutionStore.ts
│   ├── PipelineSource.ts    la fuente del roster (interfaz) y StaticPipelineSource
│   ├── tracing.ts           qué deja el despacho en la traza (opciones de @traced/@tagged)
│   └── tests/               … + tracing.test.ts (la forma de la traza de un evento)
├── testing/                 suites de contrato (`@ia-flow/agent-engine/testing`) para adaptadores
├── index.ts
└── tests/                index.test.ts
```

Los examples (los tres casos de uso que motivaron el paquete) NO viven acá — ver
"Por qué los examples no viven adentro de este paquete" en `README.md`. Quedaron en el repo
ia-tools (`examples/`, gitignoreado, no migrados), porque combinan este paquete con
`@ia-flow/provider-anthropic-api`, y ese paquete depende de éste — meterlos adentro crearía una
dependencia cíclica entre workspaces.

### `Runnable` — la base única de `Pipeline.do[]`

Antes había dos contratos separados: `PipelineAction` (lo que vivía en `do[]`) y `Agent`
(resuelto por id vía un `AgentRegistry`, puenteado por un `AgentAction`). Se colapsaron en
uno: `Runnable` es la base, `EmitAction`/`HttpAction`/`FunctionAction` la extienden para
pasos genéricos, y `Agent` la extiende directo para pasos respaldados por LLM — sin
indirección de por medio. `AgentAction`, `AgentRegistry` y `functionAgent` ya NO EXISTEN:
reusar el mismo agente en dos pipelines es, como con cualquier otro objeto TS, importar la
misma instancia dos veces; un paso determinístico nombrado es un `FunctionAction` (con su
propio `when`/`id`), no un "agente" fingido.

`isAgent(step)` (en `Pipeline.ts`) es el type guard para distinguir un `Agent` de un
`Runnable` genérico dentro de un `do[]` construido dinámicamente (mira `step.kind`).

**La pipeline pregunta capacidades, no clases.** `Runnable` declara cuatro puntos de extensión con
default neutro: `kind` (`agent`/`action`, para la traza), `exitRoutes` (un paso que elige
salidas), `asResumable()` (un paso que pausa y se reanuda por ramas) y `outcome(output)` (cómo la
pipeline lee lo que devolvió `run`: output, salida elegida o pausa). `Agent` y `PauseAction` los
sobreescriben; `PipelineGraph`, `StepRunner` y la traza no hacen `instanceof`. Un tipo de paso
nuevo que elige salidas o pausa entra sin tocar `Pipeline` (ver `PipelineGraph.test.ts`).

### Una clase con comportamiento por archivo

Cada clase con comportamiento vive en su propio archivo (los tipos, interfaces y funciones
puras pueden compartirlo). La excepción es `BoundAction`, en `Action.ts`: extiende `Action` y
`Action.bind` la construye, y partir ese ciclo en dos módulos ESM cae en TDZ según el orden de
carga. `AllowedAction` es un envoltorio sin comportamiento.

## Tests — en un `tests/` DENTRO de cada carpeta, no colocados ni en un árbol aparte

Cada carpeta de `src/` que tiene código tiene su propia subcarpeta `tests/` al lado — NO
`Agent.test.ts` junto a `Agent.ts` (colocado), y NO un árbol `tests/` separado en la raíz
del paquete que espeje a `src/` (esquema anterior, se descartó). `src/agent/tests/Agent.test.ts`
prueba `src/agent/Agent.ts`; un archivo nuevo en `src/foo/Bar.ts` implica crear
`src/foo/tests/Bar.test.ts`.

El import al módulo que prueba es siempre `../Bar.js` (un nivel arriba de `tests/`, directo
al hermano); un import a OTRO módulo del paquete sale desde ahí con la profundidad relativa
que corresponda (ej. `src/pipeline/actions/tests/EmitAction.test.ts` importa
`../../../events/DomainEvent.js`). Nunca importa desde otro archivo de test.

`vitest.config.ts` mira `src/**/tests/**/*.test.ts`. Correr con
`bun run --filter @ia-flow/agent-engine test` (o `bun run test:agent-engine` desde la raíz).

## TypeScript — source-only

El paquete no se compila: los `exports` de `package.json` apuntan a `src/*.ts` y quien lo
consume (Bun, vitest) lee el TypeScript directo. No hay `dist/` ni `tsconfig.build.json`.

- **`tsconfig.json`** — el del editor y de `typecheck` (`tsc --noEmit`). Extiende
  `../../../tsconfig.base.json` (raíz del repo) e incluye sólo `src` (que ya trae sus `tests/`
  anidados). Una opción de compilador que aplica a todo el monorepo va en el base, no acá.

## `DomainEvent<any>` en las firmas del harness — no es un descuido

`EventBus`, `Engine`, `Pipeline` y `PipelineExecutionContext` tipan sus eventos como
`DomainEvent<any>`, no como `DomainEvent` a secas (que resuelve al default
`DomainEvent<Record<string, unknown>>`). El harness no le exige forma al `payload` — eso
es conocimiento de cada `Agent` de dominio (`GithubIssuePayload`, `SlackMessagePayload`,
`TripRequestPayload`, ...). Si el genérico quedara en su default, cualquier evento creado
con `createEvent<TripRequestPayload>(...)` dejaría de ser asignable a las firmas internas
del motor — que es justo el caso de uso central del paquete. Si tocás una de esas firmas,
mantené `DomainEvent<any>`.

## `ToolRegistry<TArgs>` — auto-registro de `Tool` por clase, no un array a mano

Nace de portar `@ia-flow/github-tools` (y después `fs-tools`) a clases: cada dominio de tools
(GitHub, filesystem, lo que sea) tiene su propio registry (`GithubToolRegistry`,
`FsToolRegistry`) que resuelve tools por nombre — mismo contrato que `ProviderRegistry`
(`get`/`resolve`), pero para tools que un consumidor NO instancia a mano, sino que se
auto-registran al definirse.

El patrón: una tool concreta extiende una clase base DEL DOMINIO (`GithubTool`, `FsTool` — no
viven acá, cada paquete de tools define la suya con SU lógica compartida); el registro
(`SuRegistry.register(SuTool)`) vive CENTRALIZADO en `SuRegistry.ts`, una línea por tool,
DESPUÉS de la declaración de la clase — no repartido en cada archivo de tool. La forma "más
auto" (cada tool se registra sola al final de su propio archivo) se probó y se descartó: crea
una dependencia circular real con el archivo del registry (que a su vez necesita importar los
archivos de tools), y en ESM eso cae en TDZ — la clase del registry todavía no terminó de
inicializarse en el punto donde el archivo de la tool, importado a mitad de esa evaluación,
intenta usarla. `new SuRegistry(...)` instancia recién ahí todo lo registrado. Agregar una tool
nueva nunca toca la lógica de construcción del registry (`ToolRegistry`, acá) — sólo el archivo
de la tool nueva, el barrel `tools/index.ts`, y una línea de `.register(...)` en `SuRegistry.ts`.

**El único punto no-obvio**: `protected static registeredTools` se declara en la base
(`ToolRegistry`) pero cada subclase concreta TIENE QUE redeclararlo (`protected static
registeredTools: ToolConstructor<[TusArgs]>[] = [];`) — un `static` de la base es una única
propiedad compartida por prototype chain; sin la redeclaración, dos dominios distintos
terminarían empujando a la MISMA lista. El test que lo prueba (`ToolRegistry.test.ts`, "dos
subclases que redeclaran su propio registeredTools NUNCA comparten lista") es el que hay que
mirar si esto se rompe.

**Riesgo conocido, sin guarda en runtime**: si una subclase nueva se OLVIDA de redeclarar
`registeredTools`, `register()` no tira — empuja en silencio a la lista de la BASE, compartida
por cualquier otro dominio que tampoco la haya redeclarado. No hay ningún chequeo (`Object.
hasOwn(this, 'registeredTools')` u otro) que lo detecte hoy; queda como algo a mirar si un
registry nuevo aparece con tools de otro dominio mezcladas.

`static register()` usa `this.registeredTools` con `this` POLIMÓRFICO a propósito (la subclase
real que llamó `.register`) — de ahí el `biome-ignore lint/complexity/noThisInStatic` puntual:
el fix automático de biome ("usar el nombre de la clase") rompería justo el aislamiento que
este diseño busca.

## `SchemaTool<S>` — el input de una tool se declara una vez, en zod

El input de una `Tool` lo escribe el MODELO, nunca un caller de confianza — y `AnthropicProvider`
se lo pasa a `handler` tal cual. Antes cada tool mantenía a mano una `interface` TS y un
`inputSchema` JSON que podían divergir, y nada validaba en runtime (un `fs_edit` sin `newString`
escribía el literal "undefined" en el archivo). `SchemaTool` junta las tres cosas: la subclase
declara `input` (un `z.strictObject`), implementa `execute(input: z.infer<S>)`, y la base deriva
`inputSchema` (`z.toJSONSchema`, sin `$schema`) y valida en `handler` antes de llamar a `execute`.

- `handler` es `async` y RECHAZA con `z.prettifyError` si el input no valida — `AnthropicProvider`
  ya convierte cualquier rechazo de un handler en un `tool_result` con `is_error: true`, así que
  el modelo ve qué campo falló y se corrige solo.
- `ToolInputSchema` fuerza `strictObject` a nivel de tipo: claves que el modelo invente se
  rechazan en vez de descartarse en silencio.
- `inputSchema` es un getter perezoso, no un field: `input` es un field de la SUBCLASE, que
  todavía no está asignado cuando corre el constructor de la base.
- La interfaz `Tool` no cambia: un consumidor puede seguir implementándola a mano con JSON Schema
  plano (los fixtures de `ToolRegistry.test.ts` lo hacen). `SchemaTool` es opt-in.

## Salidas de un agente — `routing/ExitRoutes.ts`

Reemplaza a `exits`/`comment`/`emitOn` (el modelo de ia-flow). Un agente termina eligiendo una
SALIDA con una tool `submit_<salida>`, cuyo schema es el input de los pasos a los que lleva — ver
`submitSchemaFor`. Qué salidas hay y a dónde llevan se resuelve en cascada, **paso > pipeline >
agente > proyecto**, con `resolveRoutes` (pura, sin I/O). Reglas que no son obvias al leer el código:

- **`firstMatch: true` hace de `do` una lista de alternativas.** Corre sólo el primer paso cuyo
  `when`/`whenText` pasa, y al reanudar una pausa de ese paso no sigue con los demás (el checkpoint
  guarda `resumeAt = do.length`). Sin esto, los pasos corren en orden y una pausa reanudada sigue
  con los siguientes — con condiciones evaluadas contra el evento que la despertó.
- **`whenText` es un gate impuro, aparte del `when`.** Un modelo decide si el evento cumple el
  criterio: el `TextClassifier` del engine pide la capacidad `whenText` (ver "Capacidades"). Lo evalúan el
  `DispatchPlanner` (el de una pipeline, sólo si ya pasó todo lo barato y ANTES de elegir la
  `exclusive`) y el `StepRunner` (el de un paso). Sin clasificador o sin veredicto, no corre:
  nunca se adivina. Una llamada por (evento, criterio). Una fuente no lo tiene (sería un modelo
  por evento), y una pausa o unos `injects` no lo evalúan (son sincrónicos).
- **El engine no sabe de proyectos: sabe de fuentes.** `PipelineSource` (`list`, `id`,
  `defaults`, `explainMismatch`) es todo lo que el planner necesita; "un proyecto" es cómo una
  app agrupa pipelines (ej. una carpeta YAML) y lo expone como una fuente — en código,
  `new StaticPipelineSource(pipelines, { id, defaults })`. El "nivel proyecto" de la cascada de
  rutas es el `defaults` de la fuente.
- **Sólo el agente crea salidas** (vocabulario + `when`). Un override de una salida no declarada
  tira: un typo tiene que romper al construir, no quedar como config muerta.
- **Las rutas base del agente sólo apuntan a acciones.** Encadenar agentes se declara en la
  pipeline (`routes.<agentId>`), donde se ve el grafo completo; si no, incluir un agente
  arrastraría el grafo de otros. `Agent` lo valida en su constructor.
- **Una salida sin `to` es sólo vocabulario** (ej. `comment-triage.actionable`): la pipeline
  tiene que ponerle destino o la construcción falla.
- **`report` corre ANTES que los destinos.** El siguiente agente (disparado por un cambio de
  status) lee los comentarios del issue; si la transición fuera primero, arrancaría sin ver el
  hallazgo que lo mandó ahí. Este orden vive en `StepRunner`, en un solo lugar.
- **Proyecto y pipeline sólo definen `onError`/`report`** (`ExitDefaults`): no conocen a los
  agentes, no pueden inventarles salidas.
- **Los loops no van por rutas.** `Pipeline` rechaza ciclos entre agentes; un "review → build"
  pasa por un evento (el cambio de status), con el tope de profundidad del `Engine`.

`PipelineGraph` valida todo el cableado al construir la pipeline, llamando a `resolveRoutes` sin
el nivel proyecto (que llega en runtime vía `ctx.defaults` y sólo aporta `onError`/`report`).

**Un grupo `parallel` (`ParallelGroup`) corre varios pasos A LA VEZ** dentro de la misma ejecución
y combina su veredicto (`until: { all | any: [salidas] }`) en una de dos salidas propias, `passed`
o `failed`. Lo corre `StepRunner.runGroup` (`step.members` es la señal). Reglas no obvias:

- **Las salidas de un miembro son veredicto y reporte, nunca transición.** `PipelineGraph` las
  resuelve todas a `END` (`memberLayer`) aunque el agente declare destinos, y rechaza un
  `routes.<miembro>` con `to`: dos miembros moverían la tarjeta en sentidos opuestos. Cada miembro
  publica SU reporte; la transición es la del grupo.
- **Cuentan sólo los miembros que corrieron.** Uno salteado por su `when` no vota; si no corrió
  ninguno, no hay veredicto y no corre ninguna salida.
- **Un miembro que tira o termina sin salida** (`truncated`/`cancelled`) hace tirar al grupo, una
  vez: corre el `onError` de la cascada del grupo, no el de cada miembro. Se espera a todos antes:
  los que terminaron ya publicaron.
- **Interrumpido**, cada agente activo lee el aviso y cede; el grupo corre su `onInterrupt` UNA vez
  con `progress` = en qué quedó cada miembro.
- **Un miembro no puede pausar** (`waits` incluido): el grupo no sabría por dónde seguir.
- **`ctx.lane`** = el id del miembro: la app lo usa para no darle a dos miembros el mismo terreno
  (un worktree que se prepara por evento).
- El loop sigue pasando por un evento: `failed` mueve la tarjeta, no apunta a otro agente.

**`onStart` de un agente corre como paso de la pipeline** (`ctx.runStep`, que pone
`Pipeline.execute`): respeta su `when` y abre su span, pero NO aplica ningún `onError` — si tira,
el agente no arranca y el error es del agente (su cascada). Suelto, fuera de una pipeline, corre
directo.

## Capacidades — `capability/`

Lo que el engine (o un paquete de infra) necesita de un modelo sin atarse a cuál: decidir un
`whenText`, enfocar un archivo largo (`fileFocus`, de fs-tools). Una `Capability` declara SÓLO el
contrato —`name`, `input` y `output` en zod— y la declara quien la consume. Quién la cumple es un
`Runnable` que la app enchufa por nombre en `EngineOptions.capabilities` (fijo, o una función que
resuelve en cada pedido: una fuente que se recarga). Sin nadie enchufado, la capacidad está
apagada y quien la pide degrada — nunca tira por eso.

- **`Capabilities.invoke(capability, input)`** corre el `Runnable` fuera de toda pipeline y
  ejecución: un evento `capability.<nombre>` cuyo payload es el input (un prompt lo lee como
  `{{campo}}`), y el input también como `input` del paso. Valida la salida contra `output`.
  Con `{ onText }` (tercer argumento) el texto del modelo sale en vivo: viaja en
  `ctx.onText` hasta el `Agent`, que se lo pasa al provider (`ProviderRunContext.onText`).
- **Un `Agent`** corre con TODAS sus salidas llevando a un paso `result` cuyo input es `output`:
  el modelo entrega la respuesta en `submit_<salida>.result`. Sin reportes, `onError` ni
  `onInterrupt` — el agente de una capacidad no publica nada.
- **Los pasos las ven en `ctx.capabilities`** (`CapabilityInvoker`: `has`, `invoke`). Lo pone el
  `Engine` en el contexto de cada pipeline, y `invoke` se lo pasa también al paso que la cumple.
- **Nada de I/O acá**: el cliente de Anthropic que antes clasificaba los `whenText` desde el
  core se fue. Ahora es un agente YAML (`text-classifier` en runner-v2).

## Ejecuciones — `engine/`

Con `EngineOptions.executions`, cada corrida de una pipeline CON agentes sobre una task (la
`executionKey` del evento; default, su `scope`) es una `Execution`. Eso le da al engine el control
que antes tenía la cola de cada app: una task nunca corre dos a la vez y hay un tope global de
ejecuciones en paralelo. Un evento para una task con una ejecución en curso sigue este orden:

1. **Se le ofrece al paso activo de la ejecución** (`Execution.inject` → `Runnable.accepts`). Un
   `Agent` acepta lo que pasa alguno de sus `injects` (`{ on, when }`, un `EventFilter`); lo lee
   en su próxima vuelta por `ProviderRunContext.inbox`. Si lo acepta, ninguna regla con agentes
   arranca otra corrida sobre la task.
2. **Si no lo acepta** (no hay paso en su loop, o no es un evento suyo), sigue la cascada normal
   y cada regla que matchea decide con su `ifRunning`: `wait` (default, corre después), `skip`, o
   `interrupt` (corre después, y además le avisa al agente que corre que ceda su turno).

Reglas que no son obvias al leer el código:

- **Cada comportamiento vive en quien lo tiene.** Qué eventos acepta un paso lo declara el paso
  (`AgentDefinitionProps.injects`, porque es él quien lo lee). Lo de UNA ejecución está en
  `Execution`: su paso activo, su inbox, `inject`, `owns(event)` (nació en ella), `run`/`close`
  (queda `done`/`failed` y loguea abre/cierra); lo que le llega, en su `Inbox`. Lo del conjunto
  —una por task, el tope global— es del `ExecutionStore` (turnos en su `ExecutionScheduler`). Qué
  hace una regla si la task está ocupada lo declara la regla (`Pipeline.ifRunning`). El despacho
  sólo ordena: primero la ejecución (`ExecutionCoordinator`), después la cascada
  (`DispatchPlanner`).
- **Los `injects` del agente son TODO el filtro.** Un evento inyectado no pasa por el `when` de
  ninguna regla con agentes: lo que las reglas excluyen (ej. los comentarios que publica el propio
  engine) tiene que estar también en el `when` del `injects`.
- **Las reacciones sin agentes corren igual.** Inyectar sólo reemplaza a las reglas CON agentes de
  esa task; una pipeline sin agentes que matchea el evento (poner un label) corre como siempre.
- **Sólo el paso EN SU LOOP con el modelo puede aceptar.** `Agent` marca `enter`/`leave` alrededor
  del provider. Entre pasos, o antes/después de un agente, no hay quién lo lea: el evento sigue
  por las reglas.
- **Puede haber varios pasos activos a la vez** (un grupo `parallel`). Un evento se entrega UNA
  vez a todos los que lo aceptan, y cada uno lee lo suyo (`drain(reader)`): con una sola bandeja,
  el primero que la vaciara se llevaría lo de los demás. Lo que leyó uno no vuelve por las reglas
  aunque otro no lo haya leído. Una interrupción le avisa a cada agente activo, y también al que
  entre a su loop después (un miembro que todavía preparaba su terreno): todos ceden. `active` es el
  primero que entró; `activeSteps`, todos.
- **Nada inyectado se pierde.** Lo que llegó después de la última vuelta del agente queda sin leer
  (`Execution.takeUnread()`, que los consume); al cerrar —o pausar— la ejecución el engine lo vuelve a despachar contra las reglas
  CON agentes (las reacciones ya corrieron la primera vez) y, ya sin nada corriendo, arranca
  normal.
- **Una ejecución se puede pausar entre pasos** (`PauseAction`, como destino de una salida o en
  `do[]`). La `Pipeline` corta ahí y le pasa a la ejecución la `Pause` (qué la despierta: ramas
  `{ on, when, to }` y un `timeout` opcional) y el `Checkpoint` (por dónde sigue: ids, índices y
  `ctx.steps` — serializable, para un store persistente). Pausada, devuelve su lugar y su task.
- **Un evento para una task pausada:** si pasa una rama, la reanuda (`Execution.wake` → el store
  la vuelve a admitir → la pipeline sigue con el `to` de la rama y el resto de `do[]`; el evento
  que la despertó queda en `steps.<pausa>`). Si no, sigue la cascada normal, y si una regla con
  agentes arranca una corrida sobre la task, la pausa queda `superseded` — esa corrida lee el
  estado nuevo. Una pausa no bloquea su task.
- **Una regla puede NO reemplazar la pausa: `ifPaused: 'wait'`.** Espera a que la pausa termine
  (despierte o venza) y corre después — también si llegó mientras la corrida anterior todavía
  corría y le toca justo cuando esa corrida se pausa. Es para reglas que pueden no hacer nada (un
  triage de comentarios): con el default (`supersede`), un `not_actionable` se llevaba puesta la
  espera del CI y nadie seguía desde ahí (subscriptions#1625, la tarjeta nunca pasó a Review).
  Mientras espera NO ocupa la task ni un lugar bajo el tope (`start` los devuelve y espera
  `finished`): si los retuviera, la pausa no podría despertar ni vencer. Si otra regla reemplaza
  la pausa en el medio, corre después de esa. Una pausa sin `timeout` que nunca despierta la deja
  esperando para siempre.
- **Las pausas vencen con `engine.tick()`**, que la app llama cada tanto (el engine no tiene
  reloj): la reanuda por su rama `timeout` con un evento `execution.expired`. Sin `timeout`, una
  pausa espera hasta que llegue una rama o la reemplacen.
- **Despertar es sincrónico y de una sola vez.** `wake` la pasa a `running` en el acto y el store
  ocupa la task en el mismo tick: dos eventos que la despiertan a la vez la reanudan una vez.
  Pasa DESPUÉS de `decide`, pegado a lanzar la corrida (si leer las reglas falla, la pausa sigue
  intacta), y nunca con la task `busy`: una corrida ya en cola sobre la task la va a reemplazar,
  y reanudarla después seguiría desde un checkpoint viejo. `tick` respeta lo mismo.
- **Lo que puede pausar va último, y nunca en un `onError`.** El `Checkpoint` sabe seguir `do[]`,
  no una lista de destinos a medias: una `PauseAction` (o un agente que llega a una por sus
  salidas) que no es el último destino de su lista, o que está en un `onError`, rompe al
  construir la pipeline — lo que viene después se perdería sin error. El `onError` del proyecto
  recién se conoce al correr: ahí falla al pausar.
- **Un evento que llega antes de la pausa no se pierde.** Lo que se le ofrece a una ejecución que
  corre y ningún paso acepta queda recordado (`Execution.inject`); si después se pausa, el engine
  le ofrece esos eventos a la pausa (`takeMissedWake`) y el primero que pasa una rama la
  despierta — un CI que terminó mientras el agente todavía trabajaba. No vuelven a pasar por las
  reglas: ya pasaron cuando llegaron.
- **Lo que puede pausar es una ejecución, tenga agentes o no** (`Pipeline.needsExecution`). Una
  pipeline anidada en otra ejecución (corre por un evento que emitió esa misma ejecución) no
  puede pausar: falla diciendo por qué, en vez de pisar el checkpoint de la que la contiene.
- **Si la pipeline cambió mientras esperaba, no se reanuda.** El `Checkpoint` guarda la forma de
  `do[]` (`shape`); si al reanudar no coincide, la ejecución falla en vez de seguir en otro paso.
- **Un agente también pausa, a mitad de su turno** (`wait_for_event`). Si declara `waits: { on }`
  y corre dentro de una ejecución, recibe esa tool: la llama con qué eventos esperar (sólo de los
  que declara), condiciones y plazo, y su turno termina. `Agent.outcome` lo devuelve como una
  `Pause` más (id = el del agente, ramas `event` y `timeout`) con la conversación del provider
  (`ProviderRunOutput.conversation`) como `state`, que va al `Checkpoint`. Al despertar, la
  pipeline lo retoma a él mismo (`Agent.asResumable`) con `ctx.resume`: sin `onStart`, con la
  conversación (`ProviderRunContext.resume`) y lo que pasó — el evento, o que venció. Como toda
  pausa, un agente que espera va último en su lista de destinos.
- **Retomar tras un reinicio.** Un paso de `do[]` (o el que se retoma) guarda su progreso con
  `ctx.saveProgress` — un agente, la conversación que el provider le pasa en cada vuelta
  (`saveConversation`) — y lo borra al terminar. `Execution.progress` lo anota en el
  `Checkpoint` del registro mientras corre. Al arrancar, el store retoma la que corría con
  progreso: la deja pausada y vencida (el próximo `tick`, o el que hace el runner al montar, la
  corre por `timeout`), con `RESTART_NOTE` + lo que recibió sin leer como aviso. Topes: 10
  intentos seguidos y 24 h desde que guardó (`ExecutionStoreOptions.resume`); pasados, cierra
  `failed/interrupted` como antes. Un agente anidado (destino de una salida) no guarda progreso:
  no hay cómo seguir una lista de destinos a medias.
- **Topes, del más general al más fino** — se suman, ninguno reemplaza a otro:
  1. el turno de la task (`KeyedQueue`: una task nunca corre dos a la vez);
  2. el de su grupo (`ExecutionStoreOptions.groups`: ej. las tasks de un proyecto);
  3. el global (`maxConcurrent` del store): el techo del proceso;
  4. al entrar a su paso, el del agente (`AgentDefinitionProps.maxConcurrent`) y el de su provider
     (`Provider.maxConcurrent`), en `ConcurrencyLimits` (`ctx.limits`, del `Engine`); y
     `Provider.canAccept`: si no puede ahora, el agente suelta el lugar y reintenta — se demora,
     no falla.
  1–3 se piden al abrir la ejecución (en ese orden); 4, recién cuando el paso es un agente — una
  pipeline puede tener varios. Los nombres se piden ordenados: dos pedidos que comparten lugares
  no se esperan en cruz. Un agente fuera de una pipeline (capacidad, sub-agente) no ocupa 4: un
  hijo que esperara el lugar que tiene su padre sería un deadlock.
- **Varios providers por agente** (`AgentDefinitionProps.providers`): candidatos en orden, cada
  uno una `ProviderCandidate` (un `Conditional`: su `when`/`whenText` contra el evento, como un
  paso) con su propia config. `ProviderSelector` usa el primero elegible con lugar bajo los topes
  del agente y del provider (`ConcurrencyLimits.tryAcquire`, sin esperar) y que acepte
  (`canAccept`); si todos están llenos espera a que se libere un lugar (`released`) o pase el
  `retryAfterMs`. Con un solo candidato hace cola en él. `provider` + `providerConfig` es el atajo
  de un candidato. La conversación guardada va marcada con su provider (`AgentConversation`):
  retomarla sigue en ése — la de un provider no la entiende otro. `AgentRunResult.provider` y
  `ia.agent.provider` dicen en cuál corrió.
- **Ocupada no es lo mismo que activa.** `busy(key)` se marca en el mismo tick del `start` (cuenta
  la que espera turno o lugar bajo el tope); `current(key)` es la que ya corre. `skip` mira
  `busy`; inyectar mira el paso activo de `current`.
- **Sin `executions`, nada cambia.** Todo lo que matchea corre en paralelo, como siempre. Lo mismo
  para pipelines sin agentes y eventos sin task (sin scope): no son ejecuciones.
- **Un evento que nació ADENTRO de la ejecución en curso no la espera** (sería esperarse a sí
  misma). Lo sabe por `DomainEvent.executionId`, que pone el `EmitAction` de esa corrida y
  `deriveEvent` hereda. Uno de otra ejecución, aunque sea más profundo, espera su turno — pero
  **desacoplado**: el `dispatch` no lo espera, así la ejecución que lo emitió no retiene su lugar
  bajo el tope esperando a otra task (con tope 1, o dos tasks que se emiten entre sí, sería un
  deadlock). Sus errores van al log, no al que emitió.
- **`ExecutionRepository` es la costura para persistir.** `Execution` le anota cada transición
  (un `ExecutionRecord` serializable: la `Pause` como `PauseJSON`, el `Checkpoint`) y lo que se le
  entrega, vía `ExecutionJournal`. El repositorio es SÍNCRONO a propósito: el store ocupa la task en
  el mismo tick del `start`. `InMemoryExecutionStore` alcanza para un proceso;
  `@ia-flow/agent-engine-datasource-sqlite` guarda en SQLite. Al construirse, el `ExecutionStore` recupera lo
  que el repositorio dejó vivo: las pausadas vuelven a esperar, las que corrían con progreso
  guardado se retoman (ver arriba), las demás se cierran `failed` (`closeReason: interrupted`) y lo que no leyeron lo re-despacha el `Engine` al construirse
  (`takeOrphaned`). Un proceso por base: turnos y tope viven en memoria.
- **`ifRunning: 'interrupt'` corta al agente, no a la ejecución a lo bruto.** La regla que llega
  (ej. la tarjeta cambió de columna) le deja un aviso en el inbox (`Execution.interrupt` →
  `Inbox.notify`: se lee, pero no es un evento, no se re-despacha) y espera su turno como `wait`.
  El agente lo lee en su próxima vuelta y cede con `yield_turn` (`YieldTool`, que `TurnProtocol`
  sólo ofrece dentro de una ejecución y rechaza si nadie lo interrumpió) contando en qué quedó. Al
  volver, `StepRunner` NO corre sus salidas (su ruta movería la tarjeta y pisaría la del humano) ni
  `Pipeline` el resto de `do[]`: corre el `onInterrupt` de la cascada (paso > pipeline > agente >
  proyecto, como `onError`) con `steps.interruption` (`InterruptionReport`: `by`, `event`,
  `reason`, `agent`, `progress`), y la ejecución cierra `superseded` (`interrupted by <regla>`).
  Si el agente ignora el aviso y elige una salida igual, pasa lo mismo — con su `summary` como
  `progress`. Reglas no obvias:
  - **Sólo un agente EN SU LOOP se interrumpe.** Con una acción corriendo (la ruta que mueve la
    tarjeta) o entre pasos, no hay quién decida parar y cortar dejaría la salida a medias: la
    regla sólo espera. Así el eco de una ruta del mismo agente no lo corta.
  - **El eco de un webhook no trae `executionId`.** Si un agente mueve la tarjeta él mismo, el
    webhook vuelve como evento externo: `EngineOptions.selfOriginated` (ej. `sender` = el bot) lo
    marca como propio y no interrumpe. Mejor todavía: que los agentes no muevan status, que lo
    hagan sus rutas.
  - **Un evento que el agente acepta (`injects`) se inyecta, no interrumpe** — un comentario
    sigue llegando a la conversación aunque su regla diga `interrupt`.
  - **No hay corte duro.** Un provider sin loop (sin `inbox`) nunca lee el aviso: termina solo y
    recién ahí se aplica todo lo anterior. El agente se entera en su próxima vuelta, no antes.
  - **`interruptOn` elige qué eventos interrumpen.** Una pipeline que escucha varios (la de la
    columna Build: un cambio de status, la edición de otro campo, un desbloqueo) interrumpe sólo
    con los que pasan su `interruptOn` (`{ on, when }`); los demás esperan como `wait`. Sin él,
    todos interrumpen (`Pipeline.interrupts`).
  - **El texto es de la app.** `EngineOptions.interruptReason(event, pipeline)` dice qué pasó
    ("la tarjeta pasó a Review"); el aviso al modelo lo arma `interruptNotice`.
- **Una pipeline no se encola dos veces en la misma task: la nueva reemplaza a la que esperaba**
  (`ifQueued: 'replace'`, el default de `Pipeline`). La decisión de cada corrida se toma al llegar
  su evento, no al arrancar: sin esto, dos cambios de status seguidos mientras el agente trabaja
  corrían dos veces, la primera con un evento viejo. `ExecutionStore.start` marca reemplazada la
  corrida de la misma pipeline que todavía esperaba turno: cuando le toca, cede sin arrancar y
  `start` devuelve `undefined`; la nueva queda al final de la cola. La que ya corre (o está
  pausada) nunca se reemplaza — para eso están `ifRunning: 'interrupt'` e `ifPaused`. Sólo la
  MISMA pipeline: `review` y `rebuild` encoladas corren las dos.
  - **`keep` para las reglas donde cada evento cuenta** — típicamente los comentarios que el
    agente no inyecta: con `replace`, el segundo comentario borraría el primero. Ojo también con
    `Redelivery` (y el re-despacho tras un reinicio): lo inyectado sin leer vuelve a pasar por las
    reglas, y con `replace` dos comentarios re-despachados a la misma pipeline se colapsan.
  - **El default del store es `keep`**: `ExecutionStore.start` sin `ifQueued` encola como
    siempre; el que pide `replace` es el coordinador, con el de la pipeline.
- **Suites de contrato.** Un store o una fuente nueva prueba que sustituye a la de memoria con
  `executionStoreContract` / `pipelineSourceContract` (`@ia-flow/agent-engine/testing`).
- **El formato del mensaje inyectado es de la app** (`formatMessage`): el engine no sabe qué es un
  comentario o una review.

## Telemetría — con `@ia-flow/telemetry`

Los decorators y el logger viven en `@ia-flow/telemetry` (ver su CLAUDE.md); acá sólo se
declara qué deja este paquete en la traza. Todo lo que corre por causa de UN evento cuelga de
UNA traza: `Engine.dispatch` abre el span `event <type>` (raíz, o hijo si lo publicó un paso de
otra pipeline), `Pipeline.execute` abre `pipeline <id>` y `StepRunner.runDue` abre `agent <id>` /
`action <id>` por cada paso — los destinos de una salida cuelgan del agente que la eligió.
Reglas que no son obvias al leer el código:

- **La traza se declara sobre el método, no adentro.** `@traced`/`@tagged` sobre el método; qué
  se registra vive en `engine/tracing.ts` y `pipeline/tracing.ts` (con `scope: SCOPE`). Si algo
  que la traza necesita sólo se conoce adentro del método, se devuelve en su resultado (ej.
  `StepRun`: la salida elegida, o el error que cubrió un `onError`) en vez de tocar el span.
- **Cada clase que loguea tiene su campo `log`** (`readonly log = createLogger('agent-engine.engine')`
  en `Engine`, `DispatchPlanner`, `ExecutionCoordinator`, `RunLauncher` y `Redelivery`; el de
  `agent-engine.pipeline` en `Pipeline` y `StepRunner`). Los `onResult` de los `tracing.ts` loguean con `this.log`, y
  `@traced` lo usa para loguear solo un error que se escapa del método.
- **El scope del evento se hereda, no se repite.** El `inherit` de `dispatchTrace` pasa
  `event.scope` a atributos `ia.<clave>` (`ia.projectId`, `ia.repo`, `ia.issue`, …) que llegan a
  cada span y log de abajo, también en otros paquetes (el provider los recibe sin plumbing).
- **"No pasó nada" también deja traza.** Cada pipeline que escucha el tipo del evento deja un
  span event `pipeline.match` con `ia.pipeline.skip_reason` (`Pipeline.explainMismatch`), y un
  evento que no dispara nada igual abre su span.
- **Un error manejado igual se ve.** Un paso que falla y lo cubre un `onError` queda en ERROR con
  `ia.step.error_handled`; el `onError` corre como hijo con `ia.step.via: onError`.
- **Lo que pasó con un evento frente a una ejecución.** Si el paso activo lo aceptó, el despacho
  deja un span event `execution.inject` (`ia.execution.id`, `ia.agent.id`); si despertó una
  pausa, `execution.resume` (con `ia.pause.branch`). Una pausa que vence abre su propia traza
  `execution.expired`. `pipeline.match` se
  registra al planear, antes de mirar las ejecuciones: para las pipelines que pasan por ellas,
  `ExecutionCoordinator.resolveRunning` deja además un span event `pipeline.if_running` (`starts`, `waits`, `interrupts`, `injected`, `skipped`, `nested`)
  con la `ia.execution.id` con la que chocó (e `ia.agent.id` si se inyectó). `pipeline <id>`
  hereda `ia.execution.id` a toda la corrida y lleva `ia.execution.wait_ms`; el agente deja
  `inbox.delivered` cuando lee lo inyectado. Un inyectado sin leer se re-despacha en una traza
  NUEVA (`inFreshContext`) con un link al `event <type>` que lo inyectó y
  `ia.dispatch.redelivered_from` — no cuelga de la corrida que cerró.
- **Tests con el SDK en memoria** (`devDependencies`): `engine/tests/tracing.test.ts`.

## Antes de tocar código

```bash
bun run --filter @ia-flow/agent-engine typecheck
bun run --filter @ia-flow/agent-engine test
```

Los dos tienen que estar en verde antes de commitear (regla global del repo, ver
`~/.claude/CLAUDE.md` del usuario).
