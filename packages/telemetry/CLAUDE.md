# @ia-flow/telemetry

Trazas y logs para cualquier paquete del engine de ia-flow. No sabe nada de agentes ni pipelines: lo usan
`agent-engine`, `provider-anthropic` y cualquier otro paquete (los de `github/` no necesitan
arrastrar el engine para loguear).

## Qué es y qué NO es

Instrumentación **sólo contra las APIs** de OpenTelemetry (`@opentelemetry/api`,
`@opentelemetry/api-logs`), nunca contra un SDK: sin un SDK registrado por la app, cada span y
cada log a OTel es un no-op. La app decide si exporta, a dónde (OTLP → Collector, Grafana,
Datadog) y con qué sampling. Nunca sumes un SDK como dependencia runtime, ni I/O propio (red,
filesystem): un sink que escribe a un archivo o hace un POST lo arma la app.

**Este es el único paquete que importa `@opentelemetry/*` en runtime.** Re-exporta los tipos
que hacen falta para declarar una traza (`Attributes`, `Span`, `SpanKind`); los demás paquetes
tienen OTel sólo como `devDependency` para sus tests con el SDK en memoria.

## Estructura

```
src/
├── tracing.ts     @traced, @tagged, withSpan, atributos heredados (withInheritedAttributes)
├── logging.ts     createLogger, LogSink, setLogSinks/addLogSink, otelSink, consoleSink
├── traceRecord.ts TraceRecord + TraceJournal: la traza de una ejecución como datos planos
├── traceRecorder.ts  traceRecorder(journal): SpanProcessor + LogSink que anotan esa traza
├── index.ts
└── tests/         tracing.test.ts, logging.test.ts, traceRecorder.test.ts
```

## Reglas que no son obvias al leer el código

- **La traza se declara sobre el método.** `@traced(opciones)` corre el método en su propio span
  (nombre, `inherit`, `attributes`, `onResult`, `kind`, `scope`); `@tagged(opciones)` le suma al
  span activo sin abrir otro. Cada callback corre con `this` = la instancia. Por convención las
  opciones viven en un `tracing.ts` al lado del módulo instrumentado, no inline.
  `@taggedSync` es `@tagged` para un método sincrónico: uno que decide sin ceder el turno y que
  no puede volverse `async` sin abrir una carrera.
- **Una traza nueva, no un hijo, para lo que el span sólo dispara.** `inFreshContext(fn)` corre
  sin span activo ni atributos heredados (lo de adentro abre una traza propia), y el `links` de
  `@traced` cita de dónde vino con un `captureSpanLink()` tomado antes. Así un trabajo diferido no
  queda colgado —con los atributos equivocados— de un span que ya terminó.
- **Cada paquete pasa su `scope`** (instrumentation scope), no un `Tracer`. Nada se inyecta.
- **Atributos heredados, no baggage.** `withInheritedAttributes` / `inherit` guardan `ia.*` en el
  `Context` con una clave propia; cada span y log creado debajo los lleva, en cualquier paquete.
  El baggage se propagaría en los headers HTTP salientes (le mandaría el issue a terceros).
- **Logs compuestos, como en ia-flow pero sin `setLoggerFactory`.** Cada clase declara su
  logger como campo (`readonly log = createLogger('<scope>')`); la app elige los destinos una vez
  con `setLogSinks([consoleSink(), otelSink(), miSink])` o `addLogSink`. Los sinks se resuelven
  al EMITIR: un logger creado antes del boot igual los sigue, sin la cola de rebind de ia-flow.
  Default: sólo `otelSink()`, para que una librería no escriba nada sola. Un sink que tira se
  ignora sin afectar a los demás.
- **Un log se correlaciona por el contexto activo, no por quién lo creó.** Sale con el
  `traceId`/`spanId` y los atributos heredados del momento de emitir, así que un logger por clase
  en paquetes distintos arma igual una sola traza con todos los logs. La app tiene que registrar
  un context manager (el `NodeSDK` lo hace; los tests usan `AsyncLocalStorageContextManager`).
- **`@traced` loguea solo un error que se escapa**, si la instancia tiene un campo `log`: una sola
  vez aunque suba por varios métodos trazados (se loguea en el más profundo; un `WeakSet` marca
  los ya logueados — un throw de un primitivo no se puede marcar y se loguearía en cada nivel).
- **`traceRecorder` usa sólo los TIPOS del SDK** (`SpanProcessor`, `ReadableSpan`, con
  `import type`): por eso `@opentelemetry/sdk-trace-base` está en `dependencies`, pero no se carga
  en runtime. La app registra el `spanProcessor` en el SDK que eligió y suma el `logSink`. Anota
  sólo lo de una ejecución: un span con `ia.execution.id`, o hijo (misma traza) de uno que la
  tiene — un LRU spanId → ejecución acotado (20k) cubre los spans sin atributos heredados.
- **Decorators legacy** (`experimentalDecorators` en `tsconfig.base.json`), no los TC39: vitest 4
  transforma con oxc, que todavía no soporta los estándar.

## Antes de tocar código

```bash
bun run --filter @ia-flow/telemetry typecheck
bun run --filter @ia-flow/telemetry test
```

`agent-engine` y `provider-anthropic` importan el `src/` de este paquete (source-only, sin
`dist/`): un cambio de su API se ve al instante en ellos — corré también sus `typecheck`.
