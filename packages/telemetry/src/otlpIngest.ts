/**
 * OTLP/HTTP JSON → `TraceRecord`: lo inverso de `otlpRecords.ts`. Para lo que otro proceso exportó
 * con el SDK estándar (un host remoto, con su `OTLPTraceExporter`/`OTLPLogExporter` apuntando al
 * runner) y que el runner quiere anotar en su propia base, igual que lo suyo.
 *
 * Sólo entra lo que pertenece a una ejecución (`ia.execution.id` propio o, en un span, el de un
 * padre del mismo lote), como en `traceRecorder`. El `origin` sale del resource: `ia.origin`, o
 * `service.instance.id`, o `service.name`.
 */
import type { TraceRecord, TraceValue } from './traceRecord.js'
import { EXECUTION_ATTRIBUTE } from './traceRecorder.js'
import { truncate } from './tracing.js'

type AnyValue = {
  stringValue?: string
  intValue?: string | number
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values?: AnyValue[] }
}
type KeyValue = { key?: string; value?: AnyValue }

interface OtlpSpan {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  name?: string
  startTimeUnixNano?: string | number
  endTimeUnixNano?: string | number
  attributes?: KeyValue[]
  status?: { code?: number; message?: string }
}

interface OtlpLog {
  timeUnixNano?: string | number
  observedTimeUnixNano?: string | number
  severityNumber?: number
  body?: AnyValue
  attributes?: KeyValue[]
  traceId?: string
  spanId?: string
}

interface Resource {
  attributes?: KeyValue[]
}

export interface OtlpTracesPayload {
  resourceSpans?: Array<{
    resource?: Resource
    scopeSpans?: Array<{ scope?: { name?: string }; spans?: OtlpSpan[] }>
  }>
}

export interface OtlpLogsPayload {
  resourceLogs?: Array<{
    resource?: Resource
    scopeLogs?: Array<{ scope?: { name?: string }; logRecords?: OtlpLog[] }>
  }>
}

const DEFAULT_MAX_STRING = 10_240
const STATUS = ['unset', 'ok', 'error'] as const

function scalar(value: AnyValue | undefined): string | number | boolean | undefined {
  if (!value) return undefined
  if (value.stringValue !== undefined) return value.stringValue
  if (value.intValue !== undefined) return Number(value.intValue)
  if (value.doubleValue !== undefined) return value.doubleValue
  if (value.boolValue !== undefined) return value.boolValue
  return undefined
}

function traceValue(value: AnyValue | undefined, maxString: number): TraceValue | undefined {
  const values = value?.arrayValue?.values
  if (values) {
    const items = values.map(scalar).filter((item) => item !== undefined)
    return items.map((item) => (typeof item === 'string' ? truncate(item, maxString) : item)) as
      | string[]
      | number[]
      | boolean[]
  }
  const single = scalar(value)
  return typeof single === 'string' ? truncate(single, maxString) : single
}

function attributesOf(list: KeyValue[] | undefined, maxString: number): Record<string, TraceValue> {
  const out: Record<string, TraceValue> = {}
  for (const { key, value } of list ?? []) {
    const decoded = traceValue(value, maxString)
    if (key && decoded !== undefined) out[key] = decoded
  }
  return out
}

function originOf(resource: Resource | undefined): string {
  const attributes = attributesOf(resource?.attributes, DEFAULT_MAX_STRING)
  const origin =
    attributes['ia.origin'] ?? attributes['service.instance.id'] ?? attributes['service.name']
  return typeof origin === 'string' && origin ? origin : 'remote'
}

/** Nanosegundos (string o number) → ISO. */
function iso(nanos: string | number | undefined): string {
  if (nanos === undefined || nanos === '' || nanos === '0' || nanos === 0) {
    return new Date(0).toISOString()
  }
  return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString()
}

function levelOf(severity: number | undefined): NonNullable<TraceRecord['level']> {
  if (severity === undefined || severity === 0) return 'info'
  if (severity <= 8) return 'debug'
  if (severity <= 12) return 'info'
  if (severity <= 16) return 'warn'
  return 'error'
}

