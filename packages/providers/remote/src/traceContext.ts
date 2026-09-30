/**
 * El span del agente cruzando de máquina: el runner lo manda como un W3C `traceparent` en el
 * `RunRequest` y el host corre el provider de allá como su hijo — una sola traza con las dos
 * mitades. Se arma y se lee a mano (el formato es una línea) en vez de con el propagador global de
 * OpenTelemetry: así no depende de qué propagadores registró cada app, y nunca manda baggage.
 */
import {
  type Context,
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  type SpanContext,
  trace,
} from '@opentelemetry/api'

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/** El `traceparent` del span activo, o `undefined` sin uno (sin SDK, todo es no-op). */
export function activeTraceparent(): string | undefined {
  const span = trace.getSpanContext(context.active())
  if (!span || !isSpanContextValid(span)) return undefined
  const flags = (span.traceFlags & 0xff).toString(16).padStart(2, '0')
  return `00-${span.traceId}-${span.spanId}-${flags}`
}

/** Un contexto cuyo padre es el span remoto de `traceparent`; `undefined` si no vino o no es
 *  válido (el provider corre en una traza propia, como antes). */
export function contextFromTraceparent(traceparent: string | undefined): Context | undefined {
  const match = TRACEPARENT.exec(traceparent?.trim().toLowerCase() ?? '')
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  const span: SpanContext = {
    traceId: match[1],
    spanId: match[2],
    traceFlags: Number.parseInt(match[3], 16),
    isRemote: true,
  }
  return isSpanContextValid(span) ? trace.setSpanContext(ROOT_CONTEXT, span) : undefined
}

/** Corre `fn` con `parent` como contexto activo. */
export function runIn<T>(parent: Context, fn: () => T): T {
  return context.with(parent, fn)
}
