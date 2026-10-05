# @ia-flow/agent-engine-definitions

El modelo de definiciones de `@ia-flow/agent-engine` —una fuente, sus agentes y sus pipelines— y
cómo se arman las entidades, venga de donde venga la definición. Los datasources
(`datasources/yaml`, mañana SQLite o Postgres) sólo producen `SourceDocs`; este paquete los valida
(sus schemas), los arma (`SourceBuilder`) y los sirve al engine en vivo (`DefinitionPipelineSource`).

No sabe de proyectos ni de cómo se compone un engine: eso es de la app. Una pipeline filtra por
`scope` (propiedad de la definición, como `on` o `when`); quién la pone es asunto de quien la define
o la monta.

## Qué es este paquete

- **`DefinitionSource`** — lo que implementa un datasource: `read()` (sus `SourceDocs`) y
  `version()` (cambia cuando cambió algo).
- **`DefinitionPipelineSource`** — un `PipelineSource` sobre un `DefinitionSource`: en cada evento
  mira la versión y, si cambió, vuelve a leer y armar. Una versión inválida se loguea y sigue la
  última buena; la primera carga tira.
- **`SourceBuilder`** — documentos → `StaticPipelineSource` (agentes compartidos, pipelines,
  defaults, refs). Cada paso lo arma su `StepFactory`.

## Estructura

```
src/
├── DefinitionSource.ts      el contrato de un datasource + la fuente en vivo
├── SourceBuilder.ts         documentos → StaticPipelineSource
├── schema.ts                la forma de cada definición (zod): source, agent, pipeline, pasos
├── StepFactory.ts           el contrato de un tipo de paso (keyword + schema + create)
├── StepFactoryRegistry.ts   qué factory arma cada nodo (la primera clave registrada)
├── factories/               una por tipo incluido: agent, action, emit, http, pause, parallel, function
├── Catalogs.ts              lo que una definición nombra y la app registra en código
├── located.ts               anteponer dónde (archivo, fila…) y ruta a un error
└── tests/                   con un datasource en memoria (`tests/memory.ts`)
```

Los pasos que corren (`HttpStep`, `EmitStep`, `ActionStep`) y las plantillas (`render`,
`substituteVars`) son del core.

## Reglas que no son obvias

- **El YAML nunca trae funciones.** Acciones, funciones, tools, schemas de input, mappers de
  `onError` (`input`/`report` a partir del error), providers y system prompts se nombran en el YAML
  y se registran en `YamlCatalogs`.
- **`onInterrupt` no tiene mappers: sus pasos leen `steps.interruption` con plantillas.** Lo que
  corre si interrumpen al agente (`ifRunning: interrupt` de la regla que llega) va en cualquier
  nivel de defaults (`source.yaml`, agente, pipeline, `routes.<agentId>`) como `{ to }`; ej. un
  comentario con `{{steps.interruption.reason}}` y `{{steps.interruption.progress}}`.
- **Una acción que depende de dónde se usa es un `ActionProvider`** en `catalogs.actions`: una
  función que recibe `{ sourceId, agentId?, options }` (las `options` de la entrada del YAML) y
  arma la acción — un board por fuente, un comentario con el nombre del agente, una shell con
  sus comandos permitidos. Como tool de un agente puede armar varias; como paso, una sola.
- **`allowWrites: true` en un agente** habilita todas sus acciones aunque escriban: listarlas ya
  es la decisión del operador. Sin eso, cada una que escribe lleva `allowWrite: true`.
- **Un paso de agente con `brief` o `when`** es una instancia propia de ese paso (el `brief` se
  antepone al prompt). Sin ellos, el agente es uno por fuente, compartido.
- **`systemPrompts` de la fuente** van antes de los de cada agente: el prefijo compartido.
- **MCP por id** salen de `catalogs.mcpServers`; un id que no está se omite con un aviso (un
  servidor que no respondió al arrancar) y el agente corre sin él.
- **Un tipo de paso nuevo es una `StepFactory`** en `catalogs.steps`: no se toca el loader.
- **`{ ref: <id> }`** reusa un paso declarado ANTES en el `do` de la misma pipeline (ej. como
  destino de una ruta). Un agente (`{ agent: <id> }`) es uno por fuente, compartido.
