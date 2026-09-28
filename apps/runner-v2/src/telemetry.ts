/**
 * El SDK de OpenTelemetry del runner. Los paquetes (`agent-pipeline`, `provider-anthropic`)
 * instrumentan sólo contra la API; es la APP la que decide si exporta y a dónde. Acá: OTLP/HTTP
 * al endpoint de `OTEL_EXPORTER_OTLP_ENDPOINT` — el Grafana LGTM de `examples/apps/otel` en local,
 * o un Collector/Datadog Agent en otro lado, sin cambiar código.
 *
 * Sin `OTEL_EXPORTER_OTLP_ENDPOINT` no se registra nada y toda la instrumentación queda en no-op.
 */
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

export function startTelemetry(serviceVersion: string): Telemetry {
  const traceIds: string[] = []
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) return { traceIds, shutdown: async () => {} }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'ai-development-flow-runner',
      'service.version': serviceVersion,
      'deployment.environment.name': process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? 'local',
    }),
    spanProcessors: [
      new RootTraceRecorder(traceIds),
      new BatchSpanProcessor(new OTLPTraceExporter()),
    ],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    // Sin auto-instrumentación (http/undici): los spans que importan los emite el engine, y un
    // span por cada GET a GitHub taparía el árbol.
    instrumentations: [],
  })
  sdk.start()
  return { traceIds, endpoint, shutdown: () => sdk.shutdown() }
}
