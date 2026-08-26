# ADR: Logs con OpenTelemetry — transport, exporter y convivencia con los sinks actuales

**Estado:** aceptado · **Épic:** #64 · **Desbloquea:** #65 (server), #66 (gateway)

Este documento **decide**, no implementa. Cierra las 7 preguntas de diseño que #65 y #66
necesitan resueltas para instrumentar los dos loggers Pino del monorepo
(`apps/server/src/logger.ts` y `apps/ai-provider-gateway/src/logger.ts`) sin re-abrir la
discusión en cada implementación.

## Context

ia-flow corre hoy con dos loggers Pino independientes y ningún backend de observabilidad:
lo que hay son un archivo NDJSON por proceso, un `pino-pretty` a stdout, un broadcast WS
para el tab live-log de la UI, y —sólo en el server— un forward HTTP fire-and-forget a
otro daemon (`IA_FLOW_REMOTE_LOG_URL`). Eso alcanza para mirar un proceso; no alcanza para
correlacionar N daemons headless, contenedores de `apps/agent-runner` y gateways remotos
contra una misma tarea.

El épic #64 ya fijó cuatro decisiones que este ADR **hereda y no re-discute**:

1. OTel es un **sink adicional**, nunca reemplazo del archivo NDJSON local.
2. **Fail-open obligatorio**: un collector caído no puede degradar los otros sinks.
3. `service.instance.id` sale de `IA_FLOW_INSTANCE_ID`.
4. `ingestRemoteLogEntry` **no** re-exporta a OTel.

## Current state (verificado en el repo)

| Pieza | Dónde | Qué hace hoy |
| --- | --- | --- |
| Logger del server | `apps/server/src/logger.ts` | `pino.transport({ targets: [pino-pretty, pino/file] })` + wrapper por nivel en `createLogger` que agrega broadcast WS y `fetch(REMOTE_LOG_URL).catch(() => {})` |
| Logger del gateway | `apps/ai-provider-gateway/src/logger.ts` | `transport: { targets: [pretty, file?] }` — el file **degrada a null** si no se puede crear el directorio (`fileTarget()`), en vez de tumbar el proceso |
| Reader del archivo | `apps/server/src/routes/server-logs.ts:16-22` | re-deriva el path de `daemon.log` (comentario explícito: *"Mirror of the resolution done in apps/server/src/logger.ts"*) y lo parsea como NDJSON |
| Sink terminal | `apps/server/src/logger.ts` (`ingestRemoteLogEntry`) | bypassa `createLogger` a propósito, para que un entry ingerido no se re-forwardee y genere un loop A→B→A |
| Catálogo de env vars | `apps/server/src/routes/env-vars.ts` | `ENV_VAR_DEFINITIONS` tipado; `PUT /api/env-vars` **descarta** toda clave que no esté en el catálogo. `IA_FLOW_REMOTE_LOG_URL`, `IA_FLOW_REMOTE_LOG_TOKEN` e `IA_FLOW_INSTANCE_ID` **no** están → precedente: los sinks remotos se configuran por env de deploy |
| Versiones | ambos `package.json` | `pino ^10.3.1`, `pino-pretty ^13.1.3`; runtime **Bun 1.1.30** |

## Q1 — Transport: **bridge custom en el hilo principal** (NO `pino-opentelemetry-transport`)

**Decisión: bridge custom** con `@opentelemetry/api-logs` + `@opentelemetry/sdk-logs` +
`@opentelemetry/exporter-logs-otlp-http`, montado como un `Writable` dentro de
`pino.multistream`, corriendo en el hilo principal.

