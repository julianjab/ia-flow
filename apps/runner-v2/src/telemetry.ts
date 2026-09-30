/**
 * El SDK de OpenTelemetry del runner. Los paquetes (`agent-engine`, los providers) instrumentan
 * sólo contra la API; es la APP la que decide a dónde va. Una sola emisión, dos destinos:
 *
 *   - SIEMPRE, la base de actividad (`traceRecorder` → SQLite): cada span y log de una ejecución,
 *     en el momento — lo que leen la bandeja y el asistente.
 *   - Con `OTEL_EXPORTER_OTLP_ENDPOINT`, además OTLP/HTTP (el Grafana LGTM de `otel/` en local, o
 *     un Collector/Datadog Agent), en lotes de 1 s.
 */
import {
  addLogSink,
  recordExporter,
  type TraceJournal,
  type TraceRecord,
  traceRecorder,
} from '@ia-flow/telemetry'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
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

/** Cada cuánto sale un lote a OTLP: casi en vivo, sin un request por span. */
const EXPORT_DELAY_MS = 1_000

export interface Telemetry {
  /** El trace id de cada evento despachado (spans raíz `event <type>`), en orden. */
  traceIds: string[]
  endpoint?: string
  /**
   * Lo que corrió en un host (`type: remote`) y volvió por el sync: a la bandeja lo anota el
   * `onTrace` de siempre; esto además lo reexporta al collector de ESTE runner, con sus ids
   * originales, así la corrida remota se ve entera en su Grafana. Sin `endpoint`, no hace nada.
   */
  remote(record: TraceRecord): void
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

/** A dónde van los registros de cada ejecución: la base (`--serve`) o el runner que pidió la
 *  corrida (`--host`). Se decide después de arrancar la telemetría, al elegir el modo. */
export class TraceRoute implements TraceJournal {
  private target?: TraceJournal

  to(target: TraceJournal): void {
    this.target = target
  }

  write(record: Parameters<TraceJournal['write']>[0]): void {
    this.target?.write(record)
  }
}

export function startTelemetry(serviceVersion: string, route: TraceRoute): Telemetry {
  const traceIds: string[] = []
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const recorder = traceRecorder(route)
  addLogSink(recorder.logSink)

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'ai-development-flow-runner',
      'service.version': serviceVersion,
      'deployment.environment.name': process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? 'local',
    }),
    spanProcessors: [
      new RootTraceRecorder(traceIds),
      recorder.spanProcessor,
      ...(endpoint
        ? [
            new BatchSpanProcessor(new OTLPTraceExporter(), {
              scheduledDelayMillis: EXPORT_DELAY_MS,
            }),
          ]
        : []),
    ],
    logRecordProcessors: endpoint
      ? [
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter(),
            scheduledDelayMillis: EXPORT_DELAY_MS,
          }),
        ]
      : [],
    // Sin auto-instrumentación (http/undici): los spans que importan los emite el engine, y un
    // span por cada GET a GitHub taparía el árbol.
    instrumentations: [],
  })
  sdk.start()
  const remote = endpoint
    ? recordExporter({
        endpoint,
        resource: {
          serviceName: process.env.OTEL_SERVICE_NAME ?? 'ai-development-flow-runner',
          attributes: {
            'deployment.environment.name': process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? 'local',
          },
        },
        onError: (err) => console.error(`→ telemetría: no se pudo reexportar lo remoto — ${err}`),
      })
    : undefined
  return {
    traceIds,
    ...(endpoint ? { endpoint } : {}),
    remote: (record) => remote?.write(record),
    shutdown: async () => {
      await remote?.flush()
      await sdk.shutdown()
    },
  }
}
