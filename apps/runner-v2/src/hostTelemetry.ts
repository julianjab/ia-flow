/**
 * La telemetría de los hosts, del lado del runner: lo que un host exporta con el SDK estándar
 * (OTLP/HTTP JSON a `/v1/hosts/telemetry/*`, ver `@ia-flow/provider-remote`) se trata como propio.
 *
 *   - Lo que es de una ejecución va a la base de actividad (`journal`), como los spans y logs del
 *     runner: la bandeja y el asistente lo ven con su `origin` (el nombre del host).
 *   - TODO se reexporta tal cual al collector del runner (`OTEL_EXPORTER_OTLP_ENDPOINT`), con los
 *     headers de `OTEL_EXPORTER_OTLP_HEADERS`: el host no necesita alcanzar el collector ni tener
 *     sus credenciales.
 */
import type { TelemetrySignal } from '@ia-flow/provider-remote'
import {
  createLogger,
  type OtlpLogsPayload,
  type OtlpTracesPayload,
  recordsFromOtlpLogs,
  recordsFromOtlpTraces,
  type TraceJournal,
} from '@ia-flow/telemetry'

const log = createLogger('runner.host-telemetry')

export interface HostTelemetryOptions {
  /** El collector del runner, sin el path (`http://localhost:4318`). Sin él, no se reexporta. */
  endpoint?: string
  /** `OTEL_EXPORTER_OTLP_HEADERS`: `clave=valor,clave2=valor2`. */
  headers?: string
  fetchImpl?: typeof fetch
}

/** `clave=valor,clave2=valor2` (valores url-encoded, como lo define OpenTelemetry). */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    headers[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim())
  }
  return headers
}

/** El `onTelemetry` del hub: anota y reexporta. Un collector caído no corta nada: se avisa. */
export function hostTelemetryIngest(
  journal: TraceJournal,
  options: HostTelemetryOptions = {},
): (signal: TelemetrySignal, payload: unknown) => Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.endpoint?.replace(/\/+$/, '')
  const headers = parseOtlpHeaders(options.headers)
  return async (signal, payload) => {
    const records =
      signal === 'traces'
        ? recordsFromOtlpTraces(payload as OtlpTracesPayload)
        : recordsFromOtlpLogs(payload as OtlpLogsPayload)
    for (const record of records) journal.write(record)
    if (!base) return
    try {
      const res = await fetchImpl(`${base}/v1/${signal}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) log.warn(`reexportar ${signal} de un host: HTTP ${res.status}`)
    } catch (error) {
      log.warn(`reexportar ${signal} de un host: ${(error as Error).message}`)
    }
  }
}
