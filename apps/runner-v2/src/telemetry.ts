/**
 * El SDK de OpenTelemetry del runner. Los paquetes (`agent-engine`, los providers) instrumentan
 * sólo contra la API; es la APP la que decide a dónde va. Una sola emisión, dos destinos:
 *
 *   - SIEMPRE, la base de actividad (`traceRecorder` → SQLite): cada span y log de una ejecución,
 *     en el momento — lo que leen la bandeja y el asistente.
 *   - Con `OTEL_EXPORTER_OTLP_ENDPOINT`, además OTLP/HTTP (el Grafana LGTM de `otel/` en local, o
 *     un Collector/Datadog Agent), en lotes de 1 s.
 *
 * Un host (`--host`) no tiene backend propio: sin `OTEL_EXPORTER_OTLP_ENDPOINT`, su SDK exporta
 * OTLP/HTTP JSON estándar AL RUNNER (`/v1/hosts/telemetry/*`, con el token de hosts), que lo guarda
 * en su base y lo reexporta a su collector (`hostTelemetry.ts`). Lo suyo sale con
 * `service.instance.id` e `ia.origin` = su nombre.
 *
 * `LOG_LEVEL` (`debug` | `info` | `warn` | `error`, default `info`; `settings.telemetry.logLevel` de
 * `runner.yaml` la llena si el env no la trae) fija el nivel mínimo de los dos.
 * En `debug` los providers además vuelcan cada request y respuesta de su API, con las credenciales
 * tapadas.
 */
import {
  addLogSink,
  createLogger,
  parseLogLevel,
  setLogLevel,
  type TraceJournal,
  traceRecorder,
} from '@ia-flow/telemetry'
import { OTLPLogExporter as JsonLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { OTLPTraceExporter as JsonTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'

const LOG_LEVEL_VAR = 'LOG_LEVEL'

/** Cada cuánto sale un lote a OTLP: casi en vivo, sin un request por span. */
const EXPORT_DELAY_MS = 1_000

export interface Telemetry {
  /** El trace id de cada evento despachado (spans raíz `event <type>`), en orden. */
  traceIds: string[]
  endpoint?: string
  /** Exporta lo pendiente y apaga el SDK — sin esto, una CLI que termina pierde el último batch. */
  shutdown(): Promise<void>
}

/** Anota el trace id de cada span raíz `event …`: lo que el runner imprime para ir a la traza. */
class RootTraceRecorder implements SpanProcessor {
  constructor(private readonly traceIds: string[]) {}
  onStart(span: Span): void {
    if (!span.parentSpanContext && span.name.startsWith('event ')) {
      this.traceIds.push(span.spanContext().traceId)
    }
  }
  onEnd(_span: ReadableSpan): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/** A dónde van los registros de cada ejecución: la base (`--serve`). Se decide después de arrancar
 *  la telemetría, al elegir el modo. En `--host` no va a ningún lado: lo del host le llega al
 *  runner por OTLP (ver arriba) y es el runner el que lo anota. */
export class TraceRoute implements TraceJournal {
  private target?: TraceJournal

  to(target: TraceJournal): void {
    this.target = target
  }

  write(record: Parameters<TraceJournal['write']>[0]): void {
    this.target?.write(record)
  }
}

/** Un host: a qué runner le manda su telemetría y con qué nombre. */
export interface HostTelemetryTarget {
  name: string
  runner: string
  token: string
}

/** Los exporters: al collector (`OTEL_EXPORTER_OTLP_ENDPOINT`, protobuf), o —un host sin
 *  collector— al runner, en JSON (lo único que el runner acepta). */
function exporters(endpoint: string | undefined, host: HostTelemetryTarget | undefined) {
  if (endpoint) return { traces: new OTLPTraceExporter(), logs: new OTLPLogExporter() }
  if (!host) return undefined
  const base = `${host.runner.replace(/\/+$/, '')}/v1/hosts/telemetry`
  const headers = { authorization: `Bearer ${host.token}` }
  return {
    traces: new JsonTraceExporter({ url: `${base}/traces`, headers }),
    logs: new JsonLogExporter({ url: `${base}/logs`, headers }),
  }
}

export function startTelemetry(
  serviceVersion: string,
  route: TraceRoute,
  host?: HostTelemetryTarget,
): Telemetry {
  const traceIds: string[] = []
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const recorder = traceRecorder(route, host ? { origin: host.name } : {})
  addLogSink(recorder.logSink)
  const exporting = exporters(endpoint, host)

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'ai-development-flow-runner',
      'service.version': serviceVersion,
      'deployment.environment.name': process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? 'local',
      ...(host ? { 'service.instance.id': host.name, 'ia.origin': host.name } : {}),
    }),
    spanProcessors: [
      new RootTraceRecorder(traceIds),
      recorder.spanProcessor,
      ...(exporting
        ? [new BatchSpanProcessor(exporting.traces, { scheduledDelayMillis: EXPORT_DELAY_MS })]
        : []),
    ],
    logRecordProcessors: exporting
      ? [
          new BatchLogRecordProcessor({
            exporter: exporting.logs,
            scheduledDelayMillis: EXPORT_DELAY_MS,
          }),
        ]
      : [],
    // Sin auto-instrumentación (http/undici): los spans que importan los emite el engine, y un
    // span por cada GET a GitHub taparía el árbol.
    instrumentations: [],
  })
  sdk.start()
  applyLogLevel(process.env[LOG_LEVEL_VAR])
  return {
    traceIds,
    ...(endpoint ? { endpoint } : {}),
    shutdown: () => sdk.shutdown(),
  }
}

/** Un `LOG_LEVEL` que no es un nivel no tumba el arranque: se avisa y queda `info`. */
function applyLogLevel(raw: string | undefined): void {
  if (raw === undefined || raw.trim() === '') return
  const level = parseLogLevel(raw)
  if (level) {
    setLogLevel(level)
    return
  }
  createLogger('runner').warn(`${LOG_LEVEL_VAR}="${raw}" no es un nivel — sigue en info`, {
    'ia.log_level.valid': 'debug, info, warn, error',
  })
}