Esto contradice el criterio por defecto del plan ("si el transport oficial funciona, es
preferible"). La razón es empírica, no de gusto: **no funciona bajo Bun**, y falla del peor
modo posible.

### Verificación hecha (Bun 1.1.30, pino 10.3.1, pino-opentelemetry-transport 4.0.2)

Se levantó un receptor OTLP/HTTP local y se probaron tres configuraciones:

| Probe | Resultado |
| --- | --- |
| `pino.transport({ targets: [pino/file] })` (control) | ✅ el worker arranca y el archivo se escribe |
| `pino.transport({ target: 'pino-opentelemetry-transport' })` | ❌ **0 requests** al collector, y el proceso muere con `_flushSync took too long (10s)` desde `thread-stream/index.js:639` |
| `pino.transport({ targets: [pino/file, pino-opentelemetry-transport] })` | ❌ 0 requests **y el `pino/file` tampoco escribe nada** — el target OTel cuelga el worker y se lleva puesto al archivo |

Importar el módulo del transport directamente en el hilo principal sí construye el stream
(`BUILD_OK`), así que el problema no es el paquete en sí: es el **camino
`worker_threads` de Bun** para ese transport en particular (el `pino/file` del control
prueba que `worker_threads` en general sí anda).

La tercera fila es la que cierra la discusión: el transport oficial **viola la restricción
no negociable de #64 y de Q5**. No es que "no exporte a OTel" — es que se lleva puesto el
`daemon.log`, que es exactamente la fuente que `routes/server-logs.ts` lee para la UI. Un
sink opcional que puede matar al sink obligatorio no es una opción, funcione o no el
export.

### Verificación del bridge custom (mismo entorno)

El mismo probe con el bridge en el hilo principal:

- ✅ el collector recibe el batch: `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name",...`
- ✅ el `pino/file` sigue escribiendo sus dos líneas NDJSON en el mismo run
- ✅ con el collector apuntado a un puerto muerto (`127.0.0.1:9`): el archivo se escribe
  igual, no hay `unhandledRejection`, el proceso sobrevive (ver Q5)

**Costo del árbol de deps** (medido con `bun add` en un proyecto limpio):

| Ruta | Paquetes | Tamaño en disco |
| --- | --- | --- |
| Bridge custom (`api-logs` + `sdk-logs` + `exporter-logs-otlp-http` + `resources`) | 11 | 28 MB |
| `pino-opentelemetry-transport` (arrastra los exporters gRPC y proto además del HTTP) | 64 | 75 MB |

El bridge además sale **más barato en deps**, porque no arrastra
`exporter-logs-otlp-grpc`/`-proto` ni `sdk-trace`/`sdk-metrics` por transitividad del
transport.

### Cuándo revisar esta decisión

Cuando Bun cierre el gap de `worker_threads` para este transport. La forma de re-evaluar es
re-correr las tres filas de la tabla de arriba: si la tercera pasa (archivo + collector,
ambos), migrar al transport oficial es un cambio local a `logger.ts` que no toca ningún
consumidor.

### Trampa de la API (costó descubrirla, queda escrita)

En `@opentelemetry/sdk-logs` 0.221 los processors toman un **objeto de opciones**, no el
exporter posicional:

```ts
new BatchLogRecordProcessor({ exporter })   // ✅
new BatchLogRecordProcessor(exporter)       // ❌ falla en runtime con
                                            //    "undefined is not an object (evaluating 'exporter.export')"
```

El error aparece recién al emitir el primer record, y sólo si hay un `diag` logger seteado
— sin `diag` se traga silenciosamente y el síntoma es "no llegan logs". Quien implemente
#65/#66 debe usar la forma de objeto.

## Q2 — Exporter: **OTLP/HTTP** (`@opentelemetry/exporter-logs-otlp-http`)

**Decisión: HTTP/protobuf-JSON al puerto `4318`.** Es el default que expone
`otel/opentelemetry-collector`, no requiere bundlear certs ni el stack de gRPC, atraviesa
proxies y load balancers HTTP sin config extra, y es lo único verificado funcionando bajo
Bun en la sección anterior. gRPC sumaría `@grpc/grpc-js` + `protobufjs` al árbol para un
volumen de logs que no lo justifica (un daemon de orquestación, no un pipeline de
telemetría de alto throughput).

Si en el futuro el volumen lo pide, el cambio es sustituir la clase del exporter — el
bridge no conoce el wire format.

## Q3 — Resource attributes

Cuatro atributos, con su fuente exacta:

| Atributo | Valor | Fuente |
| --- | --- | --- |
| `service.name` | `ia-flow-server` / `ia-flow-gateway` | **constante por app**, hardcodeada en cada `logger.ts`. `OTEL_SERVICE_NAME` puede sobreescribirla (ver Q6), pero el default nunca es vacío |
| `service.instance.id` | `IA_FLOW_INSTANCE_ID` trimmeado, o `String(process.pid)` si queda vacío | mismo criterio que `logger.ts:31` (`Bun.env.IA_FLOW_INSTANCE_ID?.trim() \|\| undefined`), con el `pid` como fallback en vez de `undefined` — un log sin instancia no se puede desambiguar en el collector |
| `service.version` | `version` del `package.json` del app respectivo (hoy `1.0.0` en ambos) | import estático del JSON |
| `deployment.environment.name` | `OTEL_DEPLOYMENT_ENVIRONMENT`, default `development` | env var estándar; el nombre del atributo es el semconv actual (`deployment.environment` está deprecado a favor de `deployment.environment.name`) |

`OTEL_RESOURCE_ATTRIBUTES` sigue funcionando como mecanismo estándar para agregar atributos
propios del deploy (`k8s.pod.name`, etc.) sin tocar código — el SDK los mergea.

**Nota sobre `IA_FLOW_INSTANCE_ID`:** hoy además se estampa como `extras.source` en cada
línea que sale por WS o por el forward remoto. Eso **se queda**: `extras.source` es lo que
lee la UI; `service.instance.id` es lo que lee el collector. Son dos consumidores distintos
de la misma fuente, no una duplicación a resolver.

## Q4 — Convivencia: OTel **suma**, no reemplaza

**Decisión: OTel es un quinto sink. Nada se va.**

| Sink | Estado | Por qué |
| --- | --- | --- |
| `pino-pretty` a stdout | **se queda** | es cómo se debuggea en dev, y en el gateway es lo único que ve Electron |
| Archivo NDJSON (`daemon.log` / `gateway.log`) | **se queda — no negociable** | `routes/server-logs.ts` lo lee para `GET /api/server-logs`; reemplazarlo rompe el tab de logs de la UI. La duplicación de `resolveLogFile` entre writer y reader existe precisamente porque el archivo es contrato entre los dos |
| Broadcast WS | **se queda** | alimenta el live-log de la UI en tiempo real; OTel no tiene un camino de vuelta al browser |
| `IA_FLOW_REMOTE_LOG_URL` | **se queda** | ver abajo |
| OTel OTLP | **nuevo** | opt-in por env, apagado si no hay endpoint |

**Sobre `IA_FLOW_REMOTE_LOG_URL`:** la tentación es reemplazarlo con OTel, porque
"consolidar logs de N procesos" es literalmente para lo que sirve un collector. No se hace,
por dos razones concretas:

1. El forward remoto no es sólo transporte — **alimenta la UI del daemon principal**. Un
   entry forwardeado entra por `ingestRemoteLogEntry`, cae en el `daemon.log` del receptor y
   sale por su WS. Un collector OTLP no le devuelve nada a `apps/web`.
2. `apps/agent-runner` (Docker/Podman) consolida hoy por ese camino. Sacarlo obligaría a
   levantar un collector como dependencia dura del runner para no perder visibilidad — un
   requisito de infra nuevo a cambio de nada.

Los dos caminos conviven sin pisarse: el forward remoto es **operador → operador** (logs que
un humano mira en la UI de ia-flow) y OTel es **proceso → backend** (logs que se agregan,
retienen y buscan). Si en algún momento la UI se apoya en el backend OTel, ahí se re-evalúa
sacar el forward — es un cambio de #64, no de este ADR.

## Q5 — Fail-open

**Regla: ningún error del camino OTel puede llegar al caller de `log.info(...)`, ni degradar
otro sink.** Es la misma garantía que hoy da `fetch(REMOTE_LOG_URL, ...).catch(() => {})`
(`apps/server/src/logger.ts:141-148`), extendida a tres puntos:

1. **Construcción.** Armar el `LoggerProvider` va dentro de un `try/catch` que devuelve
   `null`. Un endpoint mal formado, un paquete que no resuelve, un `OTEL_RESOURCE_ATTRIBUTES`
   corrupto → se loguea un `warn` una vez y se sigue sin el sink. Es exactamente el patrón
   que ya usa `fileTarget()` en el gateway: *"el archivo es un extra, no un requisito"*.
2. **Emisión.** El `write` del `Writable` envuelve el `JSON.parse` + `emit` en `try/catch`
   vacío y **siempre** llama a `cb()`. Un `cb()` que no se llama frena el stream y, por
   `multistream`, puede frenar el logging entero.
3. **Export.** El `BatchLogRecordProcessor` ya es asíncrono y desacoplado del `emit`; sus
   fallos van al `globalErrorHandler` de OTel, nunca al caller. **Verificado**: con el
   collector en un puerto muerto, el archivo se escribió igual, no hubo
   `unhandledRejection`, el proceso sobrevivió. Se debe además registrar un
   `globalErrorHandler` propio que degrade a un `debug` — el default escribe a stderr y
   ensucia el `pino-pretty` cada `scheduledDelayMillis`.

**Timeouts/reintentos:** el exporter OTLP trae su propio timeout y backoff, ambos fuera del
camino síncrono del log. No agregar retry propio encima.

**`ingestRemoteLogEntry` no exporta a OTel — nunca.** La prohibición que hoy evita el loop
A→B→A con `IA_FLOW_REMOTE_LOG_URL` se extiende igual: dos daemons apuntados al mismo
collector, uno forwardeando al otro, duplicarían cada línea (el emisor la exporta, el
receptor la re-exporta con su propio `service.instance.id`). Es la decisión 4 del épic #64
y este ADR **no la re-abre**. Esta sección es la única postura del doc sobre el tema.

**Cómo se sostiene: con una marca, no «por construcción».** Hoy la ingesta es terminal
porque usa `logger.child()` crudo y así se saltea el wrapper de `createLogger`, que es el
único que llama a `fetch(REMOTE_LOG_URL)`. **Ese argumento no alcanza para OTel**: el sink
que elige Q1 cuelga del **stream raíz** de Pino vía `pino.multistream`, no del wrapper, así
que el `logger.child({ module })` de `ingestChild` (`apps/server/src/logger.ts:186`) **sí**
lo atraviesa. Hace falta un mecanismo explícito, y es esto:

- `ingestChild` pasa a bindear una marca: `logger.child({ module, ingested: true })`.
- El `write` del `Writable` de OTel descarta el record cuando `ingested === true`, antes de
  construir nada (está en el snippet, más abajo).
- El archivo NDJSON y el broadcast WS **siguen recibiéndolo**: la entrada ingerida se ve en
  la UI del receptor igual que hoy. Lo único que se corta es la re-exportación. (El campo
  `ingested` queda visible en el NDJSON; es deseable — distingue lo propio de lo forwardeado
  sin depender de `extras.source`.)

La ventaja sobre «por construcción» es que ahora es **verificable**: un test que ingiera
una entrada y compruebe que el sink OTel no la vio. #65 tiene que cubrirlo — es el punto 6
de Verification.

## Q6 — Env vars

Nombres estándar de OTel siempre que exista uno. Nada de `IA_FLOW_OTEL_*`: los nombres
canónicos hacen que un operator de Kubernetes, un `docker-compose` de ejemplo o un sidecar
de collector funcionen sin traducción.

| Env var | Default | ¿Editable desde la UI? | Group / kind |
| --- | --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(vacío = sink apagado)* | **sí** | `server` / `text` |
| `OTEL_EXPORTER_OTLP_HEADERS` | vacío | **sí** | `server` / `password` (`secret: true`) |
| `OTEL_SDK_DISABLED` | `false` | **sí** | `server` / `select` (`['false','true']`) |
| `OTEL_SERVICE_NAME` | constante por app (Q3) | no | env de deploy |
| `OTEL_RESOURCE_ATTRIBUTES` | vacío | no | env de deploy |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | `development` | no | env de deploy |
| `OTEL_LOG_LEVEL` | sigue a `LOG_LEVEL` | no | env de deploy |

**Las tres editables** son las que un operador quiere cambiar sin reconstruir el container:
mover el collector, rotar el token del backend, y apagar el sink cuando el collector está
generando ruido. `OTEL_SDK_DISABLED` es el kill switch — vale la pena que esté a un click y
no a un redeploy.

**Las cuatro no editables** siguen el precedente de `IA_FLOW_REMOTE_LOG_URL` /
`IA_FLOW_INSTANCE_ID`: son identidad del deploy, no configuración de runtime. Cambiar
`OTEL_SERVICE_NAME` desde la UI partiría las series históricas del backend sin que nadie lo
note.

Tres advertencias para quien implemente:

- **Estar en `ENV_VAR_DEFINITIONS` es obligatorio para que la UI las persista**:
  `PUT /api/env-vars` (`env-vars.ts:180`) descarta toda clave fuera del catálogo. "Editable
  desde la UI" ≠ "leída por el proceso" — hacen falta las dos cosas.
- **Todas van al group `server`**, junto a `LOG_LEVEL`. No crear un group `otel` para tres
  entradas.
- **Cambiar una env var editable no reinicia nada.** Sólo las claves de `DAEMON_KEYS`
  disparan `reloadManagers()`. Un cambio de endpoint OTel toma efecto **al reiniciar el
  proceso** — decirlo en el `description` de cada definición, o el operador va a pensar que
  no funciona. Hacer que el provider se reconstruya en caliente es un follow-up, no parte de
  #65.
- **El gateway no tiene UI de env vars.** Sus tres vars se setean por env del proceso; el
  catálogo es cosa del server (ver la nota del gateway abajo).

## Q7 — Alcance: **logs-only**

**Decisión: este épic instrumenta logs y nada más.** Sin traces, sin métricas, sin
auto-instrumentation HTTP/fetch, sin correlación `trace_id`/`span_id` en los log records.

Por qué: los tres sinks actuales ya cubren "qué pasó en un proceso" y lo que falta es
agregarlos en un backend. Los traces responden otra pregunta ("dónde se fue el tiempo") y
traen decisiones que no están tomadas (dónde se abre el span: ¿por request Hono, por
dispatch de agente, por llamada upstream a Anthropic/GitHub?) más un árbol de deps varias
veces mayor. Mezclarlos con este épic bloquea a #65/#66 esperando un debate que no les
importa.

**El bridge no cierra la puerta:** el `LogRecord` de OTel lleva `traceId`/`spanId` como
campos de primera clase, y el SDK los rellena solo desde el contexto activo. El día que
haya spans, la correlación aparece sin tocar el bridge.

Follow-ups a abrir en el épic #64 (nombres sugeridos):

- **`[OTel] Traces: auto-instrumentation HTTP/fetch en server y gateway`** — decidir el
  middleware (`@opentelemetry/instrumentation-http` vs `-fetch` vs uno de Hono) y dónde se
  abre el span raíz.
- **`[OTel] Correlación trace_id/span_id en los log records`** — depende del anterior.
- **`[OTel] Métricas: runs en vuelo, duración de dispatch, ocupación de capacidad`** — los
  números que hoy sólo viven en `capacity.ts` y en el registry de pending tasks.
- **`[OTel] Recargar el sink OTLP sin reiniciar el proceso`** — la limitación anotada en Q6.

## Snippet ilustrativo (para #65)

Lo que sigue es la forma verificada bajo Bun 1.1.30. `pino.multistream` es lo que permite
que el sink OTel corra en el hilo principal mientras `pretty` y `file` siguen en su worker
— no se puede meter el bridge como un `target` de `pino.transport` (los targets siempre
corren en el worker, que es justo el camino que Q1 descarta).

```ts
// apps/server/src/logger.ts — sink OTel (nuevo)
import { Writable } from 'node:stream'
import { SeverityNumber, logs } from '@opentelemetry/api-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { version as SERVICE_VERSION } from '../package.json'

const SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE, 20: SeverityNumber.DEBUG, 30: SeverityNumber.INFO,
  40: SeverityNumber.WARN, 50: SeverityNumber.ERROR, 60: SeverityNumber.FATAL,
}

/** null = sink apagado (sin endpoint, o algo falló al construirlo). Fail-open — ver Q5. */
function otelStream(): Writable | null {
  if (!Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT || Bun.env.OTEL_SDK_DISABLED === 'true') return null
  try {
    const provider = new LoggerProvider({
      resource: resourceFromAttributes({
        'service.name': Bun.env.OTEL_SERVICE_NAME?.trim() || 'ia-flow-server',
        'service.instance.id': INSTANCE_ID ?? String(process.pid), // logger.ts:31 + fallback
        'service.version': SERVICE_VERSION,
        'deployment.environment.name': Bun.env.OTEL_DEPLOYMENT_ENVIRONMENT?.trim() || 'development',
      }),
      // OJO: opciones como objeto — `new BatchLogRecordProcessor(exporter)` falla en runtime.
      processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    })
    logs.setGlobalLoggerProvider(provider)
    const otel = logs.getLogger('ia-flow-server')
    return new Writable({
      write(chunk, _enc, cb) {
        try {
          const { level, time, msg, ingested, ...attributes } = JSON.parse(String(chunk))
          // Q5: lo ingerido de otro daemon va al archivo y al WS, nunca de vuelta a OTel.
          if (!ingested) {
            otel.emit({ severityNumber: SEVERITY[level] ?? SeverityNumber.INFO, body: msg, attributes })
          }
        } catch {
          // Un record ilegible no puede frenar el stream — cb() se llama igual.
        }
        cb()
      },
    })
  } catch {
    return null // endpoint inválido, paquete ausente: se sigue sin OTel.
  }
}

const otel = otelStream()
const logger = pino(
  { level: LOG_LEVEL, timestamp: pino.stdTimeFunctions.isoTime, base: { pid: process.pid }, serializers: { /* … */ } },
  pino.multistream([
    { level: LOG_LEVEL, stream: pino.transport({ targets: [/* pino-pretty y pino/file, tal cual hoy */] }) },
    ...(otel ? [{ level: LOG_LEVEL, stream: otel }] : []),
  ]),
)
```

El wrapper por nivel de `createLogger` (broadcast WS + forward remoto) **no se toca**: el
sink OTel se alimenta del stream de Pino, no del wrapper, así que ve exactamente las mismas
líneas que el archivo — **con la única excepción de Q5**. `ingestRemoteLogEntry` escribe por
`logger.child()` crudo, que también cuelga del stream raíz y por lo tanto pasaría por acá;
es el `ingested: true` que bindea `ingestChild` lo que el `write` filtra para que no se
re-exporte. Sin esa marca la prohibición de Q5 simplemente **no existe** con este transport:
no la da el diseño, la da esa línea. Es el único lugar del ADR donde el sink OTel ve menos
que el `daemon.log`, y es deliberado.

## Aplicabilidad al gateway (para #66)

El mismo patrón, con tres diferencias:

- `service.name` = **`ia-flow-gateway`**, `service.version` del `package.json` del gateway.
- El gateway ya usa `transport: { targets: [...] }` en las opciones de `pino()` en vez de un
  segundo argumento. Para sumar el stream OTel hay que pasar a la forma de dos argumentos
  (`pino(opts, pino.multistream([...]))`) — mismo cambio mecánico que en el server.
- **No hay UI de env vars.** Las tres vars editables de Q6 se setean por env del proceso;
  `ENV_VAR_DEFINITIONS` es del server y el gateway no lo lee.

La filosofía de degradación ya está escrita en su `fileTarget()` (*"el archivo es un extra,
no un requisito"*): el sink OTel se construye igual — si falla, devuelve `null` y el gateway
arranca sin él. Que se apague la observabilidad es mejor que quedarse sin gateway.

## Verification

Lo que #65 y #66 tienen que poder demostrar:

1. Con `OTEL_EXPORTER_OTLP_ENDPOINT` apuntando a un receptor local, una línea de log llega
   como `resourceLogs` con los cuatro resource attributes de Q3 — **y** el `daemon.log` /
   `gateway.log` tiene esa misma línea.
2. Con el endpoint apuntando a un puerto muerto: el archivo se escribe igual, no hay
   `unhandledRejection`, el proceso no muere. (Es el probe de Q5, reproducible.)
3. Sin `OTEL_EXPORTER_OTLP_ENDPOINT`, o con `OTEL_SDK_DISABLED=true`: `otelStream()`
   devuelve `null` — **ningún `LoggerProvider` construido y ningún request al collector**,
   comportamiento idéntico al de hoy. Ojo con el matiz: los imports del snippet son
   estáticos, así que los módulos de OTel **se cargan igual**, apagado o no; lo que no
   ocurre es que se inicialice nada. Si #65 quiere además que no se carguen (arranque más
   liviano, árbol de deps fuera del path caliente), tiene que mover esos cuatro imports a
   un `await import()` diferido dentro del `try`, lo que obliga a construir el logger de
   forma asíncrona. **Este ADR no lo exige** — queda a criterio de #65.
4. `GET /api/server-logs` sigue devolviendo las mismas entradas que antes del cambio — el
   reader de `routes/server-logs.ts` no se entera de que existe OTel.
5. `GET /api/env-vars` lista las tres vars editables de Q6 en el group `server`, y un
   `PUT` con ellas persiste (prueba de que están en `ENV_VAR_DEFINITIONS`).
6. Una entrada que entra por `POST /api/remote-logs` aparece en el `daemon.log` del
   receptor y en su broadcast WS, y **no** llega al collector — la marca `ingested` de Q5
   la filtra en el `write` del sink.
