/**
 * El contexto de traza de una corrida, llevado a OTRO proceso: el span activo (W3C `traceparent`)
 * y los atributos heredados (`ia.execution.id`, `ia.issue`, `ia.agent.id`, …). Quien lo recibe
 * corre su trabajo adentro, y lo que traza y loguea ahí cuelga del mismo span y lleva los mismos
 * atributos que si hubiera corrido en el proceso que lo mandó — un host remoto se ve igual que el
 * runner.
 */
import { context, TraceFlags, trace } from '@opentelemetry/api'
import { inheritedAttributes, withInheritedAttributes } from './tracing.js'

export interface RemoteTraceContext {
  /** `00-<traceId>-<spanId>-<flags>`. */
  traceparent: string
  /** Sólo los escalares: lo que cruza en JSON sin perder el tipo. */
  attributes: Record<string, string | number | boolean>
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/** El contexto activo, para mandarlo. Sin span activo (válido), `undefined`. */
export function exportTraceContext(): RemoteTraceContext | undefined {
  const span = trace.getActiveSpan()?.spanContext()
  if (!span || !trace.isSpanContextValid(span)) return undefined
  const flags = (span.traceFlags & TraceFlags.SAMPLED).toString(16).padStart(2, '0')
  const attributes: RemoteTraceContext['attributes'] = {}
  for (const [key, value] of Object.entries(inheritedAttributes())) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[key] = value
    }
  }
  return { traceparent: `00-${span.traceId}-${span.spanId}-${flags}`, attributes }
}

/** Corre `fn` colgado del span remoto y con sus atributos heredados. Sin contexto (o uno que no
 *  se entiende), corre tal cual: la traza se pierde, el trabajo no. */
export function withRemoteTraceContext<T>(remote: RemoteTraceContext | undefined, fn: () => T): T {
  const match = remote ? TRACEPARENT.exec(remote.traceparent) : null
  if (!remote || !match) return fn()
  const [, traceId = '', spanId = '', flags = '00'] = match
  const parent = trace.setSpanContext(context.active(), {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16),
    isRemote: true,
  })
  return context.with(parent, () => withInheritedAttributes(remote.attributes, fn))
}