- **Dos momentos de plantilla.** `{{vars.x}}` se sustituye AL CARGAR en cualquier archivo (también
  en un `when`, que no se resuelve al correr); una var que no existe rompe la carga. Las vars salen
  de `source.yaml` sobre `catalogs.sourceVars(sourceId)`. El resto de los `{{...}}` de `http`,
  `emit` y `function.with` se resuelven AL CORRER contra el payload (en la raíz, como un `when`) y
  `steps` — y `item` dentro de un `forEach`. Un valor que es SÓLO `{{x}}` conserva su tipo.
- **Un paso `http` con `connection`** va al host de esa conexión (`catalogs.connections`) con su
  credencial; el path tiene que empezar con `/` y no puede cambiar el host. Cada valor que una
  plantilla inserta en el path va con `encodeURIComponent` (no agrega segmentos ni una query) y un
  `.`/`..` se rechaza: lo que trae un webhook no lleva el token a otro endpoint. Un path que es
  entero una plantilla (`http: '{{path}}'`) no carga: el endpoint lo escribe el YAML. La query va en
  `query:`; un path con `?`/`#` falla.
  Sin `connection`, `http` es una URL cuyo host escribe la definición: las `{{...}}` sólo van después
  de él (una antes no carga), cada valor se inserta con `encodeURIComponent` y el origin se verifica
  al correr — un valor del evento no puede mandar los `headers` a otro host. `graphql` hace el POST y lee `data`
  (con `errors`, falla); `select` es el dot path de lo que queda como output.
- **Una acción con `with` en plantilla** (`{ action: x, with: { n: '{{issue.number}}' } }`) se
  resuelve en cada corrida y la acción la valida como cualquier input (`ActionStep`); un `with`
  fijo sigue siendo `Action.bind`, validado al cargar.
- **Una función de catálogo con `with`** recibe esos valores como input: así es pura y sirve en
  cualquier pipeline. Sin `with`, recibe `(ctx, undefined)`.
- **`firstMatch: true`** en una pipeline: sus pasos son alternativas (ej. un agente por columna o
  repo), corre el primero cuyo `when` pasa. Es lo que permite una pipeline por momento del flujo
  en vez de una por variante.
- **`parallel`** (`ParallelStepFactory`): `{ parallel: [pasos], id, until: { all|any: salida o
  [salidas] }, advisory?: [ids], routes: { passed?: { to, report? }, failed?: { to, report? } },
  report? }`. El `id` es obligatorio. `advisory` nombra miembros consultivos: reportan pero no
  votan ni hacen fallar al grupo. Su `onError`/`onInterrupt` son los de la cascada (pipeline > proyecto) — el YAML del
  grupo no los declara. Ver "grupo `parallel`" en el CLAUDE.md del core.
- **`maxRuns`** en una pipeline: `{ max, counter?, counts?: [{ on, when }], resetOn?: [{ on, when }],
  window?: 24h, onExhausted: [pasos] }`. Los filtros se arman como `interruptOn`; `onExhausted`, como
  cualquier paso (acciones: un agente no carga). Ver `maxRuns` en el CLAUDE.md del core.
- **`whenText`** (pipeline, paso, agente): un modelo decide si el evento cumple un criterio,
  después del `when`. `whenText: <texto>` o `{ text, systemPrompts }`; cada system prompt
  por id (uno del `source.yaml` con ese `id`, o de `catalogs.systemPrompts`) o inline
  (`{ text }`), resueltos AL CARGAR — un id que no existe rompe la carga. El de un paso de agente
  gana sobre el del agente. Quién decide es la capacidad `whenText` del `Engine` (el
  modelo es el de ese agente, no del criterio); sin nadie que la cumpla, o sin veredicto, lo que
  tiene `whenText` no corre.
- **`capabilities:` de la fuente** (`{ whenText: { agent: text-classifier } }`): quién cumple cada
  capacidad del engine, armado como cualquier paso. `DefinitionPipelineSource.capabilities` las
  sirve en vivo; qué fuente las enchufa en el `Engine` lo decide la app.
- **`scope` en una pipeline** filtra por `event.scope` (cada clave, exacta). Es una propiedad más:
  una app que agrupa fuentes (ej. un proyecto) la pone en la definición antes de armarla.
- **Los errores dicen dónde**: `<dónde>: <ruta del campo>: <qué>` (`located`); el `path` de cada
  documento lo pone el datasource (un archivo, una fila).
- **Una pausa sobrevive a una recarga** si la pipeline no cambió de forma: el `Checkpoint` compara
  `shape` y falla en vez de seguir en otro paso.

## Antes de commitear

```bash
bun run --filter @ia-flow/agent-engine-definitions typecheck
bun run --filter @ia-flow/agent-engine-definitions test
```
