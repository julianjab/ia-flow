/**
 * `TraceRecord` → OTLP/HTTP JSON (`/v1/traces` y `/v1/logs`), sin el SDK de OpenTelemetry.
 *
 * Para lo que ya se emitió en OTRO proceso y llega acá como datos: el runner recibe los spans y
 * logs de un provider remoto por el sync (`observe`) y los reexporta a su collector, así una
 * corrida remota se ve entera en el Grafana del runner — con sus ids originales, colgada del span
 * del agente — sin que el host tenga que alcanzar nada. El SDK no sirve para esto: crea spans
 * nuevos con ids propios; acá hay que mandar los que ya existen, tal cual.
 */
import type { TraceRecord, TraceValue } from './traceRecord.js'

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } }

interface KeyValue {
  key: string
  value: AnyValue
}

function anyValue(value: TraceValue | string | number | boolean): AnyValue {
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => anyValue(item)) } }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  return { stringValue: value }
}

function attributes(values: Record<string, TraceValue>): KeyValue[] {
  return Object.entries(values).map(([key, value]) => ({ key, value: anyValue(value) }))
}

/** ISO → nanosegundos, como string (OTLP/JSON los manda así: no entran en un double). */
function nanos(iso: string): string {
  return `${BigInt(Date.parse(iso)) * 1_000_000n}`
}

const SEVERITY: Record<NonNullable<TraceRecord['level']>, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
}

const STATUS: Record<NonNullable<TraceRecord['status']>, number> = { unset: 0, ok: 1, error: 2 }

export interface OtlpResource {
  serviceName: string
  /** Van al `resource` de todo lo exportado (ej. `deployment.environment.name`). */
  attributes?: Record<string, TraceValue>
}

/** Un scope por `origin`: en Grafana, qué vino de qué host. */
function byOrigin(records: TraceRecord[]): Map<string, TraceRecord[]> {
  const groups = new Map<string, TraceRecord[]>()
  for (const record of records) {
    const group = groups.get(record.origin) ?? []
    group.push(record)
    groups.set(record.origin, group)
  }
  return groups
}

function resourceOf(resource: OtlpResource, origin: string) {
  return {
    attributes: attributes({
      'service.name': resource.serviceName,
      ...resource.attributes,
      'ia.origin': origin,
    }),
  }
}

/** Los spans TERMINADOS (`phase: 'end'`): el de inicio sólo sirve para verlo en curso. */
export function otlpTraces(records: TraceRecord[], resource: OtlpResource) {
  const spans = records.filter((record) => record.kind === 'span' && record.phase === 'end')
  return {
    resourceSpans: [...byOrigin(spans)].map(([origin, group]) => ({
      resource: resourceOf(resource, origin),
      scopeSpans: [
        {
          scope: { name: 'ia-flow.remote' },
          spans: group.map((record) => ({
            traceId: record.traceId,
            spanId: record.spanId,
            ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
            name: record.name,
            kind: 1,
            startTimeUnixNano: nanos(record.startTime),
            endTimeUnixNano: nanos(record.endTime ?? record.startTime),
            attributes: attributes(record.attributes),
            status: {
              code: STATUS[record.status ?? 'unset'],
              ...(record.statusMessage ? { message: record.statusMessage } : {}),
            },
          })),
        },
      ],
    })),
  }
}

export function otlpLogs(records: TraceRecord[], resource: OtlpResource) {
  const logs = records.filter((record) => record.kind === 'log')
  return {
    resourceLogs: [...byOrigin(logs)].map(([origin, group]) => ({
      resource: resourceOf(resource, origin),
      scopeLogs: [
        {
          scope: { name: 'ia-flow.remote' },
          logRecords: group.map((record) => ({
            timeUnixNano: nanos(record.startTime),
            severityNumber: SEVERITY[record.level ?? 'info'],
            severityText: (record.level ?? 'info').toUpperCase(),
            body: { stringValue: record.name },
            attributes: attributes({
              ...record.attributes,
              ...(record.scope ? { 'otel.scope.name': record.scope } : {}),
            }),
            traceId: record.traceId,
            spanId: record.spanId,
          })),
        },
      ],
    })),
  }
}

export interface RecordExporterOptions {
  /** El collector OTLP/HTTP, sin el path (`http://localhost:4318`). */
  endpoint: string
  resource: OtlpResource
  /** Cada cuánto se manda lo juntado. Default: 1000 ms. */
  flushMs?: number
  fetchImpl?: typeof fetch
  /** Un envío que falló (el collector caído): no corta nada, sólo se avisa. */
  onError?: (err: unknown) => void
}

export interface RecordExporter {
  write(record: TraceRecord): void
  /** Manda lo pendiente ya (al apagar). */
  flush(): Promise<void>
}

/** Junta `TraceRecord` y los manda en lotes a `/v1/traces` y `/v1/logs`. `write` nunca tira. */
export function recordExporter(options: RecordExporterOptions): RecordExporter {
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.endpoint.replace(/\/+$/, '')
  let pending: TraceRecord[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const post = async (path: string, body: unknown) => {
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`OTLP ${path}: HTTP ${response.status}`)
  }

  const flush = async () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const batch = pending
    pending = []
    if (batch.length === 0) return
    const traces = otlpTraces(batch, options.resource)
    const logs = otlpLogs(batch, options.resource)
    const sends = [
      ...(traces.resourceSpans.length > 0 ? [post('/v1/traces', traces)] : []),
      ...(logs.resourceLogs.length > 0 ? [post('/v1/logs', logs)] : []),
    ]
    for (const result of await Promise.allSettled(sends)) {
      if (result.status === 'rejected') options.onError?.(result.reason)
    }
  }

  return {
    write(record) {
      pending.push(record)
      if (timer) return
      timer = setTimeout(() => void flush(), options.flushMs ?? 1000)
      ;(timer as { unref?: () => void }).unref?.()
    },
    flush,
  }
}