function executionOf(attributes: Record<string, TraceValue>): string | undefined {
  const id = attributes[EXECUTION_ATTRIBUTE]
  return typeof id === 'string' && id ? id : undefined
}

type Decoded<T> = { item: T; origin: string; attributes: Record<string, TraceValue> }

function spanRecord(
  { item: span, origin, attributes }: Decoded<OtlpSpan>,
  executionId: string,
): TraceRecord | undefined {
  if (!span.traceId || !span.spanId) return undefined
  const startTime = iso(span.startTimeUnixNano)
  const endTime = iso(span.endTimeUnixNano ?? span.startTimeUnixNano)
  return {
    kind: 'span',
    phase: 'end',
    name: span.name ?? '',
    status: STATUS[span.status?.code ?? 0] ?? 'unset',
    ...(span.status?.message ? { statusMessage: span.status.message } : {}),
    startTime,
    endTime,
    durationMs: Date.parse(endTime) - Date.parse(startTime),
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    executionId,
    origin,
    attributes,
  }
}

function logRecord(
  { item: log, origin, attributes }: Decoded<OtlpLog>,
  scope: string | undefined,
  executionId: string,
  maxString: number,
): TraceRecord {
  const body = scalar(log.body)
  const time = Number(log.timeUnixNano ?? 0) > 0 ? log.timeUnixNano : log.observedTimeUnixNano
  return {
    kind: 'log',
    name: truncate(body === undefined ? '' : String(body), maxString),
    ...(scope ? { scope } : {}),
    level: levelOf(log.severityNumber),
    startTime: iso(time),
    traceId: log.traceId ?? '',
    spanId: log.spanId ?? '',
    executionId,
    origin,
    attributes,
  }
}

/** Los spans de un `/v1/traces`, terminados (el SDK sólo exporta al cerrar). */
export function recordsFromOtlpTraces(
  payload: OtlpTracesPayload,
  maxString = DEFAULT_MAX_STRING,
): TraceRecord[] {
  const spans: Decoded<OtlpSpan>[] = (payload.resourceSpans ?? []).flatMap((resourceSpan) => {
    const origin = originOf(resourceSpan.resource)
    return (resourceSpan.scopeSpans ?? []).flatMap((scopeSpan) =>
      (scopeSpan.spans ?? []).map((span) => ({
        item: span,
        origin,
        attributes: attributesOf(span.attributes, maxString),
      })),
    )
  })
  // Un hijo sin `ia.execution.id` toma el de su padre, si vino en el mismo lote.
  const executions = new Map<string, string>()
  for (const { item, attributes } of spans) {
    const id = executionOf(attributes)
    if (id && item.spanId) executions.set(item.spanId, id)
  }
  return spans.flatMap((decoded) => {
    const parent = decoded.item.parentSpanId
    const executionId =
      executionOf(decoded.attributes) ?? (parent ? executions.get(parent) : undefined)
    const record = executionId ? spanRecord(decoded, executionId) : undefined
    return record ? [record] : []
  })
}

/** Los logs de un `/v1/logs`: el `scope` es el del logger (`createLogger('scope')`). */
export function recordsFromOtlpLogs(
  payload: OtlpLogsPayload,
  maxString = DEFAULT_MAX_STRING,
): TraceRecord[] {
  return (payload.resourceLogs ?? []).flatMap((resourceLog) => {
    const origin = originOf(resourceLog.resource)
    return (resourceLog.scopeLogs ?? []).flatMap((scopeLog) =>
      (scopeLog.logRecords ?? []).flatMap((log) => {
        const attributes = attributesOf(log.attributes, maxString)
        const executionId = executionOf(attributes)
        if (!executionId) return []
        const decoded = { item: log, origin, attributes }
        return [logRecord(decoded, scopeLog.scope?.name, executionId, maxString)]
      }),
    )
  })
}
